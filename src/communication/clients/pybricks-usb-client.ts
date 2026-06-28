import { WebUSB } from 'usb';
import { InEndpoint } from 'usb/dist/usb/endpoint';

import { DeviceMetadata } from '..';
import Config, { FeatureFlags } from '../../extension/config';
import { RefreshTree } from '../../extension/tree-commands';
import { setState, StateProp } from '../../logic/state';
import { AppDataInstrumentationPybricksProtocol } from '../../pybricks/appdata-instrumentation-protocol';
import {
    deviceNameUUID,
    firmwareRevisionStringUUID,
    softwareRevisionStringUUID,
} from '../../pybricks/ble-device-info-service/protocol';
import {
    BuiltinProgramId,
    createStartUserProgramCommand,
    createStopUserProgramCommand,
    createWriteAppDataCommand,
    createWriteStdinCommand,
    createWriteUserProgramMetaCommand,
    createWriteUserRamCommand,
    EventType,
    getEventType,
    parseStatusReport,
    pybricksHubCapabilitiesCharacteristicUUID,
    Status,
    statusToFlag,
} from '../../pybricks/ble-pybricks-service/protocol';
import {
    LEGO_USB_VENDOR_ID,
    legoUsbProductLabel,
    pybricksUsbClass,
    PybricksUsbInEndpointMessageType,
    PybricksUsbInterfaceRequest,
    PybricksUsbOutEndpointMessageType,
    pybricksUsbProtocol,
    pybricksUsbRequestMaxLength,
    pybricksUsbSubclass,
    uuid16FromGattString,
} from '../../pybricks/usb-pybricks-service/constants';
import { sleep } from '../../utils';
import { BackpressureQueue } from '../../utils/backpressure-queue';
import { BaseLayer, LayerKind } from '../layers/base-layer';
import { DeviceMetadataForPybricksUSB } from '../layers/usb-layer';
import {
    BaseClient,
    ClientClassDescriptor,
    DeviceOSType,
    StartMode,
} from './base-client';

const USB_RESPONSE_TIMEOUT_MS = 1000;
const USB_OPEN_RETRY_ATTEMPTS = 5;
const USB_BULK_IN_MAX_CHUNKS = 128;
const USB_CLOSE_TIMEOUT_MS = 4000;

interface Capabilities {
    maxWriteSize: number;
    flags: number;
    maxUserProgramSize: number;
}

export class PybricksUsbClient extends BaseClient {
    public static override readonly classDescriptor: ClientClassDescriptor = {
        os: DeviceOSType.Pybricks,
        layer: LayerKind.USB,
        deviceType: 'pybricks-usb',
        description: 'Pybricks on USB',
        supportsModularMpy: true,
        requiresSlot: false,
    };

    private _usbDevice: USBDevice | undefined;
    private _inEndpoint: InEndpoint | undefined;
    private _ifaceNumber = 0;
    private _inEndpointNumber = 0;
    private _outEndpointNumber = 0;
    private _packetSize = 64;
    private _capabilities: Capabilities | undefined;
    private _receiveAbort = false;
    private _receiveLoopDone: Promise<void> = Promise.resolve();
    private _commandGate: Promise<void> = Promise.resolve();
    private _responseWaiter: {
        resolve: (code: number) => void;
        reject: (e: Error) => void;
    } | null = null;

    private _incomingAppDataQueue: BackpressureQueue<Buffer>;
    private _stdoutByteBuffer = new Uint8Array(0);

    public override get metadata(): DeviceMetadataForPybricksUSB {
        return this._metadata as DeviceMetadataForPybricksUSB;
    }

    public get connected(): boolean {
        return !!this._usbDevice?.opened;
    }

    public get descriptionKVP(): [string, string][] {
        const kvp: [string, string][] = [];
        kvp.push(['type', this.classDescriptor.description]);
        return kvp;
    }

    constructor(metadata: DeviceMetadataForPybricksUSB, parent: BaseLayer) {
        super(metadata, parent);
        this._incomingAppDataQueue = new BackpressureQueue<Buffer>(
            async (data: Buffer) => this.handleIncomingAppData(data),
            { name: 'PybricksUsbAppData' },
        );
    }

