import * as vscode from 'vscode';
import { ConnectionState, DEVICE_VISIBILITY_WAIT_TIMEOUT } from '.';
import { connectDeviceAsync } from '../commands/connect-device';
import { RefreshTree } from '../extension';
import Config, { ConfigKeys, FeatureFlags } from '../extension/config';
import { showWarning } from '../extension/diagnostics';
import { hasState, setState, StateProp } from '../logic/state';
import { setLastDeviceNotificationPayloads } from '../user-hooks/device-notification-hook';
import { sleep } from '../utils';
import { DeviceMetadata, LayerKind } from './layers';
import {
    BaseLayer,
    ConnectionStateChangeEvent,
    DeviceChangeEvent,
} from './layers/base-layer';

export class ConnectionManager {
    private static busy = false;
    private static layers: BaseLayer[] = [];
    private static _deviceChange = new vscode.EventEmitter<DeviceChangeEvent>();

    public static get allDevices() {
        const devices: {
            id: string;
            name: string;
            deviceType: string;
            metadata: DeviceMetadata;
        }[] = [];
        for (const layer of this.layers) {
            for (const [name, metadata] of layer.allDevices.entries()) {
                devices.push({
                    id: metadata.id,
                    name,
                    deviceType: metadata.deviceType,
                    metadata,
                });
            }
        }
        return devices;
    }

    public static get client() {
        return BaseLayer.ActiveClient;
    }

    public static async initialize(layers: (typeof BaseLayer)[] = []): Promise<void> {
        // Initialization code here

        for (const layerCtor of layers) {
            try {
                const instance = new layerCtor(
                    (event) => ConnectionManager.handleStateChange(event),
                    (event) => ConnectionManager.handleDeviceChange(event),
                );
                await instance.initialize();
                this.layers.push(instance);
                console.log(`Successfully initialized ${instance.descriptor.kind}.`);
            } catch (e) {
                console.error(`Failed to initialize ${layerCtor.name}:`, e);
            }
        }

        await sleep(500); // wait a bit for layers to settle
        return ConnectionManager.autoConnectOnInit();
    }

    public static async connect(id: string, devtype: string) {
        if (this.busy) throw new Error('Connection manager is busy, try again later');
        this.busy = true;
        try {
            for (const layer of this.layers) {
                if (layer.supportsDevtype(devtype)) {
                    await layer.connect(id, devtype);
                    return;
                }
            }
        } catch (error) {
            showWarning(`Failed to connect to device ${id}. Error: ${String(error)}`);
        } finally {
            this.busy = false;
        }
    }

    public static async disconnect() {
        if (this.busy) throw new Error('Connection manager is busy, try again later');
        this.busy = true;
        try {
            if (BaseLayer.ActiveClient?.connected) {
                await BaseLayer.ActiveClient?.parent?.disconnect();
            }
        } catch (error) {
            showWarning(`Failed to disconnect from device: ${String(error)}`);
        } finally {
            this.busy = false;
        }
    }

    public static async connectManuallyOnLayer(layerid?: string) {
        if (this.busy) throw new Error('Connection manager is busy, try again later');

        this.busy = true;
        try {
            const targetLayer = this.layers.find(
                (layer) => layer.descriptor.id === layerid,
            );
            await targetLayer?.manualConnect();
        } finally {
            this.busy = false;
        }
    }

    public static finalize() {
        this.stopScanning();
    }

    private static handleStateChange(event: ConnectionStateChangeEvent) {
        if (event.client === this.client && event.client !== undefined) {
            setState(
                StateProp.Connected,
                event.state === ConnectionState.Connected &&
                    event.client.connected === true,
            );
            setState(StateProp.Connecting, event.state === ConnectionState.Connecting);

            // when connected, stop scanning
            if (event.state === ConnectionState.Connected) {
                this.stopScanning();
                setLastDeviceNotificationPayloads(undefined);
            }
        } else if (event.client !== undefined) {
            console.log(
                `Ignoring state change from non-active client: ${event.client?.id} (${event.state})`,
            );
            return;
        }

        RefreshTree();
    }

