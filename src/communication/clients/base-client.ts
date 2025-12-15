import * as vscode from 'vscode';

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
    private _onStdoutEmitter = new vscode.EventEmitter<string>();
    public readonly onStdout: vscode.Event<string> = this._onStdoutEmitter.event;

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

    public get allowTerminalInputEcho(): boolean {
        return true;
    }

    protected abstract write(data: Uint8Array): Promise<void>;

    public async updateDeviceNotifications(): Promise<void> {
        // NOOP
    }

    public async disconnect(): Promise<void> {
        try {
            console.debug('Disconnecting...');
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
        // this._metadata = undefined;

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

            if (!this.connected) throw new Error('Failed to connect to device');

            if (!this.name) throw new Error('Failed to get device name');

            logDebug(`✅ Connected to ${this.description}`);

            // intentional no await
            void Config.set(ConfigKeys.DeviceLastConnectedName, this.id);
        } catch (error) {
            logDebug(`❌ Failed to connect to device`);
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

    private async stdoutLineHandler(text: string) {
        this._onStdoutEmitter.fire(text);
        logDebugFromHub(text, undefined, undefined, false);
        await handleStdOutDataHelpers(text);
    }

    protected async processStdoutData() {
        if (this._stdoutBuffer.length > 0) {
            const remaining = this._stdoutBuffer;

            await this.stdoutLineHandler(remaining);
            // this._onStdoutEmitter.fire(remaining);
            // logDebugFromHub(remaining, undefined, undefined, false);
            // await handleStdOutDataHelpers(remaining);

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

            await this.stdoutLineHandler(line);
            // this._onStdoutEmitter.fire(line);
            // logDebugFromHub(line, undefined, undefined, false);
            // await handleStdOutDataHelpers(line);
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

    public async action_upload(
        _data: Uint8Array,
        _slot: number,
        _filename?: string,
        _progressCb?: (incrementPct: number) => void,
    ) {}

    /// Wait for REPL output that starts with the given string, with a timeout
    public async readReplOutputLine(
        lineStartsWith: string,
        timeoutMs: number = 10000,
    ): Promise<string | undefined> {
        if (!this.connected) return;

        return new Promise((resolve) => {
            let timeoutHandle: NodeJS.Timeout | undefined;
            let disposable: vscode.Disposable | undefined;
            let resolved = false;

            const cleanup = () => {
                if (timeoutHandle) clearTimeout(timeoutHandle);
                if (disposable) disposable.dispose();
            };

            const resolveOnce = (value: string | undefined) => {
                if (!resolved) {
                    resolved = true;
                    cleanup();
                    resolve(value);
                }
            };

            // Set up timeout
            timeoutHandle = setTimeout(() => {
                resolveOnce(undefined);
            }, timeoutMs);

            // Listen for stdout
            disposable = this.onStdout((data: string) => {
                const trimmed = data.trim();
                if (trimmed.startsWith(lineStartsWith)) {
                    const result = trimmed.substring(lineStartsWith.length).trim();
                    resolveOnce(result);
                }
            });
        });
    }
}
