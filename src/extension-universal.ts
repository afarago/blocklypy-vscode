import * as vscode from 'vscode';

import fs from 'fs';
import path from 'path';
import { BLELayer } from './communication/layers/ble-layer';
import { USBLayer } from './communication/layers/usb-layer';
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
    const wasmFilePath = path.join(__dirname, 'mpy-cross-v6.wasm');
    const wasmBinary = fs.readFileSync(wasmFilePath);
    mpyCrossWasm.binary = wasmBinary;

    await activateCommon(context, ExtensionHostModeEnum.Universal, [
        BLELayer,
        USBLayer,
    ]);
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
