import * as vscode from 'vscode';
import { debugLogEventEmitter, debugLogEventFromHubEmitter } from '.';
import { DebugTunnel } from '../debug-tunnel/debug-tunnel';
import { hasState, StateProp } from '../logic/state';
import { currentErrorFrame, isErrorOutput } from '../logic/stdout-python-error-helper';
import { getIcon } from './utils';

let debugTerminal: DebugTerminal | undefined;
export { debugTerminal };

class DebugTerminal implements vscode.Pseudoterminal {
    terminal: vscode.Terminal;
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

        vscode.window.onDidCloseTerminal((closedTerminal) => {
            if (closedTerminal === this.terminal && this.closeCallback) {
                this.closeCallback();
            }
        });
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

        this.writeEmitter.fire(
            (color && !isempty ? color : '') +
                message +
                (color && !isempty ? '\x1b[0m' : ''),
        );
    }
}

export async function registerDebugTerminal(
    context: vscode.ExtensionContext,
    onUserInput?: (input: string) => void,
) {
    // create terminal
    debugTerminal = new DebugTerminal(context);
    debugTerminal.onUserInput = onUserInput;
    debugTerminal.show(true);
    debugTerminal.setCloseCallback(() => {
        debugTerminal = undefined;
        //TODO: handle terminal closed by user, maybe reopen it again?
    });
    // vscode.window.activeTerminal = debugTerminal.terminal;
    await debugTerminal.terminal.processId;
    // Terminal is ready to accept input

    // // register stdout helpers
    // registerStdoutHelper();

    // Return a disposable that closes the terminal when disposed
    context.subscriptions.push({
        dispose: () => {
            if (debugTerminal) debugTerminal.onUserInput = undefined;
            debugTerminal?.close();
            debugTerminal = undefined;
        },
    });
}

export function clearDebugLog() {
    debugTerminal?.handleDataFromHubOutput('\x1bc', false, false); // ANSI escape code to clear terminal
}

debugLogEventEmitter.event(({ message, filepath, line, show }) => {
    if (DebugTunnel.isDebugging()) {
        filepath = DebugTunnel._runtime?.getFilePath(filepath ?? '');
        DebugTunnel._runtime?.output(message, 'console', filepath, line);
        if (show)
            vscode.commands.executeCommand('workbench.action.debug.selectDebugConsole');
    } else if (debugTerminal) {
        if (show) debugTerminal.show(true);
        debugTerminal.handleDataFromExtension(message);
    }
});

debugLogEventFromHubEmitter.event(({ message, filepath, line, linebreak }) => {
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
    } else if (debugTerminal) {
        debugTerminal.handleDataFromHubOutput(
            message,
            isErrorOutput(message),
            linebreak,
        );
    }
});
