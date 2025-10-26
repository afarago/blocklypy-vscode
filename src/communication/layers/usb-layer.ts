import { PortInfo } from '@serialport/bindings-interface';
import { SerialPort } from 'serialport';

import { DeviceMetadata, LayerKind } from '.';
import {
    HUBOS_SPIKE_USB_PRODUCT_ID,
    // SPIKE_USB_PRODUCT_ID_NUM,
    HUBOS_USB_VENDOR_ID,
} from '../../spike/protocol';
import { HubOSUsbClient } from '../clients/hubos-usb-client';
import { ConnectionState } from '../index';
import { BaseLayer, DeviceChangeEvent, LayerDescriptor } from './base-layer';
// import { setInterval } from 'timers/promises';

const USB_CLIENT_TTL = 20 * 1000;

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

export class USBLayer extends BaseLayer {
    public static override readonly descriptor: LayerDescriptor = {
        id: 'universal-usb',
        name: 'Desktop Universal Serial Bus',
        kind: LayerKind.USB,
        canScan: true,
    } as const;

    private _supportsHotPlug: boolean = false;
    private _scanHandle: NodeJS.Timeout | undefined = undefined;
    private _isWithinScan: boolean = false;

    public override supportsDevtype(_devtype: string) {
        return HubOSUsbClient.deviceType === _devtype;
    }

    public override async initialize() {
        // try {
        //     usb.on('attach', this.handleUsbAttach.bind(this));
        //     usb.on('detach', this.handleUsbDetach.bind(this));
        //     this._supportsHotPlug = true;
        // } catch (e) {
        //     console.error('Error setting up USB listeners:', e);
        //     this._supportsHotPlug = false;

        //     // Fallback: Periodic scanning
        //     await this.startScanning();
        // }
        // await this.scan();

        this._supportsHotPlug = false;
        await this.startScanning();
        this.state = ConnectionState.Disconnected; // initialized successfully
    }

    // private usbRegistrySerial = new Map<usb.Device, string>();

    // private handleUsbAttach(device: usb.Device) {
    //     if (
    //         device.deviceDescriptor.idVendor === SPIKE_USB_VENDOR_ID_NUM &&
    //         device.deviceDescriptor.idProduct === SPIKE_USB_PRODUCT_ID_NUM
    //         // pybricks = VID:164, PID:16
    //     ) {
    //         const handleOpen = async (device: usb.Device) => {
    //             device.open();
    //             // const manufacturer = await _getUsbStringDescriptor(device, 1); // 1 = Manufacturer, LEGO System A/S
    //             // const product = await _getUsbStringDescriptor(device, 2); // 2 = Product, SPIKE Prime VCP
    //             const serialnumber = await _getUsbStringDescriptor(device, 3); // 3 = Serial Number, 000000000000
    //             if (serialnumber) this.usbRegistrySerial.set(device, serialnumber);
    //         };
    //         handleOpen(device).catch(console.error);
    //         void this.scan().catch(console.error);
    //     }
    // }

    // private handleUsbDetach(device: usb.Device) {
    //     if (
    //         device.deviceDescriptor.idVendor === SPIKE_USB_VENDOR_ID_NUM &&
    //         device.deviceDescriptor.idProduct === SPIKE_USB_PRODUCT_ID_NUM
    //     ) {
    //         const serialnumber = this.usbRegistrySerial.get(device);
    //         if (serialnumber) {
    //             for (const [id, metadata] of this._allDevices.entries()) {
    //                 if (
    //                     metadata instanceof DeviceMetadataForUSB &&
    //                     metadata.serialNumber === serialnumber
    //                 ) {
    //                     metadata.validTill = 0;
    //                     this._allDevices.delete(id);
    //                     this._deviceChange.fire({ metadata });
    //                 }
    //             }
    //         }
    //         this.usbRegistrySerial.delete(device);
    //     }
    // }

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
        this._scanHandle = setInterval(() => void handler(), USB_CLIENT_TTL / 2);
        // this._scanHandle = setInterval(USB_CLIENT_TTL / 2, handler);
        return Promise.resolve();
    }

    private async scan() {
        if (this._isWithinScan) return;
        this._isWithinScan = true;
        try {
            const ports = await SerialPort.list();
            const portsOk = ports.filter(
                (port) =>
                    port.vendorId === HUBOS_USB_VENDOR_ID &&
                    port.productId === HUBOS_SPIKE_USB_PRODUCT_ID,
            );
            if (portsOk.length === 0) return;

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

                // If the device is not hot-pluggable, we set a timeout to forget it again
                if (!this._supportsHotPlug)
                    metadata.validTill = Date.now() + USB_CLIENT_TTL;

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
        } catch (e) {
            console.error('Error scanning USB devices:', e);
        } finally {
            this._isWithinScan = false;
        }
    }

    public override async connect(id: string, devtype: string): Promise<void> {
        const metadata = this._allDevices.get(id) as DeviceMetadataForUSB;
        if (!metadata) {
            throw new Error(`Device ${id} not found.`);
        }

        switch (metadata.devtype) {
            case HubOSUsbClient.deviceType:
                BaseLayer.activeClient = new HubOSUsbClient(metadata, this);
                break;
            // case PybricksUsbClient.devtype:
            //     this._client = new PybricksUsbClient(metadata);
            //     break;
            default:
                throw new Error(`Unknown device type: ${metadata.devtype}`);
        }

        await super.connect(id, devtype);
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
