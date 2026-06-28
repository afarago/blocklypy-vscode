import { PortInfo } from '@serialport/bindings-interface';
import { SerialPort } from 'serialport';
import { usb, WebUSB } from 'usb';
import { ConnectionState, DeviceMetadata } from '..';
import { MILLISECONDS_IN_SECOND } from '../../const';
import {
    LEGO_USB_VENDOR_ID,
    legoUsbProductLabel,
    PYBRICKS_USB_PRODUCT_IDS,
} from '../../pybricks/usb-pybricks-service/constants';
import {
    HUBOS_SPIKE_USB_PRODUCT_ID,
    // SPIKE_USB_PRODUCT_ID_NUM,
    HUBOS_USB_VENDOR_ID,
    HUBOS_USB_VENDOR_ID_NUM,
} from '../../spike/protocol';
import { HubOSUsbClient } from '../clients/hubos-usb-client';
import { PybricksUsbClient } from '../clients/pybricks-usb-client';
import { BaseLayer, DeviceChangeEvent, LayerDescriptor, LayerKind } from './base-layer';
// import { setInterval } from 'timers/promises';

const USB_CLIENT_TTL_MS = 20 * MILLISECONDS_IN_SECOND; // 20 seconds

export class DeviceMetadataForUSB extends DeviceMetadata {
    private _resolvedName: string | undefined = undefined;

    constructor(
        public devtype: string,
        public portinfo: PortInfo,
        public serialNumber: string,
    ) {
        super(devtype);
    }

    public override get rssi(): number | undefined {
        return undefined;
    }

    public override get name(): string | undefined {
        return this._resolvedName ?? this.portinfo.path;
    }

    public override set name(_value: string | undefined) {
        this._resolvedName = _value;
    }

    public get hasResolvedName(): boolean {
        return this._resolvedName !== undefined;
    }

    public override get id(): string {
        return DeviceMetadata.generateId(this.devtype, this.portinfo.path);
    }
}

export class DeviceMetadataForPybricksUSB extends DeviceMetadata {
    private _resolvedName: string | undefined = undefined;

    constructor(
        public readonly vendorId: number,
        public readonly productId: number,
        public readonly serialNumber: string,
    ) {
        super(PybricksUsbClient.deviceType);
    }

    public override get rssi(): number | undefined {
        return undefined;
    }

    public override get name(): string | undefined {
        return this._resolvedName ?? legoUsbProductLabel(this.productId);
    }

    public override set name(value: string | undefined) {
        this._resolvedName = value;
    }

    public get hasResolvedName(): boolean {
        return this._resolvedName !== undefined;
    }

    public override get id(): string {
        return DeviceMetadata.generateId(
            PybricksUsbClient.deviceType,
            `${this.vendorId.toString(16)}-${this.productId.toString(16)}-${this.serialNumber}`,
        );
    }
}

export class USBLayer extends BaseLayer {
    public static override readonly descriptor: LayerDescriptor = {
        id: 'universal-usb',
        name: 'Universal Serial Bus',
        kind: LayerKind.USB,
        canScan: true,
    } as const;

    private _supportsHotPlug: boolean = false;
    private _scanHandle: NodeJS.Timeout | undefined = undefined;
    private _isWithinScan: boolean = false;

    public override supportsDevtype(_devtype: string) {
        return (
            HubOSUsbClient.deviceType === _devtype ||
            PybricksUsbClient.deviceType === _devtype
        );
    }
    public static supportsDevtype(_devtype: string) {
        return (
            HubOSUsbClient.deviceType === _devtype ||
            PybricksUsbClient.deviceType === _devtype
        );
    }

    public override async initialize() {
        try {
            usb.on('attach', this._handleUsbAttach);
            usb.on('detach', this._handleUsbDetach);
            // unref so hotplug events don't prevent VS Code from exiting
            usb.unrefHotplugEvents();
        } catch (e) {
            console.error('[USBLayer] hotplug events unavailable:', e);
        }

        await this.startScanning();
        this.state = ConnectionState.Disconnected;
    }

