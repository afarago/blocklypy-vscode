import {
    type Noble,
    type Peripheral,
    type PeripheralAdvertisement,
} from '@stoprocent/noble';
import _ from 'lodash';
import { ConnectionState, DeviceMetadata } from '..';
import { MILLISECONDS_IN_SECOND } from '../../const';
import Config, { ConfigKeys } from '../../extension/config';
import { setStatusBarItem } from '../../extension/statusbar';
import { hasState, setState, StateProp } from '../../logic/state';
import { pnpIdUUID } from '../../pybricks/ble-device-info-service/protocol';
import { pybricksServiceUUID } from '../../pybricks/ble-pybricks-service/protocol';
import {
    pybricksDecodeBleBroadcastData,
    PybricksDecodedBleBroadcast,
} from '../../pybricks/protocol-ble-broadcast';
import { SPIKE_SERVICE_UUID16 } from '../../spike/protocol';
import { HubOSBleClient } from '../clients/hubos-ble-client';
import { PybricksBleClient } from '../clients/pybricks-ble-client';
import { ConnectionManager } from '../connection-manager';
import { UUIDu } from '../utils';
import {
    BaseLayer,
    ConnectionStateChangeEvent,
    DeviceChangeEvent,
    LayerDescriptor,
    LayerKind,
} from './base-layer';

const ADVERTISEMENT_POLL_INTERVAL_MS = 1 * MILLISECONDS_IN_SECOND; // 1 second
const BLE_DEVICE_VISIBILITY_SEC_DEFAULT = 10; // seconds

export class DeviceMetadataWithPeripheral extends DeviceMetadata {
    constructor(
        public devtype: string,
        public peripheral: Peripheral,
        public lastBroadcast?: PybricksDecodedBleBroadcast,
    ) {
        super(devtype);
    }

    public override get rssi(): number | undefined {
        return this.peripheral.rssi;
    }

    public override get broadcastAsString(): string | undefined {
        return this.lastBroadcast ? JSON.stringify(this.lastBroadcast) : undefined;
    }

    public override get name(): string | undefined {
        return this.peripheral.advertisement.localName;
    }
}

export class BLELayer extends BaseLayer {
    public static override readonly descriptor: LayerDescriptor = {
        id: 'universal-ble',
        name: 'Bluetooth Low Energy',
        kind: LayerKind.BLE,
        canScan: true,
    } as const;

    private _isScanning: boolean = false;
    private _scanRequested: boolean = false;
    private _advertisementQueue: Map<
        string,
        {
            peripheral: Peripheral;
            devtype: string;
            advertisement: PeripheralAdvertisement;
        }
    > = new Map();
    private _advertisementHandle: NodeJS.Timeout | undefined = undefined;
    private _noble: Noble | undefined = undefined;

    // Store references to the bound functions to allow proper removal later
    private _handleNobleStateChangeBound: (state: string) => void;
    private _handleScanStartBound: () => void;
    private _handleScanStopBound: () => void;
    private _handleDiscoverBound: (peripheral: Peripheral) => void;

    public override supportsDevtype(_devtype: string) {
        return (
            PybricksBleClient.deviceType === _devtype ||
            HubOSBleClient.deviceType === _devtype
        );
    }

