import * as vscode from 'vscode';
import { ConnectionState, DeviceMetadata } from '.';
import { connectDeviceAsync } from '../commands/connect-device';
import Config, { ConfigKeys, FeatureFlags } from '../extension/config';
import { showWarning } from '../extension/diagnostics';
import { TreeDP } from '../extension/tree-commands';
import { hasState, setState, StateProp } from '../logic/state';
import { setLastDeviceNotificationPayloads } from '../user-hooks/device-notification-hook';
import { sleep } from '../utils';
import {
    BaseLayer,
    ConnectionStateChangeEvent,
    DeviceChangeEvent,
    LayerKind,
} from './layers/base-layer';

export const CONNECTION_TIMEOUT_DEFAULT = 15000;
export const RSSI_REFRESH_WHILE_CONNECTED_INTERVAL = 5000;
export const DEVICE_VISIBILITY_WAIT_TIMEOUT = 15000;

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

    public static async initialize(layers: (typeof BaseLayer)[] = []) {
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
        await ConnectionManager.autoConnectOnInit();
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

        TreeDP.refresh();
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

        TreeDP.refresh();
    }

    public static stopScanning() {
        this.getLayers(true).forEach((layer) => layer.stopScanning());
        setState(StateProp.Scanning, false);
        TreeDP.refresh();
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
        // Return the first found device id, or throw if none found
        const foundId = await Promise.race(promises);
        return foundId;
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