    private static handleDeviceChange(event: DeviceChangeEvent) {
        ConnectionManager._deviceChange.fire(event);
    }

    public static get canScan(): boolean {
        return this.layers.some((layer) => layer.descriptor.canScan);
    }
    public static getLayers(canScan: boolean) {
        return this.layers.filter((layer) => layer.descriptor.canScan === canScan);
    }

    public static async startScanning() {
        if (!this.layers.some((layer) => layer.descriptor.canScan)) {
            return;
        }

        setState(StateProp.Scanning, true);

        await Promise.all(
            this.getLayers(true).map(async (layer) => {
                if (!layer.ready) return;
                await layer.startScanning();
            }),
        );

        RefreshTree();
    }

    public static stopScanning() {
        this.getLayers(true).forEach((layer) => layer.stopScanning());
        setState(StateProp.Scanning, false);
        RefreshTree();
    }

    public static waitForReadyPromise(): Promise<void[]> {
        // Wait for any layer to be ready using Promise.race
        const readyPromises = this.layers
            .map((layer) => layer.waitForReadyPromise?.())
            .filter(Boolean);
        return Promise.all<void>(readyPromises);
    }

    public static async waitTillAnyDeviceAppearsAsync(
        ids: string[],
        timeout: number,
    ): Promise<string | undefined> {
        // const targetlayer = this.layers.find((l) => l.supportsDevtype(devtype));

        // if (targetlayer)
        //     await targetlayer.waitTillDeviceAppearsAsync(id, devtype, timeout);
        const promises = this.layers.map((layer) =>
            layer.waitTillAnyDeviceAppearsAsync(ids, timeout),
        );

        if (promises.length === 0) return undefined;

        // Resolve with the first fulfilled promise, ignore individual rejections,
        // and reject if all promises reject.
        return new Promise<string | undefined>((resolve, reject) => {
            const errors: unknown[] = [];
            let rejected = 0;

            for (const p of promises) {
                p.then((id) => resolve(id)).catch((err) => {
                    errors.push(err);
                    rejected++;
                    if (rejected === promises.length) {
                        reject(
                            new AggregateError(
                                errors,
                                'All waitTillAnyDeviceAppearsAsync calls rejected',
                            ),
                        );
                    }
                });
            }
        });
    }

    public static onDeviceChange(
        fn: (event: DeviceChangeEvent) => void,
    ): vscode.Disposable {
        return this._deviceChange.event(fn);
    }

    public static async autoConnectOnInit() {
        await ConnectionManager.waitForReadyPromise();
        // await Device.startScanning();

        const autoconnectIds: string[] = [];

        if (Config.FeatureFlag.get(FeatureFlags.AutoConnectFirstUSBDevice)) {
            // autoconnect to first USB device
            // find usb layer
            const usbLayer = this.layers.find(
                (layer) => layer.descriptor.kind === LayerKind.USB,
            );
            if (usbLayer) autoconnectIds.push(usbLayer.descriptor.kind!); // connect to any device of
        }

        if (
            Config.get<boolean>(ConfigKeys.DeviceAutoConnectLast) &&
            Config.get<string>(ConfigKeys.DeviceLastConnectedName)
        ) {
            // autoconnect to last connected device
            const id = Config.get<string>(ConfigKeys.DeviceLastConnectedName);
            // const { devtype } = Config.decodeDeviceKey(id);
            autoconnectIds.push(id);
        }

        const id = await ConnectionManager.waitTillAnyDeviceAppearsAsync(
            autoconnectIds,
            DEVICE_VISIBILITY_WAIT_TIMEOUT,
        );
        if (id && !hasState(StateProp.Connected) && !hasState(StateProp.Connecting)) {
            const { devtype } = Config.decodeDeviceKey(id);
            await connectDeviceAsync(id, devtype);
        }
    }
}
