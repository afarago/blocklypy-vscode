import { Characteristic } from '@stoprocent/noble';
import semver from 'semver';
import { DeviceMetadata } from '..';
import { MILLISECONDS_IN_SECOND } from '../../const';
import Config, { ConfigKeys, FeatureFlags } from '../../extension/config';
import { RefreshTree } from '../../extension/tree-commands';
import { setState, StateProp } from '../../logic/state';
import { AppDataInstrumentationPybricksProtocol } from '../../pybricks/appdata-instrumentation-protocol';
import {
    HubTypeDescriptors,
    HubTypeDescriptorType,
} from '../../pybricks/autodetect/const';
import {
    decodePnpId,
    deviceInformationServiceUUID,
    firmwareRevisionStringUUID,
    PnpId,
    pnpIdUUID,
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
    pybricksControlEventCharacteristicUUID,
    pybricksHubCapabilitiesCharacteristicUUID,
    pybricksServiceUUID,
    Status,
    statusToFlag,
} from '../../pybricks/ble-pybricks-service/protocol';
import { maybe } from '../../pybricks/utils';
import { sleep } from '../../utils';
import { withTimeout } from '../../utils/async';
import { BackpressureQueue } from '../../utils/backpressure-queue';
import {
    CONNECTION_TIMEOUT_SEC_DEFAULT,
    RSSI_REFRESH_WHILE_CONNECTED_INTERVAL_MS,
} from '../connection-manager';
import { BaseLayer, LayerKind } from '../layers/base-layer';
import { DeviceMetadataWithPeripheral } from '../layers/ble-layer';
import { UUIDu } from '../utils';
import {
    BaseClient,
    ClientClassDescriptor,
    DeviceOSType,
    StartMode,
} from './base-client';

interface Capabilities {
    maxWriteSize: number;
    flags: number;
    maxUserProgramSize: number;
    numOfSlots: number | undefined; // above 1.5.0
}

interface VersionInfo {
    firmware: string;
    software: string;
    pnpId: PnpId;
}

export class PybricksBleClient extends BaseClient {
    public static override readonly classDescriptor: ClientClassDescriptor = {
        os: DeviceOSType.Pybricks,
        layer: LayerKind.BLE,
        deviceType: 'pybricks-ble',
        description: 'Pybricks on BLE',
        supportsModularMpy: true,
        requiresSlot: false,
    };

    private _rxtxCharacteristic: Characteristic | undefined;
    private _capabilitiesCharacteristic: Characteristic | undefined;
    private _capabilities: Capabilities | undefined;
    private _version: VersionInfo | undefined;
    private _incomingDataQueue: BackpressureQueue<Buffer>;
    private _incomingAppDataQueue: BackpressureQueue<Buffer>;
    private _hubtype: HubTypeDescriptorType | undefined;

    public get descriptionKVP(): [string, string][] {
        const kvp: [string, string][] = [];
        const deviceDescription = this.classDescriptor.description;
        if (deviceDescription) kvp.push(['type', deviceDescription]);

        if (this.hubType) kvp.push(['hub', this.hubType.label]);

        const firmware = this._version?.firmware ?? 'unknown';
        kvp.push(['firmware', firmware]);
        const software = this._version?.software ?? 'unknown';
        kvp.push(['software', software]);
        // if (this.uniqueSerial) kvp.push(['serial', this.uniqueSerial]);

        return kvp;
    }

    public override get metadata() {
        return this._metadata as DeviceMetadataWithPeripheral;
    }

    public get capabilities() {
        return this._capabilities;
    }

    public get pnpId() {
        return this._version?.pnpId;
    }

    public get hubType() {
        return this._hubtype;
    }

    public get connected() {
        return this.metadata?.peripheral?.state === 'connected';
    }

    public override get uniqueSerial(): string | undefined {
        return UUIDu.toString(this.metadata?.peripheral?.id);
    }

    public override get slotName() {
        if (this._slot !== undefined && this._slot in BuiltinProgramId)
            return BuiltinProgramId[this._slot as BuiltinProgramId];
        if (
            this.capabilities?.numOfSlots !== undefined &&
            this.capabilities?.numOfSlots > 0 &&
            this._slot !== undefined
        ) {
            return String(this._slot);
        }
        return undefined;
    }