    public override async finalize(): Promise<void> {
        usb.removeListener('attach', this._handleUsbAttach);
        usb.removeListener('detach', this._handleUsbDetach);
        await super.finalize();
    }

    private readonly _handleUsbAttach = (device: usb.Device): void => {
        const vid = device.deviceDescriptor.idVendor;
        const pid = device.deviceDescriptor.idProduct;
        const isLego =
            vid === HUBOS_USB_VENDOR_ID_NUM ||
            (vid === LEGO_USB_VENDOR_ID && PYBRICKS_USB_PRODUCT_IDS.includes(pid));
        if (!isLego) return;
        // The attach event fires before the OS finishes setting up the device.
        // Scan immediately and twice more with short delays so we catch it as
        // soon as getDevices()/initialize() can open it successfully.
        void this.scan().catch(console.error);
        setTimeout(() => void this.scan().catch(console.error), 500);
        setTimeout(() => void this.scan().catch(console.error), 1500);
    };

    private readonly _handleUsbDetach = (device: usb.Device): void => {
        const vid = device.deviceDescriptor.idVendor;
        const pid = device.deviceDescriptor.idProduct;
        if (vid !== LEGO_USB_VENDOR_ID || !PYBRICKS_USB_PRODUCT_IDS.includes(pid))
            return;

        // Expire any Pybricks metadata that matches this VID/PID.
        // Serial number is not reliably available on detach, so match by VID+PID.
        for (const [id, metadata] of this._allDevices.entries()) {
            if (
                metadata instanceof DeviceMetadataForPybricksUSB &&
                metadata.vendorId === vid &&
                metadata.productId === pid
            ) {
                metadata.validTill = 0;
                this._allDevices.delete(id);
                this._deviceChange.fire({
                    metadata,
                    layer: this,
                } satisfies DeviceChangeEvent);
            }
        }
    };

    public override stopScanning() {
        if (this._scanHandle) {
            clearInterval(this._scanHandle);
            this._scanHandle = undefined;
        }
    }

    public override async startScanning() {
        if (!!this._scanHandle) return;

        const handler = async () => this.scan();
        await handler(); // initial call
        this._scanHandle = setInterval(() => void handler(), USB_CLIENT_TTL_MS / 2);
        // this._scanHandle = setInterval(USB_CLIENT_TTL / 2, handler);
        return Promise.resolve();
    }

    private async scan() {
        if (this._isWithinScan) return;
        this._isWithinScan = true;
        try {
            await Promise.all([this.scanHubOS(), this.scanPybricksUsb()]);
        } catch (e) {
            console.error('Error scanning USB devices:', e);
        } finally {
            this._isWithinScan = false;
        }
    }

    private async scanHubOS() {
        const ports = await SerialPort.list();
        const portsOk = ports.filter(
            (port) =>
                port.vendorId === HUBOS_USB_VENDOR_ID &&
                port.productId === HUBOS_SPIKE_USB_PRODUCT_ID,
        );

        for (const port of portsOk) {
            const serialNumber = port.serialNumber ?? 'unknown';
            const targetid = DeviceMetadata.generateId(
                HubOSUsbClient.deviceType,
                port.path,
            );
            let metadata = this._allDevices.get(targetid) as DeviceMetadataForUSB;

            if (!metadata) {
                metadata = new DeviceMetadataForUSB(
                    HubOSUsbClient.deviceType,
                    port,
                    serialNumber,
                );
            }
            this._allDevices.set(metadata.id, metadata);

            if (!this._supportsHotPlug)
                metadata.validTill = Date.now() + USB_CLIENT_TTL_MS;
            try {
                if (
                    metadata.devtype === HubOSUsbClient.deviceType &&
                    !metadata.hasResolvedName
                ) {
                    const serial = await this.openPort(metadata);
                    await HubOSUsbClient.refreshDeviceName(serial, metadata);
                    await this.closePort(serial);
                }
            } catch (_e) {
                metadata.validTill = 0;
                this._allDevices.delete(metadata.id);
            }
            this._deviceChange.fire({
                metadata,
                layer: this,
            } satisfies DeviceChangeEvent);
        }
    }

