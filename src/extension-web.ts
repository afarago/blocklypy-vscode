import * as vscode from 'vscode';

import {
    activateCommon,
    deactivate,
    extensionContext,
    isDevelopmentMode,
} from './extension-common';

export { deactivate, extensionContext, isDevelopmentMode };

export async function activate(context: vscode.ExtensionContext) {
    await activateCommon(context, []);
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
