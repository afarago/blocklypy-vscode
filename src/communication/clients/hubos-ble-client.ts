import { Characteristic } from '@stoprocent/noble';
import { DeviceMetadata } from '..';
import {
    SPIKE_RX_CHAR_UUID,
    SPIKE_SERVICE_UUID,
    SPIKE_TX_CHAR_UUID,
} from '../../spike/protocol';
import { RSSI_REFRESH_WHILE_CONNECTED_INTERVAL_MS } from '../connection-manager';
import { LayerKind } from '../layers/base-layer';
import { DeviceMetadataWithPeripheral } from '../layers/ble-layer';
import { UUIDu } from '../utils';
import { DeviceOSType } from './base-client';
import { HubOSBaseClient } from './hubos-base-client';

export class HubOSBleClient extends HubOSBaseClient {
    public static override readonly classDescriptor = {
        os: DeviceOSType.HubOS,
        layer: LayerKind.BLE,
        deviceType: 'hubos-ble',
        description: 'HubOS on BLE',
        supportsModularMpy: false,
        requiresSlot: true,
    };

    private _rxCharacteristic: Characteristic | undefined;
    private _txCharacteristic: Characteristic | undefined;

    public override get metadata() {
        return this._metadata as DeviceMetadataWithPeripheral;
    }

    public get connected() {
        return this.metadata?.peripheral?.state === 'connected';
    }

    public override get uniqueSerial(): string | undefined {
        return UUIDu.toString(this.metadata?.peripheral?.id);
    }

    protected override async disconnectWorker() {
        if (this.connected) this.metadata.peripheral?.disconnect();
        return Promise.resolve();
    }

    protected async connectWorker(
        onDeviceUpdated: (device: DeviceMetadata) => void | undefined,
        onDeviceRemoved: (device: DeviceMetadata) => void | undefined,
    ) {
        // --- BLE specific stuff
        const metadata = this.metadata;
        const device = metadata.peripheral;
        if (!device) throw new Error('No peripheral in metadata');

        await device.connectAsync();
        this._exitStack.push(() => {
            device.removeAllListeners('disconnect');
            if (onDeviceRemoved) onDeviceRemoved(metadata);
        });

        device.on(
            'disconnect',
            () => void this.handleDisconnectAsync(this.metadata.id),
        );

        // --- Discover services and characteristics
        const peripheral = this.metadata.peripheral;
        if (!peripheral) throw new Error('No peripheral in metadata');

        this._exitStack.push(async () => {
            this._rxCharacteristic?.removeAllListeners('data');
            await this._rxCharacteristic?.unsubscribeAsync();
            this._rxCharacteristic = undefined;
        });

        const chars = await peripheral.discoverSomeServicesAndCharacteristicsAsync(
            [SPIKE_SERVICE_UUID],
            [SPIKE_RX_CHAR_UUID, SPIKE_TX_CHAR_UUID],
        );
        [this._rxCharacteristic, this._txCharacteristic] = chars?.characteristics;
        this._txCharacteristic.on('data', (data) => {
            // intentionally not awaited
            this.handleIncomingData(data).catch(console.error);
        });
        await this._txCharacteristic.subscribeAsync();

        await this.finalizeConnect();

        // Repeatedly update RSSI and notify listeners of RSSI update
        const rssiUpdater = setInterval(
            () => peripheral.updateRssi(),
            RSSI_REFRESH_WHILE_CONNECTED_INTERVAL_MS,
        );
        peripheral.on(
            'rssiUpdate',
            () => onDeviceUpdated && onDeviceUpdated(this.metadata),
        );
        this._exitStack.push(() => {
            clearInterval(rssiUpdater);
            peripheral.removeAllListeners();
        });
    }

    protected async write(data: Uint8Array) {
        const packetSize = this.capabilities?.maxPacketSize ?? data.length;
        for (let loop = 0; loop < data.length; loop += packetSize) {
            const chunk = data.slice(loop, loop + packetSize);
            await this._rxCharacteristic?.writeAsync(
                Buffer.from(chunk),
                /* use without response (withoutResponse=true) */
                true,
            );
        }
    }
}
