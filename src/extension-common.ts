import * as vscode from 'vscode';

import { disconnectDeviceAsync } from './commands/disconnect-device';
import { stopUserProgramAsync } from './commands/stop-user-program';
import { ConnectionManager } from './communication/connection-manager';
import { BaseLayer } from './communication/layers/base-layer';
import { registerDebugTunnel } from './debug-tunnel/debug-tunnel';
import { registerPybricksTunnelDebug } from './debug-tunnel/register';
import { Commands, registerCommands } from './extension/commands';
import Config, { FeatureFlags, registerConfig } from './extension/config';
import { registerContextUtils } from './extension/context-utils';
import { logDebug, registerDebugTerminal } from './extension/debug-channel';
import { clearPythonErrors } from './extension/diagnostics';
import { registerCommandsTree } from './extension/tree-commands';
import { wrapErrorHandling } from './extension/utils';
import { checkMagicHeaderComment } from './logic/compile';
import { onTerminalUserInput } from './logic/stdin-helper';
import { BlocklypyViewerProvider } from './views/BlocklypyViewerProvider';
import { DatalogView } from './views/DatalogView';
import { PythonPreviewProvider } from './views/PythonPreviewProvider';

export let isDevelopmentMode: boolean;
export let extensionContext: vscode.ExtensionContext;

export async function activateCommon(
    context: vscode.ExtensionContext,
    layers: (typeof BaseLayer)[] = [],
) {
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
        vscode.workspace.onDidSaveTextDocument(
            onActiveEditorSaveCallback,
            null,
            context.subscriptions,
        ),
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
    registerDebugTerminal(context, (input) => {
        void onTerminalUserInput(input);
    });

    // Activate pybricks-tunnel debugger
    registerDebugTunnel(context);
    registerPybricksTunnelDebug(context);

    // registerBlocklypyViewerDiagnosticsProvider(context);

    // listen to window state changes
    context.subscriptions.push(
        vscode.window.onDidChangeWindowState((e) => {
            if (!e.focused) {
                ConnectionManager?.stopScanning();
            }
        }),
    );

    // Finally, initialize the connection manager and auto-connect if needed
    await ConnectionManager.initialize(layers);

    setTimeout(() => {
        logDebug(
            '🚀 BlocklyPy Commander started up successfully.',
            undefined,
            undefined,
            true,
        );
    }, 1000);
}

export async function deactivate() {
    try {
        // Place cleanup logic here
        await wrapErrorHandling(stopUserProgramAsync)();
        await wrapErrorHandling(disconnectDeviceAsync)();
        ConnectionManager.finalize();
    } catch (err) {
        console.error('Error during deactivation:', err);
    }
}

async function onActiveEditorSaveCallback(document: vscode.TextDocument) {
    const activeEditor = vscode.window.activeTextEditor;

    if (activeEditor && activeEditor.document === document) {
        if (
            document.languageId === 'python' &&
            Config.FeatureFlag.get(FeatureFlags.AutoStartOnMagicHeader)
        ) {
            // check if file is python and has magic header
            const line1 = document.lineAt(0).text;

            // check for the autostart in the header (header exists, autostart is included)
            if (checkMagicHeaderComment(line1)?.autostart) {
                console.log('AutoStart detected, compiling and running...');
                await vscode.commands.executeCommand(Commands.CompileAndRun);
            }
        }
    }
}
