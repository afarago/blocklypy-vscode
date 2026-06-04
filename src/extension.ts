import * as vscode from 'vscode';
import { disconnectDeviceAsync } from './commands/disconnect-device';
import { stopUserProgramAsync } from './commands/stop-user-program';
import { ConnectionManager } from './communication/connection-manager';
import { BaseLayer } from './communication/layers/base-layer';
import { BLELayer } from './communication/layers/ble-layer';
import { USBLayer } from './communication/layers/usb-layer';
import { MILLISECONDS_IN_SECOND } from './const';
import { registerDebugTunnel } from './debug-tunnel/debug-tunnel';
import { registerPybricksTunnelDebug } from './debug-tunnel/register';
import { Commands, registerCommands } from './extension/commands';
import Config, { ConfigKeys, FeatureFlags, registerConfig } from './extension/config';
import { registerContextUtils } from './extension/context-utils';
import { registerDebugTerminal } from './extension/debug-channel';
import { clearPythonErrors } from './extension/diagnostics';
import { registerCommandsTree } from './extension/tree-commands';
import { registerUriHandler } from './extension/uri-handler';
import { wrapErrorHandling } from './extension/utils';
import { checkMagicHeaderComment } from './logic/compile';
import { hasState, StateProp } from './logic/state';
import { registerMicroPythonNotebookController } from './notebook/blocklypy-micropython-kernel';
import { plotManager } from './plot/plot';
import { BlocklypyViewerProvider } from './views/BlocklypyViewerProvider';
import { DatalogView } from './views/DatalogView';
import { PythonPreviewProvider } from './views/PythonPreviewProvider';

export let isDevelopmentMode: boolean;
export let extensionContext: vscode.ExtensionContext;
let lastAutostartTimestamp = 0;

const AUTOSTART_DEBOUNCE_MS = 1 * MILLISECONDS_IN_SECOND;

// eslint-disable-next-line @typescript-eslint/require-await
export async function activate(context: vscode.ExtensionContext): Promise<void> {
    extensionContext = context;
    isDevelopmentMode = context.extensionMode === vscode.ExtensionMode.Development;

    // First, register all commands explicitly
    registerCommands(context);
    registerConfig(context);

    // register webview providers
    context.subscriptions.push(
        BlocklypyViewerProvider.register(
            context,
            BlocklypyViewerProvider,
            BlocklypyViewerProvider.TypeKey,
        ),
    );
    context.subscriptions.push(
        PythonPreviewProvider.register(
            context,
            PythonPreviewProvider,
            PythonPreviewProvider.TypeKey,
        ),
    );

    // register datalog view
    DatalogView.register(context);

    // register tree views
    registerCommandsTree(context);

    // listen to file saves
    context.subscriptions.push(
        vscode.workspace.onDidSaveTextDocument(onActiveEditorSaveCallback, null),
    );

    // clear python errors on document change
    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument((e) => {
            if (e.document.languageId === 'python') {
                clearPythonErrors();
            }
        }),
    );

    // listen to state changes and update contexts
    registerContextUtils(context);
    // context.subscriptions.push(registerDebugTerminal(sendDataToHubStdin));
    registerDebugTerminal(context);

    // Activate pybricks-tunnel debugger
    registerDebugTunnel(context);
    registerPybricksTunnelDebug(context);

    // registerBlocklypyViewerDiagnosticsProvider(context);

    // listen to window state changes
    context.subscriptions.push(
        vscode.window.onDidChangeWindowState((e) => {
            if (!e.focused && Config.get<boolean>(ConfigKeys.StopScanOnBlur, true)) {
                ConnectionManager?.stopScanning();
            }
        }),
    );

    // Register notebook controller for executing .ipynb cells on the device
    registerMicroPythonNotebookController(context);

    // Register URI handler for clipboard-based import (e.g. from RoboVibe)
    registerUriHandler(context);

    setTimeout(() => {
        void deferredActivations();
    }, 100);
}

async function deferredActivations(): Promise<void> {
    // Place any activations that can be deferred here

    // Finally, initialize the connection manager and auto-connect if needed
    const layerTypes: (typeof BaseLayer)[] = [BLELayer, USBLayer];
    //!! if (isDevelopmentMode) layerTypes.push(MockLayer);
    await ConnectionManager.initialize(layerTypes).catch(console.error);
}

export async function deactivate(): Promise<void> {
    try {
        // Place cleanup logic here
        await wrapErrorHandling(stopUserProgramAsync)();
        await wrapErrorHandling(disconnectDeviceAsync)();
        ConnectionManager.finalize();
        plotManager.dispose();
    } catch (err) {
        console.error('Error during deactivation:', err);
    }
}

function onActiveEditorSaveCallback(document: vscode.TextDocument) {
    const activeEditor = vscode.window.activeTextEditor;

    if (
        // autostart only if the saved document is the active one
        activeEditor?.document !== document ||
        document.languageId !== 'python' ||
        !Config.FeatureFlag.get(FeatureFlags.AutoStartOnMagicHeader) ||
        // if compiling already, do not start another compile/run cycle
        hasState(StateProp.Compiling)
    ) {
        return;
    }

    // check if file is python and has magic header
    const line1 = document.lineAt(0).text;

    // check for the autostart in the header (header exists, autostart is included)
    if (hasState(StateProp.Connected) && checkMagicHeaderComment(line1)?.autostart) {
        // debounce autostart
        if (Date.now() - lastAutostartTimestamp < AUTOSTART_DEBOUNCE_MS) return;
        lastAutostartTimestamp = Date.now();

        console.debug('AutoStart detected, compiling and running...');
        void vscode.commands.executeCommand(Commands.CompileAndRun);
    }
}

process.on('uncaughtException', (err) => {
    if (isDevelopmentMode) console.error('Uncaught Exception:', err);
    // Optionally show a VS Code error message:
    // vscode.window.showErrorMessage('Uncaught Exception: ' + err.message);
});

process.on('unhandledRejection', (reason, _promise) => {
    if (isDevelopmentMode) console.error('Unhandled Rejection:', reason);
    // Optionally show a VS Code error message:
    // vscode.window.showErrorMessage('Unhandled Rejection: ' + String(reason));
});