    public override get allowTerminalInputEcho(): boolean {
        // disable echo in REPL mode
        return this.slot !== BuiltinProgramId.REPL;
    }

    constructor(metadata: DeviceMetadataWithPeripheral, parent: BaseLayer) {
        super(metadata, parent);
        this._incomingDataQueue = new BackpressureQueue<Buffer>(
            async (data: Buffer) => this.handleIncomingData(data),
            { name: 'PybricksIncomingData' },
        );
        this._incomingAppDataQueue = new BackpressureQueue<Buffer>(
            async (data: Buffer) => this.handleIncomingAppData(data),
            { name: 'PybricksAppData' },
        );
    }

    protected override async disconnectWorker() {
        try {
            this.metadata.peripheral.disconnect(); // ignore cb
        } catch (error) {
            console.error('Error during BLE disconnect:', error);
        }
        return Promise.resolve();
    }

    protected async connectWorker(
        onDeviceUpdated: (device: DeviceMetadata) => void,
        onDeviceRemoved: (device: DeviceMetadata, id?: string) => void,
    ) {
        // --- BLE specific stuff
        const metadata = this.metadata;
        const device = metadata.peripheral;
        if (!device) throw new Error('No peripheral in metadata');

        const [, connErr] = await maybe(
            withTimeout(
                device.connectAsync(),
                Config.get(
                    ConfigKeys.ConnectionTimeoutSec,
                    CONNECTION_TIMEOUT_SEC_DEFAULT,
                ) * MILLISECONDS_IN_SECOND,
            ),
        );
        if (connErr) return device.cancelConnect();

        this._exitStack.push(() => {
            device.removeAllListeners();
            // need to remove this as pybricks creates a random BLE id on each reconnect
            this.parent.allDevices.delete(metadata.id);
            metadata.validTill = 0;

            if (onDeviceRemoved) onDeviceRemoved(metadata);

            // forced, even ok to remove current client
            RefreshTree(true);
        });

        device.on(
            'disconnect',
            () => void this.handleDisconnectAsync(this.metadata.id),
        );

        // --- Discover services and characteristics
        const discoveredServicesandCharacterisitics =
            await device.discoverSomeServicesAndCharacteristicsAsync(
                [pybricksServiceUUID, UUIDu.to128(deviceInformationServiceUUID)],
                [
                    ...[
                        pybricksControlEventCharacteristicUUID,
                        pybricksHubCapabilitiesCharacteristicUUID,
                    ].map((uuid) => UUIDu.to128(uuid)),
                    ...[
                        firmwareRevisionStringUUID,
                        softwareRevisionStringUUID,
                        pnpIdUUID,
                    ].map((uuid) => UUIDu.to16(uuid)),
                ],
            );
        // Map characteristics by normalized UUID (lowercase, no dashes)
        const characteristics = discoveredServicesandCharacterisitics.characteristics;
        const charMap = new Map(
            characteristics.map((c) => [c.uuid.replace(/-/g, '').toLowerCase(), c]),
        );

        const pybricksControlChar = charMap.get(
            UUIDu.toString(pybricksControlEventCharacteristicUUID)
                .replace(/-/g, '')
                .toLowerCase(),
        );
        const pybricksHubCapabilitiesChar = charMap.get(
            UUIDu.toString(pybricksHubCapabilitiesCharacteristicUUID)
                .replace(/-/g, '')
                .toLowerCase(),
        );
        const firmwareChar = charMap.get(
            UUIDu.toString(firmwareRevisionStringUUID).replace(/-/g, '').toLowerCase(),
        );
        const softwareChar = charMap.get(
            UUIDu.toString(softwareRevisionStringUUID).replace(/-/g, '').toLowerCase(),
        );
        const pnpIdChar = charMap.get(
            UUIDu.toString(pnpIdUUID).replace(/-/g, '').toLowerCase(),
        );
        if (
            !pybricksControlChar ||
            !pybricksHubCapabilitiesChar ||
            !firmwareChar ||
            !softwareChar ||
            !pnpIdChar
        ) {
            throw new Error('Missing required characteristics');
        }

        // --- Read version info
        const firmwareRevision = (await firmwareChar.readAsync()).toString('utf8');
        const softwareRevision = (await softwareChar.readAsync()).toString('utf8');
        const pnpId = decodePnpId(new DataView((await pnpIdChar.readAsync()).buffer));
        this._version = {
            firmware: firmwareRevision,
            software: softwareRevision,
            pnpId,
        };

        this._hubtype = HubTypeDescriptors.find((hub) => {
            return (
                hub.productId === pnpId.productId &&
                (hub.productVersion === undefined ||
                    hub.productVersion === pnpId.productVersion)
            );
        });

        this._exitStack.push(() => {
            this._rxtxCharacteristic?.removeAllListeners('data');
            // sometimes this gets stuck, intentionally ignore wait
            void this._rxtxCharacteristic?.unsubscribeAsync();
            this._rxtxCharacteristic = undefined;
        });

        this._rxtxCharacteristic = pybricksControlChar;
        this._rxtxCharacteristic.on(
            'data',
            (data) => void this._incomingDataQueue.push(data),
        );
        await this._rxtxCharacteristic.subscribeAsync();

        // Read capabilities once connected
        if (semver.satisfies(softwareRevision, '^1.2.0')) {
            this._capabilitiesCharacteristic = pybricksHubCapabilitiesChar;
            const buf = await this._capabilitiesCharacteristic?.readAsync();
            this._capabilities = buf && {
                maxWriteSize: buf.readUInt16LE(0) ?? 20,
                flags: buf.readUInt32LE(2),
                maxUserProgramSize: buf.readUInt32LE(6),
                numOfSlots: semver.satisfies(softwareRevision, '^1.5.0')
                    ? buf.readUInt8(10)
                    : undefined, // above 1.5.0
            };
        }

        // Repeatedly update RSSI even while connected
        const rssiUpdater = setInterval(
            () => device.updateRssi(),
            RSSI_REFRESH_WHILE_CONNECTED_INTERVAL_MS,
        );
        device.on('rssiUpdate', () => {
            if (onDeviceUpdated) {
                onDeviceUpdated(this.metadata as DeviceMetadata);
            }
        });
        this._exitStack.push(() => {
            clearInterval(rssiUpdater);
            device.removeAllListeners();
        });
    }