    public constructor(
        onStateChange?: (event: ConnectionStateChangeEvent) => void,
        onDeviceChange?: (event: DeviceChangeEvent) => void,
    ) {
        super(onStateChange, onDeviceChange);

        this._handleNobleStateChangeBound = (state: string) =>
            void this.handleNobleStateChange(state);
        this._handleScanStartBound = () => {
            this._isScanning = true;
            if (this._scanRequested) {
                this._scanRequested = false;
                setState(StateProp.Scanning, true);
            }
            this._advertisementHandle = setInterval(
                () => this.processAdvertisementQueue(),
                ADVERTISEMENT_POLL_INTERVAL_MS,
            );
        };
        this._handleScanStopBound = () => {
            this._isScanning = false;
            clearInterval(this._advertisementHandle);
            this._advertisementHandle = undefined;
        };
        this._handleDiscoverBound = (peripheral: Peripheral) => {
            if (!peripheral.advertisement.localName) return;

            const advertisement = _.cloneDeep(peripheral.advertisement);

            // Identify device type and id
            const isPybricks = advertisement.serviceUuids?.includes(
                UUIDu.to128(pybricksServiceUUID),
            );
            const isSpike = advertisement.serviceUuids?.includes(
                UUIDu.to16(SPIKE_SERVICE_UUID16),
            );
            const isPybricksAdv = advertisement.serviceData.some(
                (sd) => UUIDu.to16(pnpIdUUID) === sd.uuid,
            );

            if (
                !advertisement.localName ||
                (!isPybricks && !isSpike && !isPybricksAdv)
            ) {
                return;
            }

            const devtype =
                isPybricks || isPybricksAdv
                    ? PybricksBleClient.deviceType
                    : HubOSBleClient.deviceType;
            const targetid = DeviceMetadataWithPeripheral.generateId(
                devtype,
                advertisement.localName,
            );

            // Add to queue, replacing any previous advertisement for this device
            this._advertisementQueue.set(targetid, {
                peripheral,
                devtype,
                advertisement,
            });
        };
    }

    public override async initialize() {
        await super.initialize();

        const nobleModule = await import('@stoprocent/noble');
        this._noble = nobleModule?.withBindings('default'); // 'hci', 'win', 'mac'
        if (!this._noble) throw new Error('Noble module not loaded');

        this.state = ConnectionState.Disconnected; // initialized successfully

        this._noble.on('stateChange', this._handleNobleStateChangeBound);
        this._noble.on('scanStart', this._handleScanStartBound);
        this._noble.on('scanStop', this._handleScanStopBound);
        this._noble.on('discover', this._handleDiscoverBound);
    }

    public override async finalize(): Promise<void> {
        this.stopScanning();

        // Remove noble listeners
        if (this._noble) {
            this._noble.removeListener(
                'stateChange',
                this._handleNobleStateChangeBound,
            );
            this._noble.removeListener('scanStart', this._handleScanStartBound);
            this._noble.removeListener('scanStop', this._handleScanStopBound);
            this._noble.removeListener('discover', this._handleDiscoverBound);
        }
        clearInterval(this._advertisementHandle);
        this._advertisementHandle = undefined;

        await super.finalize();
        this._noble = undefined; // Clear noble reference
    }

    private processAdvertisementQueue() {
        // Debounce: process only the last advertisement after a short delay
        try {
            for (const [targetid, { peripheral, devtype, advertisement }] of this
                ._advertisementQueue) {
                this._advertisementQueue.delete(targetid);
                this.processAdvertisement(targetid, devtype, peripheral, advertisement);
            }
        } catch (e) {
            console.error('Error processing advertisement queue:', e);
        }
    }

    private processAdvertisement(
        targetid: string,
        devtype: string,
        peripheral: Peripheral,
        advertisement: PeripheralAdvertisement,
    ) {
        const metadata: DeviceMetadataWithPeripheral =
            (this._allDevices.get(targetid) as DeviceMetadataWithPeripheral) ??
            (() => {
                const newMetadata = new DeviceMetadataWithPeripheral(
                    devtype,
                    peripheral,
                    undefined,
                );

                // need to remove this as pybricks creates a random BLE id on each reconnect
                newMetadata.reuseAfterReconnect =
                    devtype !== PybricksBleClient.deviceType;

                this._allDevices.set(targetid, newMetadata);
                return newMetadata;
            })();
        // update peripheral reference (name might be tha same while peripheral changed)
        if (metadata.peripheral !== peripheral) metadata.peripheral = peripheral;

        // only update on (passive) advertisement data
        const isPybricksAdv = advertisement.serviceData
            ?.map((sd) => sd?.uuid)
            .includes(UUIDu.to16(pnpIdUUID));
        if (isPybricksAdv) {
            const manufacturerDataBuffer = advertisement.manufacturerData;
            const decoded = pybricksDecodeBleBroadcastData(manufacturerDataBuffer);
            if (
                hasState(StateProp.Connected) &&
                ConnectionManager.client?.id === metadata.id &&
                decoded &&
                (!metadata.lastBroadcast ||
                    JSON.stringify(metadata.lastBroadcast) !== JSON.stringify(decoded))
            ) {
                setStatusBarItem(
                    true,
                    `${ConnectionManager.client.name} ${JSON.stringify(decoded)}`,
                    ConnectionManager.client.description,
                );
            }
            metadata.lastBroadcast = decoded;
        } else {
            // ?? clear lastBroadcast
        }

        // update the validTill value
        const timeout_ms =
            Config.get<number>(
                ConfigKeys.DeviceVisibilityTimeoutSec,
                BLE_DEVICE_VISIBILITY_SEC_DEFAULT,
            ) * MILLISECONDS_IN_SECOND;
        metadata.validTill = Date.now() + timeout_ms;
        this._deviceChange.fire({ metadata, layer: this } satisfies DeviceChangeEvent);
        return metadata;
    }

