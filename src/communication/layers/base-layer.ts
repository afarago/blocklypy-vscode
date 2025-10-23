import * as vscode from 'vscode';
import { ConnectionState, DeviceMetadata } from '..';
import Config, { ConfigKeys } from '../../extension/config';
import { logDebug } from '../../extension/debug-channel';
import { TreeDP } from '../../extension/tree-commands';
import { maybe } from '../../pybricks/utils';
import { sleep } from '../../utils';
import { withTimeout } from '../../utils/async';
import { BaseClient } from '../clients/base-client';
import { PybricksBleClient } from '../clients/pybricks-ble-client';
import { CONNECTION_TIMEOUT_DEFAULT } from '../connection-manager';

export type ConnectionStateChangeEvent = {
    client?: BaseClient;
    state: ConnectionState;
};
export type DeviceChangeEvent = {
    metadata: DeviceMetadata;
    layer: BaseLayer;
};

export enum LayerType {
    BLE = 'ble-layer',
    USB = 'usb-layer',
}
export class BaseLayer {
    protected static activeClient: BaseClient | undefined = undefined;

    public static readonly name: LayerType;
    private _state: ConnectionState = ConnectionState.Initializing;
    protected _allDevices = new Map<string, DeviceMetadata>();
    protected _exitStack: (() => Promise<void> | void)[] = [];
    protected _stateChange = new vscode.EventEmitter<ConnectionStateChangeEvent>();
    protected _deviceChange = new vscode.EventEmitter<DeviceChangeEvent>();

    public get name() {
        return (this.constructor as typeof BaseLayer).name;
    }

    public constructor(
        onStateChange?: (event: ConnectionStateChangeEvent) => void,
        onDeviceChange?: (event: DeviceChangeEvent) => void,
    ) {
        if (onStateChange) this._stateChange.event(onStateChange);
        if (onDeviceChange) this._deviceChange.event(onDeviceChange);
    }

    public static get ActiveClient() {
        return this.activeClient;
    }

    public get state() {
        return this._state;
    }

    public get ready() {
        return this._state !== ConnectionState.Initializing;
    }

    protected set state(newState: ConnectionState) {
        if (this._state === newState) return;
        this._state = newState;
        this._stateChange.fire({ client: BaseLayer.activeClient, state: this._state });
    }

    public get scanning(): boolean {
        return false;
    }
    public async initialize(): Promise<void> {
        // NOOP
    }

    public supportsDevtype(_devtype: string) {
        return false;
    }

    public async connect(id: string, devtype: string) {
        if (!BaseLayer.activeClient) throw new Error('Client not initialized');
        if (BaseLayer.activeClient.connected) await this.disconnect();

        const metadata = this._allDevices.get(id);
        if (!metadata || metadata.deviceType !== devtype)
            throw new Error(`Device ${id} not found with ${devtype}.`);

        try {
            this.state = ConnectionState.Connecting;
            const [_, error] = await maybe(
                withTimeout(
                    BaseLayer.activeClient
                        .connect(
                            (device) => {
                                this._deviceChange.fire({
                                    metadata: device,
                                    layer: this,
                                } satisfies DeviceChangeEvent);
                            },
                            (_device) => {
                                // need to remove this as pybricks creates a random BLE id on each reconnect
                                if (
                                    _device.deviceType ===
                                        PybricksBleClient.deviceType &&
                                    !!id
                                )
                                    this._allDevices.delete(id);

                                this.state = ConnectionState.Disconnected;
                                // setState(StateProp.Connected, false);
                                // setState(StateProp.Connecting, false);
                                // setState(StateProp.Running, false);
                                TreeDP.refresh();
                            },
                        )
                        .catch((err) => {
                            console.error('Error during client.connect:', err);
                            throw err;
                        }),
                    Config.get<number>(
                        ConfigKeys.ConnectionTimeout,
                        CONNECTION_TIMEOUT_DEFAULT,
                    ),
                ),
            );
            if (error) throw error;

            this._exitStack.push(() => {
                console.debug('Running cleanup function after disconnect');
                this.state = ConnectionState.Disconnected;
                this.removeClient(BaseLayer.activeClient);
            });

            if (BaseLayer.activeClient.connected !== true)
                throw new Error('Client failed to connect for unknown reason.');

            this.state = ConnectionState.Connected;
        } catch (error) {
            console.error('Error during connect:', error);
            this.state = ConnectionState.Disconnected;
            await this.runExitStack();
            await this.disconnect();
            this.removeClient(BaseLayer.activeClient);

            // NOTE: consider: on connect error, maybe remove device so that rescan can find it again
            // would be a problem for non polled (e.g. hotplug) layers
            throw error;
        }

        if (this.state !== ConnectionState.Connected) {
            await this.disconnect();
            throw new Error(`Failed to connect to ${id} with ${devtype}.`);
        }
    }

    public async disconnect() {
        if (!BaseLayer.activeClient) return;

        try {
            this.state = ConnectionState.Disconnecting;
            await BaseLayer.activeClient.disconnect();
            await this.runExitStack();
        } catch (error) {
            logDebug(`Error during disconnectAsync: ${String(error)}`);
        }
        this.removeClient(BaseLayer.activeClient);
        this.state = ConnectionState.Disconnected;

        await sleep(500);
    }

    private async runExitStack() {
        for (const fn of this._exitStack) {
            try {
                await fn();
            } catch (error) {
                logDebug(`Error during cleanup function : ${String(error)}`);
            }
        }
        this._exitStack = [];
    }

    public onDeviceChange(fn: (event: DeviceChangeEvent) => void) {
        return this._deviceChange.event(fn);
    }
    public handleDeviceChange(event: DeviceChangeEvent) {
        this._deviceChange.fire(event);
    }

    public get allDevices() {
        return this._allDevices;
    }

    public hasDevice(id: string): boolean {
        return this._allDevices.has(id);
    }

    public getDeviceById(id: string): DeviceMetadata | undefined {
        return this._allDevices.get(id);
    }

    public waitForReadyPromise(): Promise<void> {
        throw new Error('Not implemented');
    }

    public waitTillAnyDeviceAppearsAsync(
        ids: string[],
        timeout: number,
    ): Promise<string | undefined> {
        // if already present (id or layer name matches)
        let found = ids.find((id) => this._allDevices.has(id));
        if (!found && this._allDevices.size > 0 && ids.includes(this.name)) {
            found = this._allDevices.keys().next().value;
        }
        if (found) return Promise.resolve(found);

        // wait for event
        const start = Date.now();
        return new Promise<string>((resolve, reject) => {
            const listener = this.onDeviceChange((event: DeviceChangeEvent) => {
                if (ids.includes(event.metadata.id) || ids.includes(event.layer.name)) {
                    listener.dispose();
                    resolve(event.metadata.id);
                } else if (Date.now() - start > timeout) {
                    // TODO: revisit
                    listener.dispose();
                    reject(new Error('Timeout waiting for device'));
                }
            });
        });
    }

    public stopScanning(): void {
        // NOOP
    }
    public async startScanning(): Promise<void> {
        // NOOP
    }

    public removeClient(client?: BaseClient) {
        const id = client?.id;
        if (id === BaseLayer.activeClient?.id) BaseLayer.activeClient = undefined;
    }
}