    // -------------------------------------------------------------------------
    // Low-level USB transfer helpers
    // -------------------------------------------------------------------------

    /** Read hub name via a quick open/control-transfer/close, for use during scanning. */
    public static async refreshDeviceName(
        usbDevice: USBDevice,
        metadata: DeviceMetadataForPybricksUSB,
    ): Promise<void> {
        try {
            await usbDevice.open();
            await usbDevice.selectConfiguration(1);

            // Find and claim the Pybricks interface
            const cfg = usbDevice.configuration;
            if (!cfg) return;
            let ifaceNumber: number | undefined;
            for (const iface of cfg.interfaces) {
                const alt = iface.alternates.find(
                    (a) =>
                        a.interfaceClass === pybricksUsbClass &&
                        a.interfaceSubclass === pybricksUsbSubclass &&
                        a.interfaceProtocol === pybricksUsbProtocol,
                );
                if (alt) { ifaceNumber = iface.interfaceNumber; break; }
            }
            if (ifaceNumber === undefined) return;

            await usbDevice.claimInterface(ifaceNumber);
            try {
                const result = await usbDevice.controlTransferIn(
                    {
                        requestType: 'class',
                        recipient: 'interface',
                        request: PybricksUsbInterfaceRequest.Gatt,
                        value: deviceNameUUID,
                        index: 0x00,
                    },
                    pybricksUsbRequestMaxLength,
                );
                if (result.status === 'ok' && result.data) {
                    const name = new TextDecoder()
                        .decode(new Uint8Array(result.data.buffer, result.data.byteOffset, result.data.byteLength))
                        .replace(/\0/g, '')
                        .trim();
                    if (name) metadata.name = name;
                }
            } finally {
                await usbDevice.releaseInterface(ifaceNumber).catch(() => { /* ignore */ });
            }
        } finally {
            await usbDevice.close().catch(() => { /* ignore */ });
        }
    }

    private async openWithRetries(device: USBDevice): Promise<void> {
        for (let retry = 1; ; retry++) {
            try {
                await device.open();
                return;
            } catch (e) {
                const err = e instanceof Error ? e : new Error(String(e));
                if (err.name === 'SecurityError' && retry < USB_OPEN_RETRY_ATTEMPTS) {
                    await sleep(100);
                    continue;
                }
                throw err;
            }
        }
    }