    private handleNobleStateChange(state: string) {
        // state = <"unknown" | "resetting" | "unsupported" | "unauthorized" | "poweredOff" | "poweredOn">

        console.debug(`Noble state changed to: ${state}`);

        if (state === 'poweredOn' && hasState(StateProp.Scanning)) {
            this.restartScanning();
        }
        if (state === 'poweredOff') {
            this.stopScanning();
            // TODO: device cannot disconnect properly, revisit this later
            try {
                if (ConnectionManager.client?.parent === this) {
                    void ConnectionManager.client.disconnect().catch(console.error);
                }
            } catch {}
        }
    }

    public override async connect(id: string, devtype: string): Promise<void> {
        const metadata = this._allDevices.get(id);
        if (!metadata) throw new Error(`Device ${id} not found.`);

        switch (metadata.deviceType) {
            case PybricksBleClient.deviceType:
                BaseLayer.activeClient = new PybricksBleClient(
                    metadata as DeviceMetadataWithPeripheral,
                    this,
                );
                break;
            case HubOSBleClient.deviceType:
                BaseLayer.activeClient = new HubOSBleClient(metadata, this);
                break;
            default:
                throw new Error(`Unknown device type: ${metadata.deviceType}`);
        }

        await super.connect(id, devtype);
    }

    private restartScanning() {
        this.stopScanning();
        void this.startScanning();
    }

    public override async startScanning() {
        await this.waitForReadyPromise();

        this._allDevices.clear();

        // if there is an active connection, re-add it to keep the reference
        if (BaseLayer.activeClient?.connected && BaseLayer.activeClient.metadata) {
            this._allDevices.set(
                BaseLayer.activeClient.metadata.id,
                BaseLayer.activeClient.metadata,
            );
        }

        try {
            await this._noble?.startScanningAsync(
                // undefined,
                undefined,
                // [
                //     pybricksServiceUUID, // pybricks connect uuid
                //     uuid128(pnpIdUUID), // pybricks advertisement uuid
                //     SPIKE_SERVICE_UUID, // spike prime connect uuid
                //     '0000fd02-0000-1000-8000-00805f9b34fb',
                //     'fd02', // spike prime connect uuid (short)
                // ],
                // TODO: on windows short UUIDs do not work, check if this is still the case
                true,
            );
        } catch (error) {
            console.error('Error starting BLE scan:', error);
            this._scanRequested = true; // try again later
        }
    }

    public override waitForReadyPromise(): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            // if noble is already powered on, resolve immediately
            if (this._noble?.state === 'poweredOn') {
                if (this.state === ConnectionState.Initializing)
                    this.state = ConnectionState.Disconnected; // initialized successfully
                resolve();
                return;
            }

            // otherwise wait for noble to power on
            this._noble?.once('stateChange', (state) => {
                if (state === 'poweredOn') {
                    if (this.state === ConnectionState.Initializing)
                        this.state = ConnectionState.Disconnected; // initialized successfully
                    resolve();
                } else {
                    reject(new Error(`BLE state changed to ${state}, not poweredOn`));
                }
            });
        });
    }

    public override stopScanning() {
        this._noble?.stopScanning();
    }

    public override get scanning() {
        return this._isScanning;
    }

    public override get allDevices() {
        return this._allDevices;
    }
}
