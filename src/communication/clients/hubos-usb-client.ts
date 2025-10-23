import { SerialPort } from 'serialport';
import { DeviceMetadata } from '..';
import { maybe } from '../../pybricks/utils';
import { GetHubNameRequestMessage } from '../../spike/messages/get-hub-name-request-message';
import { GetHubNameResponseMessage } from '../../spike/messages/get-hub-name-response-message';
import { pack, unpack } from '../../spike/utils/cobs';
import { LayerKind } from '../layers/base-layer';
import { DeviceMetadataForUSB, USBLayer } from '../layers/usb-layer';
import { DeviceOSType } from './base-client';
import { HubOSBaseClient } from './hubos-base-client';

const GET_SERIAL_NAME_TIMEOUT = 3000;

export class HubOSUsbClient extends HubOSBaseClient {
    public static override readonly classDescriptor = {
        os: DeviceOSType.HubOS,
        layer: LayerKind.USB,
        deviceType: 'hubos-usb',
        description: 'HubOS on USB',
        supportsModularMpy: false,
        requiresSlot: true,
    };

    private _serialPort: SerialPort | undefined;

    public override get metadata(): DeviceMetadataForUSB | undefined {
        return this._metadata as DeviceMetadataForUSB;
    }

    public get connected() {
        return !!this._serialPort?.isOpen;
    }

    public override get uniqueSerial(): string | undefined {
        return this.metadata?.portinfo.serialNumber;
    }

    public set serialPort(port: SerialPort | undefined) {
        this._serialPort = port;
    }

    public async write(data: Uint8Array): Promise<void> {
        if (!this.connected || !this.metadata) return; // before connecting use serial.write directly for getName

        this._serialPort?.write(data);
        return Promise.resolve();
    }

    public static async getNameFromDevice(
        serial: SerialPort,
    ): Promise<string | undefined> {
        try {
            const namePromiseWithWrite = new Promise<string | undefined>(
                (resolve, reject) => {
                    let timer: NodeJS.Timeout | undefined;
                    const dataHandler = (data: Buffer) => {
                        serial.removeListener('data', dataHandler);
                        if (timer) {
                            clearTimeout(timer);
                            timer = undefined;
                        }

                        let hubName: string | undefined;
                        try {
                            const data2 = unpack(data);
                            hubName =
                                GetHubNameResponseMessage.fromBytes(data2).hubName;
                        } catch {
                            reject(new Error('Failed to parse response'));
                            return;
                        }

                        if (hubName) resolve(hubName);
                        else reject(new Error('No response'));
                    };
                    serial.on('data', dataHandler);

                    const message = new GetHubNameRequestMessage();
                    const payload = pack(message.serialize());
                    serial.write(payload);
                    timer = setTimeout(() => {
                        serial.removeListener('data', dataHandler);
                        reject(new Error('Timeout waiting for response'));
                    }, GET_SERIAL_NAME_TIMEOUT);
                },
            );
            const [name, _] = await maybe(namePromiseWithWrite);
            return name;
        } catch (e) {
            console.error('Error getting name from USB device:', e);
        }
    }

    public static async refreshDeviceName(
        serial: SerialPort,
        metadata: DeviceMetadataForUSB,
    ): Promise<void> {
        const name = await HubOSUsbClient.getNameFromDevice(serial);
        if (name) metadata.name = name;
    }

    protected async connectWorker(
        _onDeviceUpdated: (device: DeviceMetadata) => void,
        onDeviceRemoved: (device: DeviceMetadata) => void,
    ) {
        const metadata = this.metadata;
        const device = metadata?.portinfo;
        if (!device) throw new Error('No portinfo in metadata');

        this._serialPort = await (this.parent as USBLayer).openPort(metadata);
        if (!this._serialPort.isOpen) throw new Error('Failed to open serial port');

        this._exitStack.push(() => {
            if (onDeviceRemoved) onDeviceRemoved(metadata);
        });

        const handleData = (data: Buffer) => void this.handleIncomingData(data);
        const handleClose = () => void this.handleDisconnectAsync(metadata.id);
        this._serialPort.on('data', handleData);
        this._serialPort.on('close', handleClose);

        this._exitStack.push(async () => {
            await (this.parent as USBLayer).closePort(this._serialPort!);
            this._serialPort?.removeListener('data', handleData);
            this._serialPort?.removeListener('close', handleClose);
            this._serialPort = undefined;
        });

        // will be handled in handleIncomingDataAsync for capabilities
        await this.finalizeConnect();
    }

    protected override async disconnectWorker() {
        await super.disconnectWorker();

        this._serialPort?.removeAllListeners();
        if (this._serialPort)
            await (this.parent as USBLayer).closePort(this._serialPort);
        this._serialPort = undefined;
    }
}
