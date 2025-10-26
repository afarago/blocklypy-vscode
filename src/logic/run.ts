import path from 'path';
import { pickSlot } from '../commands/utils';
import { DeviceOSType } from '../communication/clients';
import { ConnectionManager } from '../communication/connection-manager';
import { PybricksDebugEnabled } from '../debug-tunnel/compile-helper';
import { logDebug } from '../extension';
import Config, { ConfigKeys } from '../extension/config';
import { clearDebugLog } from '../extension/debug-channel';
import { clearPythonErrors, showWarning } from '../extension/diagnostics';
import { compiledModules, compileWorkerAsync } from './compile';
import { hasState, StateProp } from './state';

export type runOptions = {
    noDebug?: boolean;
    compiled?: boolean;
    program?: string;
    slot?: number;
    language?: string;
    filename?: string;
    data?: Uint8Array;
    files?: string[];
};

export async function runPhase1Async(args: runOptions) {
    clearPythonErrors();
    if (Config.get<boolean>(ConfigKeys.TerminalAutoClear) === true) clearDebugLog();

    // 1. Compile
    // TODO: add later option to select program instead of the active one
    let debug = args.noDebug !== true;
    if (debug && !PybricksDebugEnabled()) {
        showWarning(
            'Debugging feature flag is disabled. Please enable it in the settings to use debugging.',
        );
        debug = false;
    }
    if (
        debug &&
        ConnectionManager.client?.classDescriptor.os !== DeviceOSType.Pybricks
    ) {
        showWarning(
            'Debug mode is only compatible with LEGO devices connected running Pybricks, falling back to no debug mode.',
        );
        debug = false;
    }

    const {
        uri,
        data,
        filename,
        slot: slot_header,
        language,
    } = await compileWorkerAsync(args.compiled, debug);
    args.program = uri.fsPath;
    args.language = language;
    args.filename = filename;
    args.data = data;
    args.files = [uri.fsPath];
    if (slot_header !== undefined) args.slot = slot_header;

    logDebug(
        `✨ Compiled ${filename} successfully, size: ${data?.length} bytes.`,
        filename,
    );
    if (compiledModules.size > 1)
        logDebug(
            Array.from(compiledModules.entries())
                .map(([k, v]) => `  └ ${path.basename(k)}: ${v.mpy?.byteLength} bytes`)
                .join('\r\n'),
        );

    return args;
}

export async function runPhase2Async(args: runOptions): Promise<void> {
    // 2. Upload
    if (!args.data || !args.filename) {
        throw new Error('No compiled program data available to upload.');
    }
    if (!hasState(StateProp.Connected) || !ConnectionManager.client) {
        throw new Error('No device selected. Please connect to a device first.');
    }
    if (
        args.language === 'lego' &&
        ConnectionManager.client.classDescriptor.os !== DeviceOSType.Pybricks
    ) {
        throw new Error(
            'The generated code is only compatible with LEGO devices connected running Pybricks.',
        );
    }

    // ask for slot if not provided and required
    if (ConnectionManager.client.classDescriptor.requiresSlot) {
        if (args.slot === undefined)
            args.slot = await pickSlot('Enter the slot number to upload program to');
        if (args.slot === undefined || Number.isNaN(args.slot))
            throw new Error('No valid slot number selected.');
    } else {
        if (args.slot === undefined) args.slot = 0;
    }
    await ConnectionManager.client.action_stop();
    await ConnectionManager.client.action_upload(args.data, args.slot, args.filename);

    // 3. Start Program on device
    logDebug('🟢 Starting program on device...', args.filename, undefined, true);
    await ConnectionManager.client.action_start(args.slot);
}

export async function runAsync(args: runOptions): Promise<void> {
    await runPhase1Async(args);
    await runPhase2Async(args);
}