    protected async write(data: Uint8Array) {
        await this._rxtxCharacteristic?.writeAsync(
            Buffer.from(data),
            /* use with response (withoutResponse=false) */
            false,
        );
    }

    protected async handleIncomingData(data: Buffer): Promise<void> {
        // this is pybricks specific - move to pybricks client?
        const dataView = new DataView(data.buffer);
        const eventType = getEventType(dataView);
        switch (eventType) {
            case EventType.StatusReport:
                {
                    // process any pending stdout data first
                    await this.processStdoutData();

                    // parse status report
                    const status = parseStatusReport(dataView);
                    if (status) {
                        const value =
                            (status.flags & statusToFlag(Status.UserProgramRunning)) !==
                            0;

                        if (status.flags & statusToFlag(Status.UserProgramRunning)) {
                            this._slot = status.runningProgId;
                        } else {
                            this._slot = undefined;
                        }

                        setState(StateProp.Running, value);
                    }
                }
                break;
            case EventType.WriteStdout:
                setState(StateProp.Running, true);

                const chunk = data.toString('utf8', 1, data.length);
                await this.handleWriteStdout(chunk);
                break;
            case EventType.WriteAppData:
                // parse and handle app data
                await this._incomingAppDataQueue.push(
                    Buffer.from(data.buffer.slice(1)),
                );
                break;
            default:
                console.warn('Unknown event type:', eventType);
                break;
        }
    }

    private async handleIncomingAppData(data: Buffer) {
        if (
            Config.FeatureFlag.get(
                FeatureFlags.PybricksUseApplicationInterfaceForPybricksProtocol,
            )
        ) {
            await AppDataInstrumentationPybricksProtocol.decode(data);
        }
    }