    private async scanPybricksUsb() {
        const webusb = new WebUSB({
            allowAllDevices: true,
            autoDetachKernelDriver: true,
        });
        let devices: USBDevice[];
        try {
            devices = await webusb.getDevices();
        } catch (e: unknown) {
            console.error('Error scanning for Pybricks USB devices:', e);
            return;
        }

        // Filter by LEGO VID and known Pybricks product IDs only.
        // Interface-class inspection is skipped: initialize() may fail silently on some hosts.
        // The connect step rejects devices that lack the ff:c5:f5 interface.
        const pybricksDevices = devices.filter(
            (d) =>
                d.vendorId === LEGO_USB_VENDOR_ID &&
                PYBRICKS_USB_PRODUCT_IDS.includes(d.productId),
        );

        for (const d of pybricksDevices) {
            const serialNumber = d.serialNumber ?? 'unknown';
            const metadata = new DeviceMetadataForPybricksUSB(
                d.vendorId,
                d.productId,
                serialNumber,
            );

            const existing = this._allDevices.get(metadata.id) as
                | DeviceMetadataForPybricksUSB
                | undefined;
            const current = existing ?? metadata;

            this._allDevices.set(current.id, current);
            current.validTill = Date.now() + USB_CLIENT_TTL_MS;

            if (!current.hasResolvedName) {
                try {
                    await PybricksUsbClient.refreshDeviceName(d, current);
                } catch {
                    // name stays as product label fallback
                }
            }

            this._deviceChange.fire({
                metadata: current,
                layer: this,
            } satisfies DeviceChangeEvent);
        }
    }

    public override async connect(id: string, devtype: string): Promise<void> {
        const metadata = this._allDevices.get(id);
        if (!metadata) {
            throw new Error(`Device ${id} not found.`);
        }

        switch (metadata.deviceType) {
            case HubOSUsbClient.deviceType:
                BaseLayer.activeClient = new HubOSUsbClient(
                    metadata as DeviceMetadataForUSB,
                    this,
                );
                break;
            case PybricksUsbClient.deviceType:
                BaseLayer.activeClient = new PybricksUsbClient(
                    metadata as DeviceMetadataForPybricksUSB,
                    this,
                );
                break;
            default:
                throw new Error(`Unknown device type: ${metadata.deviceType}`);
        }

        await super.connect(id, devtype);
    }

    public override async disconnect() {
        await super.disconnect();
    }

    public override get allDevices() {
        return this._allDevices;
    }

    public override get scanning() {
        return !!this._scanHandle;
    }

    public override waitForReadyPromise(): Promise<void> {
        return Promise.resolve();
    }

    public async closePort(serial: SerialPort): Promise<void> {
        if (!serial.isOpen) return;

        await new Promise<void>((resolve, reject) => {
            serial.close((err) => {
                const portpath = serial.path;
                this.portRegistry.delete(portpath);
                if (err) return reject(err);
                else return resolve();
            });
        });
    }

    private portRegistry = new Map<string, SerialPort>();
    public async openPort(metadata: DeviceMetadataForUSB): Promise<SerialPort> {
        const portinfo = metadata?.portinfo;
        if (!portinfo) throw new Error('No port info in metadata');
        if (this.portRegistry.has(portinfo.path))
            throw new Error('Port already opened');

        const serial = new SerialPort({
            path: portinfo.path,
            baudRate: 115200,
            autoOpen: false,
        });
        this.portRegistry.set(portinfo.path, serial);

        const serialPromise = new Promise<SerialPort>((resolve, reject) => {
            serial.open((err) => {
                if (err) return reject(err);
                else return resolve(serial);
            });
        });

        return serialPromise;
    }
}

// async function _getUsbStringDescriptor(device: usb.Device, desc_index: number) {
//     const promise = new Promise<string | undefined>((resolve, reject) => {
//         device.getStringDescriptor(desc_index, (error, data) => {
//             if (error) reject(error);
//             else resolve(data);
//         });
//     });
//     return promise;
// }
