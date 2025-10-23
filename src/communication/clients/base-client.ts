import { DeviceMetadata } from '..';
import Config, { ConfigKeys } from '../../extension/config';
import { logDebug, logDebugFromHub } from '../../extension/debug-channel';
import { clearPythonErrors } from '../../extension/diagnostics';
import { handleStdOutDataHelpers } from '../../logic/stdout-helper';
import { BaseLayer, LayerKind } from '../layers/base-layer';

export interface ClientClassDescriptor {
    deviceType: string;
    description: string;
    supportsModularMpy: boolean;
    requiresSlot: boolean;
    os: DeviceOSType | undefined;
    layer: LayerKind;
}

export enum DeviceOSType {
    HubOS = 'hubos',
    Pybricks = 'pybricks',
}

export enum StartMode {
    REPL = 'repl',
}

export abstract class BaseClient {
    static readonly classDescriptor: ClientClassDescriptor;

    protected _exitStack: (() => Promise<void> | void)[] = [];
    private _stdoutBuffer: string = '';
    private _stdoutTimer: NodeJS.Timeout | undefined = undefined;
    protected _slot: number | undefined;

    constructor(
        protected _metadata: DeviceMetadata | undefined,
        public parent: BaseLayer,
    ) {}

    public get classDescriptor(): ClientClassDescriptor {
        return (this.constructor as typeof BaseClient).classDescriptor;
    }
    public static get deviceType() {
        return this.classDescriptor.deviceType;
    }
    public get deviceType() {
        return (this.constructor as typeof BaseClient).classDescriptor.deviceType;
    }
    public get deviceOS() {
        return (this.constructor as typeof BaseClient).classDescriptor.os;
    }
    public get isPybricks() {
        return this.deviceOS === DeviceOSType.Pybricks;
    }
    public get isHubOS() {
        return this.deviceOS === DeviceOSType.HubOS;
    }

    public get metadata() {
        return this._metadata;
    }

    public get name(): string | undefined {
        return this._metadata?.name;
    }

    public get id(): string | undefined {
        return this._metadata?.id;
    }

    public get description(): string {
        const items = [
            this.name,
            ...this.descriptionKVP.map(([key, value]) => `${key}: ${value}`),
        ];
        return items.join(', ');
    }

    public abstract get descriptionKVP(): [string, string][];

    public abstract get connected(): boolean;

    public get uniqueSerial(): string | undefined {
        return undefined;
    }

    public get slot(): number | undefined {
        return this._slot;
    }
    public get slotName(): string | undefined {
        return this._slot !== undefined ? String(this._slot) : undefined;
    }

    public abstract write(data: Uint8Array, withoutResponse: boolean): Promise<void>;

    public async updateDeviceNotifications(): Promise<void> {
        // NOOP
    }

    public async disconnect(): Promise<void> {
        try {
            console.log('Disconnecting...');
            await this.runExitStack();
            await this.disconnectWorker();
        } catch (error) {
            logDebug(`Error during disconnect: ${String(error)}`);
        }
    }

    protected async disconnectWorker(): Promise<void> {
        // Override in subclass if needed
        return Promise.resolve();
    }

    protected async handleDisconnectAsync(_id: string) {
        logDebug(`Disconnected from ${this.name}`);
        clearPythonErrors();
        // Do not call disconnectAsync recursively
        await this.runExitStack();
        this._metadata = undefined;

        // notify parent layer
        this.parent.removeClient(this);
    }

    public async connect(
        onDeviceUpdated: (device: DeviceMetadata) => void | undefined,
        onFinalizing: (device: DeviceMetadata) => void | undefined,
    ): Promise<void> {
        try {
            await this.runExitStack();

            await this.connectWorker(onDeviceUpdated, onFinalizing);

            if (!this.name) throw new Error('Failed to get device name');

            logDebug(`✅ Connected to ${this.description}`);

            await Config.set(ConfigKeys.DeviceLastConnectedName, this.id);
        } catch (error) {
            await this.disconnect();
            this._metadata = undefined;
            throw error;
        }
    }

    protected abstract connectWorker(
        onDeviceUpdated: (device: DeviceMetadata) => void | undefined,
        onFinalizing: (device: DeviceMetadata) => void | undefined,
    ): Promise<void>;

    protected async runExitStack() {
        for (const fn of this._exitStack) {
            try {
                await fn();
            } catch (error) {
                logDebug(`Error during cleanup function : ${String(error)}`);
            }
        }
        this._exitStack = [];
    }

    protected abstract handleIncomingData(data: Buffer): Promise<void>;

    protected async processStdoutData() {
        if (this._stdoutBuffer.length > 0) {
            await handleStdOutDataHelpers(this._stdoutBuffer);
            this._stdoutBuffer = '';
        }
        if (this._stdoutTimer) {
            clearTimeout(this._stdoutTimer);
            this._stdoutTimer = undefined;
        }
    }

    protected async handleWriteStdout(text: string) {
        // logDebugFromHub(text, undefined, undefined, false);

        this._stdoutBuffer += text;

        // Flush after every newline
        let newlineIndex;
        while ((newlineIndex = this._stdoutBuffer.indexOf('\n')) !== -1) {
            const line = this._stdoutBuffer.slice(0, newlineIndex + 1);
            this._stdoutBuffer = this._stdoutBuffer.slice(newlineIndex + 1);

            // log incoming data
            logDebugFromHub(line, undefined, undefined, false);

            // TODO: add queue handling/detaching
            await handleStdOutDataHelpers(line);
        }

        // Set/reset 500ms timeout for any remaining partial line
        if (this._stdoutTimer) clearTimeout(this._stdoutTimer);
        if (this._stdoutBuffer.length > 0) {
            this._stdoutTimer = setTimeout(() => {
                void this.processStdoutData().then(() => {
                    this._stdoutTimer = undefined;
                });
            }, 500);
        }
    }

    // eslint-disable-next-line @typescript-eslint/require-await
    public async sendTerminalUserInputAsync(_text: string): Promise<void> {
        // Override in subclass if needed
        throw new Error('sendTerminalUserInput not implemented');
    }

    public async action_start(_slot?: number | StartMode, _replContent?: string) {}

    public async action_stop() {}

    public async action_upload(_data: Uint8Array, _slot: number, _filename?: string) {}

    // eslint-disable-next-line @typescript-eslint/require-await
    public async action_move_slot(_from: number, _to: number): Promise<boolean> {
        throw new Error('action_move_slot not implemented');
    }

    // eslint-disable-next-line @typescript-eslint/require-await
    public async action_clear_slot(_slot: number): Promise<boolean> {
        throw new Error('Not implemented');
    }

    // eslint-disable-next-line @typescript-eslint/require-await
    public async action_clear_all_slots(): Promise<{
        completed: number[];
        failed: number[];
    }> {
        throw new Error('Not implemented');
    }

    // eslint-disable-next-line @typescript-eslint/require-await
    public async action_sendAppData(_data: ArrayBuffer) {
        throw new Error('Not implemented');
    }
}