    public override async sendTerminalUserInputAsync(text: string) {
        if (!this.connected) throw new Error('Not connected to a device');
        if (!this._capabilities?.maxWriteSize) return;

        const maxBleWriteSize = this._capabilities.maxWriteSize;
        // assert(maxBleWriteSize >= 20, 'bad maxBleWriteSize');
        const value = text;
        const encoder = new TextEncoder();
        const data = encoder.encode(value);

        for (let i = 0; i < data.length; i += maxBleWriteSize) {
            await this.write(createWriteStdinCommand(data.buffer));
        }
    }

    public async action_sendAppData(data: ArrayBuffer) {
        if (!this.connected) throw new Error('Not connected to a device');
        if (!this._capabilities?.maxWriteSize) return;

        await this.write(createWriteAppDataCommand(0, data));
    }

    public override async updateDeviceNotifications(): Promise<void> {
        // set up notifications if not supported
        // NOOP
        return Promise.resolve();
    }

    public override async action_start(
        slot?: number | StartMode,
        replContent?: string,
    ) {
        if (typeof slot === 'number' || slot === undefined) {
            // slot is not supported on pybricks, always 0
            slot = slot ?? 0;
        } else if (slot === StartMode.REPL) {
            slot = BuiltinProgramId.REPL;
        }

        await this.write(createStartUserProgramCommand(slot));

        if (slot === BuiltinProgramId.REPL && replContent) {
            await this.sendCodeToRepl(replContent);
        }
    }

    public override async action_stop() {
        await this.write(createStopUserProgramCommand());
    }

    public override async action_upload(
        data: Uint8Array,
        _slot?: number,
        _filename?: string,
        progressCb?: (incrementPct: number) => void,
    ) {
        // const packetSize = this._capabilities?.maxWriteSize ?? blob.bytes.length;

        if (
            !this._capabilities ||
            this._capabilities.maxWriteSize === undefined ||
            this._capabilities.maxUserProgramSize === undefined ||
            data.byteLength > this._capabilities?.maxUserProgramSize
        ) {
            throw new Error(
                `User program size (${data.byteLength}) exceeds maximum allowed size (${this._capabilities?.maxUserProgramSize}).`,
            );
        }

        // Pybricks Code sends size 0 to clear the state before sending the new program, then sends the size on completion.
        setState(StateProp.Uploading, true);
        try {
            await this.write(createWriteUserProgramMetaCommand(0));
            await this.write(createWriteUserProgramMetaCommand(data.byteLength));

            const writeSize = this._capabilities.maxWriteSize - 5; // 5 bytes for the header
            const incrementPct = 100 / (data.byteLength / writeSize);
            for (let offset = 0; offset < data.byteLength; offset += writeSize) {
                const chunk = data.slice(offset, offset + writeSize);
                const chunkBuffer = chunk.buffer;
                const buffer = createWriteUserRamCommand(offset, chunkBuffer);
                await this.write(buffer);

                if (progressCb) progressCb(incrementPct);

                await sleep(1); // let the hub finish processing the last chunk
            }
        } catch (error) {
            setState(StateProp.Uploading, false);
            throw error;
        }
        setState(StateProp.Uploading, false);
    }

    public async sendCodeToRepl(code: string) {
        const eol = '\r'; // Pybricks REPL uses \r as EOL
        const lines = code.split(/\r?\n/);
        if (lines.length === 0) return;
        // assume in REPL mode already

        await this.sendTerminalUserInputAsync('\x05'); // Ctrl+E (paste mode), hex 05
        // TODO: wait for REPL to enter paste mode?
        let inMultiLineComment = false;
        for (let line of lines) {
            if (line.trim().endsWith('"""') && inMultiLineComment) {
                inMultiLineComment = false;
                continue;
            } else if (line.trim().startsWith('"""') || inMultiLineComment) {
                inMultiLineComment = true;
                continue;
            }
            if (line.trim().length === 0) continue; // skip empty lines
            if (line.trim().startsWith('#')) continue; // skip comment lines
            // skip """ ... """ (multi-line strings) and anything inbetween
            await this.sendTerminalUserInputAsync(line + eol);
            // console.debug('Sent REPL line:', line);
            await sleep(1);
        }
        await this.sendTerminalUserInputAsync(eol);
        await this.sendTerminalUserInputAsync('\x04'); // Ctrl+D (finish), hex 04
    }
}