    private waitResponse(): Promise<number> {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                if (this._responseWaiter) {
                    this._responseWaiter = null;
                    reject(new Error('USB Pybricks command response timed out'));
                }
            }, USB_RESPONSE_TIMEOUT_MS);

            this._responseWaiter = {
                resolve: (code: number) => {
                    clearTimeout(timer);
                    this._responseWaiter = null;
                    resolve(code);
                },
                reject: (err: Error) => {
                    clearTimeout(timer);
                    this._responseWaiter = null;
                    reject(err);
                },
            };
        });
    }

    /** Wraps a Pybricks command payload in the OUT endpoint framing and awaits the response. */
    private async transferPybricksPayload(payload: Uint8Array): Promise<void> {
        const dev = this._usbDevice;
        if (!dev) throw new Error('USB device not open');

        const msg = new Uint8Array(1 + payload.length);
        msg[0] = PybricksUsbOutEndpointMessageType.Command;
        msg.set(payload, 1);

        const prev = this._commandGate;
        let openGate!: () => void;
        this._commandGate = new Promise<void>((r) => {
            openGate = r;
        });
        await prev;

        try {
            const responsePromise = this.waitResponse();
            const out = await dev.transferOut(this._outEndpointNumber, msg);
            if (out.status !== 'ok') {
                if (this._responseWaiter) {
                    this._responseWaiter.reject(
                        new Error(`USB transferOut failed: ${String(out.status)}`),
                    );
                    this._responseWaiter = null;
                }
                throw new Error(`USB transferOut failed: ${String(out.status)}`);
            }
            const statusCode = await responsePromise;
            if (statusCode !== 0) {
                throw new Error(`USB Pybricks command failed (status ${statusCode})`);
            }
        } finally {
            openGate();
        }
    }

    /** Sends Subscribe OUT message and awaits the Response, synchronising the event subscription. */
    private async transferSubscribeAndWait(enable: boolean): Promise<void> {
        const dev = this._usbDevice;
        if (!dev) throw new Error('USB device not open');

        const msg = new Uint8Array(2);
        msg[0] = PybricksUsbOutEndpointMessageType.Subscribe;
        msg[1] = enable ? 1 : 0;

        const prev = this._commandGate;
        let openGate!: () => void;
        this._commandGate = new Promise<void>((r) => {
            openGate = r;
        });
        await prev;

        try {
            const responsePromise = this.waitResponse();
            const out = await dev.transferOut(this._outEndpointNumber, msg);
            if (out.status !== 'ok') {
                if (this._responseWaiter) {
                    this._responseWaiter.reject(
                        new Error(
                            `USB subscribe transferOut failed: ${String(out.status)}`,
                        ),
                    );
                    this._responseWaiter = null;
                }
                throw new Error(
                    `USB subscribe transferOut failed: ${String(out.status)}`,
                );
            }
            const statusCode = await responsePromise;
            if (statusCode !== 0) {
                throw new Error(`USB Pybricks subscribe failed (status ${statusCode})`);
            }
        } finally {
            openGate();
        }
    }

    /** Reads one logical bulk IN message: MPS-sized packets until a short packet or ZLP. */
    private async readOneBulkInMessage(): Promise<Uint8Array | null> {
        const mps = Math.max(1, this._packetSize);
        const chunks: Uint8Array[] = [];

        for (let n = 0; n < USB_BULK_IN_MAX_CHUNKS; n++) {
            if (this._receiveAbort || !this._inEndpoint) return null;

            const chunk = await new Promise<Buffer | null>((resolve) => {
                this._pendingRead = resolve;
            });
            this._pendingRead = undefined;

            if (chunk === null) return null;

            const len = chunk.length;
            if (len === 0) break;

            chunks.push(new Uint8Array(chunk));
            if (len < mps) break;
        }

        if (chunks.length === 0) return null;

        const total = chunks.reduce((s, c) => s + c.length, 0);
        const merged = new Uint8Array(total);
        let offset = 0;
        for (const c of chunks) {
            merged.set(c, offset);
            offset += c.length;
        }
        return merged;
    }

    private _pendingRead: ((data: Buffer | null) => void) | undefined;

    /** Start polling the raw IN endpoint so stopPoll() can cancel pending transfers on disconnect. */
    private startPollEndpoint(): void {
        const ep = this._inEndpoint;
        if (!ep) return;

        ep.on('data', (data: Buffer) => {
            if (this._pendingRead) {
                const cb = this._pendingRead;
                this._pendingRead = undefined;
                cb(data);
            }
        });

        ep.on('error', (_err: Error) => {
            if (this._pendingRead) {
                const cb = this._pendingRead;
                this._pendingRead = undefined;
                cb(null);
            }
        });

        ep.on('end', () => {
            if (this._pendingRead) {
                const cb = this._pendingRead;
                this._pendingRead = undefined;
                cb(null);
            }
        });

        ep.startPoll(1, this._packetSize);
    }

    /** Stop polling and drain any pending read promise so receiveLoop() unblocks. */
    private stopPollEndpoint(): void {
        const ep = this._inEndpoint;
        if (!ep) return;

        if (this._pendingRead) {
            const cb = this._pendingRead;
            this._pendingRead = undefined;
            cb(null);
        }

        try {
            ep.stopPoll();
        } catch {
            // ignore if already stopped
        }

        ep.removeAllListeners('data');
        ep.removeAllListeners('error');
        ep.removeAllListeners('end');
    }

    // -------------------------------------------------------------------------
    // Stdout byte-level buffering (UTF-8 safe, per-line flush)
    // -------------------------------------------------------------------------

    private appendStdoutBytes(chunk: Uint8Array): void {
        if (chunk.length === 0) return;
        const prev = this._stdoutByteBuffer;
        const merged = new Uint8Array(prev.length + chunk.length);
        merged.set(prev, 0);
        merged.set(chunk, prev.length);
        this._stdoutByteBuffer = merged;
        void this.flushStdoutCompleteLines();
    }

    private async flushStdoutCompleteLines(): Promise<void> {
        const b = this._stdoutByteBuffer;
        const dec = new TextDecoder('utf-8', { fatal: false });
        let lineStart = 0;
        let i = 0;
        while (i < b.length) {
            if (b[i] === 0x0a || b[i] === 0x0d) {
                const slice = b.subarray(lineStart, i);
                if (slice.length > 0) {
                    await this.handleWriteStdout(dec.decode(slice));
                }
                i += b[i] === 0x0d && i + 1 < b.length && b[i + 1] === 0x0a ? 2 : 1;
                lineStart = i;
            } else {
                i++;
            }
        }
        this._stdoutByteBuffer =
            lineStart > 0 && lineStart < b.length
                ? Uint8Array.from(b.subarray(lineStart))
                : lineStart >= b.length
                  ? new Uint8Array(0)
                  : b;
    }

    private async flushStdoutPartialTail(): Promise<void> {
        const b = this._stdoutByteBuffer;
        if (b.length === 0) return;
        const line = new TextDecoder('utf-8', { fatal: false }).decode(b).trim();
        if (line.length > 0) await this.handleWriteStdout(line);
        this._stdoutByteBuffer = new Uint8Array(0);
    }

    // -------------------------------------------------------------------------
    // Receive loop and event dispatch
    // -------------------------------------------------------------------------

    private async receiveLoop(): Promise<void> {
        while (!this._receiveAbort) {
            try {
                const packet = await this.readOneBulkInMessage();
                if (packet === null) break; // null = endpoint dead or aborted
                if (packet.length < 1) continue;

                const kind = packet[0];
                if (kind === PybricksUsbInEndpointMessageType.Response) {
                    if (packet.length >= 5 && this._responseWaiter) {
                        const statusCode = new DataView(
                            packet.buffer,
                            packet.byteOffset,
                            packet.byteLength,
                        ).getUint32(1, true);
                        this._responseWaiter.resolve(statusCode);
                    }
                } else if (kind === PybricksUsbInEndpointMessageType.Event) {
                    const inner = packet.subarray(1);
                    if (inner.byteLength > 0) {
                        const dv = new DataView(
                            inner.buffer,
                            inner.byteOffset,
                            inner.byteLength,
                        );
                        await this.handleIncomingData(Buffer.from(inner));
                        void dv; // handleIncomingData takes Buffer, conversion above is sufficient
                    }
                }
            } catch {
                if (!this._receiveAbort) {
                    console.warn('[PybricksUsbClient] receive loop ended unexpectedly');
                }
                break;
            }
        }
    }

    protected async handleIncomingData(data: Buffer): Promise<void> {
        const dataView = new DataView(data.buffer, data.byteOffset, data.byteLength);
        const eventType = getEventType(dataView);

        switch (eventType) {
            case EventType.StatusReport: {
                const status = parseStatusReport(dataView);
                const running =
                    (status.flags & statusToFlag(Status.UserProgramRunning)) !== 0;
                if (running) {
                    this._slot = status.runningProgId;
                } else {
                    this._slot = status.selectedSlot;
                    await this.flushStdoutPartialTail();
                }
                setState(StateProp.Running, running);
                break;
            }
            case EventType.WriteStdout: {
                setState(StateProp.Running, true);
                const payload = new Uint8Array(
                    data.buffer,
                    data.byteOffset + 1,
                    data.byteLength - 1,
                );
                this.appendStdoutBytes(payload);
                break;
            }
            case EventType.WriteAppData:
                await this._incomingAppDataQueue.push(
                    Buffer.from(data.buffer.slice(1)),
                );
                break;
            default:
                console.warn('[PybricksUsbClient] unknown event type:', eventType);
                break;
        }
    }

    private async handleIncomingAppData(data: Buffer): Promise<void> {
        if (
            Config.FeatureFlag.get(
                FeatureFlags.PybricksUseApplicationInterfaceForPybricksProtocol,
            )
        ) {
            await AppDataInstrumentationPybricksProtocol.decode(data);
        }
    }

    // -------------------------------------------------------------------------
    // BaseClient lifecycle
    // -------------------------------------------------------------------------

    protected async write(data: Uint8Array): Promise<void> {
        await this.transferPybricksPayload(data);
    }

    protected async connectWorker(
        _onDeviceUpdated: (device: DeviceMetadata) => void,
        onDeviceRemoved: (device: DeviceMetadata) => void,
    ): Promise<void> {
        const metadata = this.metadata;
        if (!metadata) throw new Error('No metadata');

        // Obtain the live USBDevice from the usb package's WebUSB wrapper.
        // allowAllDevices: true skips the browser permission dialog (N/A in Node.js).
        const webusb = new WebUSB({ allowAllDevices: true });
        const devices = await webusb.getDevices();
        const usbDevice = devices.find(
            (d) =>
                d.vendorId === LEGO_USB_VENDOR_ID &&
                d.productId === metadata.productId &&
                d.serialNumber === metadata.serialNumber,
        );
        if (!usbDevice) {
            throw new Error(
                `Pybricks USB device ${legoUsbProductLabel(metadata.productId)} not found (was it unplugged?)`,
            );
        }

        this._usbDevice = usbDevice;
        this._receiveAbort = false;
        this._commandGate = Promise.resolve();

        await this.openWithRetries(usbDevice);
        await usbDevice.selectConfiguration(1);

        const cfg = usbDevice.configuration;
        if (!cfg) throw new Error('USB configuration missing');

        let ifaceNumber: number | undefined;
        let inEpNum: number | undefined;
        let outEpNum: number | undefined;
        let packetSize = 64;

        for (const iface of cfg.interfaces) {
            const alt = iface.alternates.find(
                (a) =>
                    a.interfaceClass === pybricksUsbClass &&
                    a.interfaceSubclass === pybricksUsbSubclass &&
                    a.interfaceProtocol === pybricksUsbProtocol,
            );
            if (alt) {
                ifaceNumber = iface.interfaceNumber;
                const inEp = alt.endpoints.find(
                    (e) => e.direction === 'in' && e.type === 'bulk',
                );
                const outEp = alt.endpoints.find(
                    (e) => e.direction === 'out' && e.type === 'bulk',
                );
                if (!inEp || !outEp)
                    throw new Error('Pybricks USB bulk endpoints missing');
                inEpNum = inEp.endpointNumber;
                outEpNum = outEp.endpointNumber;
                packetSize = inEp.packetSize;
                break;
            }
        }
        if (
            ifaceNumber === undefined ||
            inEpNum === undefined ||
            outEpNum === undefined
        ) {
            throw new Error(
                'No Pybricks USB interface (ff:c5:f5) found on this device',
            );
        }

        this._ifaceNumber = ifaceNumber;
        this._inEndpointNumber = inEpNum;
        this._outEndpointNumber = outEpNum;
        this._packetSize = packetSize;

        await usbDevice.claimInterface(this._ifaceNumber);

        // Get the raw InEndpoint for startPoll/stopPoll — the only way to cancel a
        // pending transferIn without getting "Can't close device with a pending request".
        // WebUSBDevice wraps usb.Device; reach through to the underlying device object.
        const rawDevice = (
            usbDevice as unknown as {
                device: { interface(n: number): { endpoint(addr: number): unknown } };
            }
        ).device;
        const inEpAddr = this._inEndpointNumber | 0x80; // IN direction bit
        const rawEndpoint = rawDevice.interface(this._ifaceNumber).endpoint(inEpAddr);
        if (!(rawEndpoint instanceof InEndpoint)) {
            throw new Error('Pybricks USB IN endpoint not found on raw device');
        }
        this._inEndpoint = rawEndpoint;

        // Read device name via GATT control transfer
        const nameResult = await usbDevice.controlTransferIn(
            {
                requestType: 'class',
                recipient: 'interface',
                request: PybricksUsbInterfaceRequest.Gatt,
                value: deviceNameUUID,
                index: 0x00,
            },
            pybricksUsbRequestMaxLength,
        );
        if (nameResult.status === 'ok' && nameResult.data) {
            const dec = new TextDecoder();
            const resolved = dec
                .decode(
                    new Uint8Array(
                        nameResult.data.buffer,
                        nameResult.data.byteOffset,
                        nameResult.data.byteLength,
                    ),
                )
                .replace(/\0/g, '')
                .trim();
            if (resolved) metadata.name = resolved;
        }

        // Read firmware and software revision strings
        const [fwResult, swResult] = await Promise.all([
            usbDevice.controlTransferIn(
                {
                    requestType: 'class',
                    recipient: 'interface',
                    request: PybricksUsbInterfaceRequest.Gatt,
                    value: firmwareRevisionStringUUID,
                    index: 0x00,
                },
                pybricksUsbRequestMaxLength,
            ),
            usbDevice.controlTransferIn(
                {
                    requestType: 'class',
                    recipient: 'interface',
                    request: PybricksUsbInterfaceRequest.Gatt,
                    value: softwareRevisionStringUUID,
                    index: 0x00,
                },
                pybricksUsbRequestMaxLength,
            ),
        ]);

        // Read hub capabilities
        const capResult = await usbDevice.controlTransferIn(
            {
                requestType: 'class',
                recipient: 'interface',
                request: PybricksUsbInterfaceRequest.Pybricks,
                value: uuid16FromGattString(pybricksHubCapabilitiesCharacteristicUUID),
                index: 0x00,
            },
            pybricksUsbRequestMaxLength,
        );

        if (capResult.status === 'ok' && capResult.data) {
            const caps = capResult.data;
            this._capabilities = {
                maxWriteSize: caps.getUint16(0, true) || 20,
                flags: caps.getUint32(2, true),
                maxUserProgramSize: caps.getUint32(6, true) || 20,
            };
        } else {
            // Fallback safe defaults
            this._capabilities = {
                maxWriteSize: 20,
                flags: 0,
                maxUserProgramSize: 20 * 1024,
            };
        }

        // Log version info to debug
        const dec = new TextDecoder();
        const decodeCtrl = (r: USBInTransferResult) =>
            r.status === 'ok' && r.data
                ? dec
                      .decode(
                          new Uint8Array(
                              r.data.buffer,
                              r.data.byteOffset,
                              r.data.byteLength,
                          ),
                      )
                      .replace(/\0/g, '')
                      .trim()
                : 'unknown';
        console.debug(
            `[PybricksUsbClient] fw=${decodeCtrl(fwResult)} sw=${decodeCtrl(swResult)}`,
        );

        this._exitStack.push(() => {
            this.parent.allDevices.delete(metadata.id);
            metadata.validTill = 0;
            if (onDeviceRemoved) onDeviceRemoved(metadata);
            RefreshTree(true);
        });

        // Physical unplug: the receive loop will throw when the device is gone,
        // which breaks the loop. Trigger a soft disconnect so the UI updates.
        this._receiveLoopDone = this.receiveLoop().then(() => {
            if (this._usbDevice === undefined) return; // already in disconnectWorker
            void this.handleDisconnectAsync(metadata.id);
        });

        // Start polling the raw IN endpoint (cancellable via stopPoll on disconnect)
        this.startPollEndpoint();

        // Subscribe to events - must complete before commands can flow
        await this.transferSubscribeAndWait(true);
    }

    protected override async disconnectWorker(): Promise<void> {
        // Unsubscribe while the receive loop is still running so the hub gets
        // the signal and turns off its connected LED.
        try {
            await this.transferSubscribeAndWait(false);
        } catch {
            // ignore — device may already be gone
        }

        this._receiveAbort = true;

        if (this._responseWaiter) {
            this._responseWaiter.reject(new Error('USB disconnected'));
            this._responseWaiter = null;
        }

        const dev = this._usbDevice;
        this._usbDevice = undefined;

        // stopPoll cancels pending transfers via Transfer.cancel(), unblocking
        // readOneBulkInMessage so the receive loop exits cleanly before close().
        this.stopPollEndpoint();
        this._inEndpoint = undefined;

        // Wait for the receive loop to drain (stopPoll resolves it via null callback)
        await Promise.race([
            this._receiveLoopDone,
            new Promise<void>((r) => setTimeout(r, 500)),
        ]);

        if (dev?.opened) {
            try {
                await dev.releaseInterface(this._ifaceNumber);
            } catch {
                // ignore
            }
            try {
                const closing = dev.close();
                await Promise.race([
                    closing,
                    new Promise<void>((r) => setTimeout(r, USB_CLOSE_TIMEOUT_MS)),
                ]);
                void closing.catch(() => {
                    /* ignore late reject */
                });
            } catch (e) {
                console.warn(
                    '[PybricksUsbClient] close failed:',
                    e instanceof Error ? e.message : e,
                );
            }
        }

        this._stdoutByteBuffer = new Uint8Array(0);
        this._commandGate = Promise.resolve();
    }

    // -------------------------------------------------------------------------
    // BaseClient actions
    // -------------------------------------------------------------------------

    public override async sendTerminalUserInputAsync(text: string): Promise<void> {
        if (!this.connected) throw new Error('Not connected to a device');
        const maxPayload = Math.max(1, (this._capabilities?.maxWriteSize ?? 20) - 1);
        const enc = new TextEncoder().encode(text);
        for (let i = 0; i < enc.length; i += maxPayload) {
            const chunk = enc.buffer.slice(i, i + maxPayload);
            await this.write(createWriteStdinCommand(chunk));
        }
    }

    public override async action_sendAppData(data: ArrayBuffer): Promise<void> {
        if (!this.connected) throw new Error('Not connected to a device');
        await this.write(createWriteAppDataCommand(0, data));
    }

    public override async action_start(
        slot?: number | StartMode,
        replContent?: string,
    ): Promise<void> {
        if (typeof slot === 'number' || slot === undefined) {
            await this.write(createStartUserProgramCommand(slot ?? 0));
        } else if (slot === StartMode.REPL) {
            await this.write(createStartUserProgramCommand(BuiltinProgramId.REPL));
            if (replContent) await this.sendCodeToRepl(replContent);
        }
    }

    public override async action_stop(): Promise<void> {
        await this.write(createStopUserProgramCommand());
    }

    public override async action_upload(
        data: Uint8Array,
        _slot?: number,
        _filename?: string,
        progressCb?: (incrementPct: number) => void,
    ): Promise<void> {
        if (
            !this._capabilities ||
            data.byteLength > this._capabilities.maxUserProgramSize
        ) {
            throw new Error(
                `User program size (${data.byteLength}) exceeds maximum allowed size (${this._capabilities?.maxUserProgramSize}).`,
            );
        }

        const writeSize = this._capabilities.maxWriteSize - 5; // 5 bytes header
        const incrementPct = 100 / (data.byteLength / writeSize);

        setState(StateProp.Uploading, true);
        try {
            await this.write(createWriteUserProgramMetaCommand(0));

            for (let offset = 0; offset < data.byteLength; offset += writeSize) {
                const chunk = data.slice(offset, offset + writeSize);
                await this.write(createWriteUserRamCommand(offset, chunk.buffer));
                if (progressCb) progressCb(incrementPct);
                await sleep(1);
            }

            await this.write(createWriteUserProgramMetaCommand(data.byteLength));
        } catch (error) {
            setState(StateProp.Uploading, false);
            throw error;
        }
        setState(StateProp.Uploading, false);
    }

    // Reused from PybricksBleClient
    public async sendCodeToRepl(code: string): Promise<void> {
        const eol = '\r';
        const lines = code.split(/\r?\n/);
        if (lines.length === 0) return;

        await this.sendTerminalUserInputAsync('\x05'); // Ctrl+E (paste mode)
        let inMultiLineComment = false;
        for (const line of lines) {
            if (line.trim().endsWith('"""') && inMultiLineComment) {
                inMultiLineComment = false;
                continue;
            } else if (line.trim().startsWith('"""') || inMultiLineComment) {
                inMultiLineComment = true;
                continue;
            }
            if (line.trim().length === 0) continue;
            if (line.trim().startsWith('#')) continue;
            await this.sendTerminalUserInputAsync(line + eol);
            await sleep(1);
        }
        await this.sendTerminalUserInputAsync(eol);
        await this.sendTerminalUserInputAsync('\x04'); // Ctrl+D (finish)
    }
}
