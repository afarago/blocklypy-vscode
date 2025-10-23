import * as vscode from 'vscode';

import {
    activateCommon,
    deactivate,
    extensionContext,
    ExtensionHostModeEnum,
    isDevelopmentMode,
} from './extension-common';
import { mpyCrossWasm } from './logic/compile';

export { deactivate, extensionContext, isDevelopmentMode };

export async function activate(context: vscode.ExtensionContext) {
    const wasmUri = vscode.Uri.joinPath(
        context.extensionUri,
        'dist/web/mpy-cross-v6.wasm',
    );
    mpyCrossWasm.uri = wasmUri;

    await activateCommon(context, ExtensionHostModeEnum.Web, []);
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
