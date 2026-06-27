import * as vscode from 'vscode';
import { ConnectionManager } from '../communication/connection-manager';
import { DebugTunnel } from '../debug-tunnel/debug-tunnel';
import { extensionContext } from '../extension';
import { hasState, StateProp } from '../logic/state';
import { onTerminalUserInput } from '../logic/stdin-helper';
import { currentErrorFrame, isErrorOutput } from '../logic/stdout-python-error-helper';
import { getIcon } from './utils';

const RECENT_HUB_STDOUT_MAX_CHARS = 32 * 1024;
let recentHubStdout = '';

function appendRecentHubStdout(text: string) {
    recentHubStdout += text;
    if (recentHubStdout.length > RECENT_HUB_STDOUT_MAX_CHARS) {
        recentHubStdout = recentHubStdout.slice(-RECENT_HUB_STDOUT_MAX_CHARS);
    }
}

export function getRecentHubStdout(maxChars = 2048): string {
    if (maxChars <= 0) return '';
    return recentHubStdout.slice(-maxChars);
}

export function clearRecentHubStdout() {
    recentHubStdout = '';
}

export class DebugTerminal implements vscode.Pseudoterminal {
    public static _instance: DebugTerminal | undefined;
    public static Instance(): DebugTerminal {
        if (!this._instance) {
            // create terminal
            this._instance = new DebugTerminal(extensionContext);
            this._instance.onUserInput = (input) => void onTerminalUserInput(input);
            this._instance.setCloseCallback(() => {
                this._instance = undefined;
                // handle terminal closed by user, any subsequent usage will reopen it
            });
        }
        return this._instance;
    }

    public static async WaitForReady() {
        // return this.instance !== undefined && !!this.instance.terminal?.processId;
        await this._instance?.terminal.processId;
    }

    terminal: vscode.Terminal;
    private _readyFlag = false;
    private _terminalWriteQueue: { message: string; color: string | undefined }[] = [];
    onUserInput?: (input: string) => void;
    private closeCallback?: () => void;
    private readonly writeEmitter = new vscode.EventEmitter<string>();
    readonly onDidWrite: vscode.Event<string> = this.writeEmitter.event;
    private readonly closeEmitter = new vscode.EventEmitter<void>();
    readonly onDidClose: vscode.Event<void> = this.closeEmitter.event;

    constructor(private context: vscode.ExtensionContext) {
        this.terminal = vscode.window.createTerminal({
            name: 'BlocklyPy Debug Terminal',
            pty: this,
            iconPath: getIcon(
                {
                    light: 'asset/icons/icon-light.svg',
                    dark: 'asset/icons/icon-dark.svg',
                },
                this.context,
            ),
            isTransient: false,
        } as vscode.ExtensionTerminalOptions);

        this.terminal.processId.then(
            (pid) => {
                this._readyFlag = !!pid;
                for (const item of this._terminalWriteQueue) {
                    this.write(item.message, item.color);
                }
            },
            () => {
                this._readyFlag = false;
                this._terminalWriteQueue = [];
            },
        );

        const onCloseDisp = vscode.window.onDidCloseTerminal((closedTerminal) => {
            if (closedTerminal === this.terminal && this.closeCallback) {
                this.closeCallback();
            }
        });
        this.context.subscriptions.push(onCloseDisp);

        // First line when this terminal is created (no Terminal.show — avoids focusing on Python activation)
        this.handleDataFromExtension('🚀 BlocklyPy Commander started up successfully.');
    }

    open(_initialDimensions: vscode.TerminalDimensions | undefined): void {
        // NOOP
    }

    close(): void {
        this.closeEmitter.fire();
    }

    public handleInput(data: string) {
        // built-in name, do not change the name
        this.handleInputFromTerminal(data);
    }
    handleInputFromTerminal(data: string) {
        if (!this.onUserInput) return; // ignore input if no callback is set, this is how we send to the BLE device
        if (!hasState(StateProp.Running)) return; // ignore input if user program is not not running

        this.onUserInput(data); // send to BLE device

        if (ConnectionManager.client?.allowTerminalInputEcho)
            this.write(data, '\x1b[32m' /* green */);
    }

    public handleDataFromHubOutput(
        message: string,
        prio: boolean = false,
        addNewLine = true,
    ) {
        this.write(
            message + (addNewLine ? '\r\n' : ''),
            prio ? '\x1b[31m' /* red */ : '\x1b[34m' /* blue */,
        );
    }
    public handleDataFromExtension(message: string) {
        this.write(message + '\r\n', undefined);
    }

    setCloseCallback(cb: () => void) {
        this.closeCallback = cb;
    }

    public show(preserveFocus?: boolean) {
        this.terminal?.show(preserveFocus);
    }

    private write(message: string, color: string | undefined) {
        // this.hideInputIndicator();
        message = message.replace(/\r\n?/g, '\r\n');
        const isempty = message === '\r\n' || message.trim() === '';

        if (this._readyFlag) {
            this.writeEmitter.fire(
                (color && !isempty ? color : '') +
                    message +
                    (color && !isempty ? '\x1b[0m' : ''),
            );
        } else {
            this._terminalWriteQueue.push({ message, color });
            // try to flush queue
        }
    }
}

/** Creates the BlocklyPy debug terminal if needed (e.g. when connecting to a hub). */
export function ensureDebugTerminal(): DebugTerminal {
    return DebugTerminal.Instance();
}

export function registerDebugTerminal(context: vscode.ExtensionContext) {
    context.subscriptions.push({
        dispose: () => {
            if (DebugTerminal._instance) {
                DebugTerminal._instance.onUserInput = undefined;
                DebugTerminal._instance.close();
            }
            DebugTerminal._instance = undefined;
        },
    });
}

export function clearDebugLog() {
    if (!DebugTerminal._instance) {
        return;
    }
    clearRecentHubStdout();
    DebugTerminal._instance.handleDataFromHubOutput('\x1bc', false, false); // ANSI escape code to clear terminal
}

export function logDebug(
    message: string,
    filepath?: string,
    line: number | undefined = undefined,
    show: boolean = false,
) {
    if (DebugTunnel.isDebugging()) {
        filepath = DebugTunnel._runtime?.getFilePath(filepath ?? '');
        DebugTunnel._runtime?.output(message, 'console', filepath, line);
        if (show)
            void vscode.commands.executeCommand(
                'workbench.action.debug.selectDebugConsole',
            );
    } else {
        if (!DebugTerminal._instance) {
            return;
        }
        if (show) {
            DebugTerminal._instance.show(true);
        }
        DebugTerminal._instance.handleDataFromExtension(message);
    }
}

export function logDebugFromHub(
    message: string,
    filepath?: string,
    line?: number,
    linebreak = true,
) {
    appendRecentHubStdout(message);
    if (DebugTunnel.isDebugging()) {
        filepath = DebugTunnel._runtime?.getFilePath(
            filepath ?? currentErrorFrame?.filename ?? '',
        );
        line = line ?? currentErrorFrame?.line ?? undefined;
        DebugTunnel._runtime?.output(
            message,
            !isErrorOutput(message) ? 'out' : 'err',
            filepath,
            line,
            !linebreak,
        );
    } else {
        ensureDebugTerminal().handleDataFromHubOutput(
            message,
            isErrorOutput(message),
            linebreak,
        );
    }
}
