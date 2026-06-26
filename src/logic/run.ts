import * as vscode from 'vscode';

import path from 'path';
import { pickSlot } from '../commands/utils';
import { DeviceOSType } from '../communication/clients/base-client';
import { ConnectionManager } from '../communication/connection-manager';
import { PybricksDebugEnabled } from '../debug-tunnel/compile-helper';
import Config, { ConfigKeys } from '../extension/config';
import { clearDebugLog, logDebug } from '../extension/debug-channel';
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

const PROGRAM_SIZE_DISPLAY_PROGRESS_THRESHOLD = 5 * 1024; // 5 KB

export async function runPhase1Async(args: runOptions): Promise<void> {
    const client = ConnectionManager.client;

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
    if (debug && client?.classDescriptor.os !== DeviceOSType.Pybricks) {
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

    // 2. If the client is Pybricks and slot is selected -> enforce the slot for the current one both for compile and run
    if (
        client?.classDescriptor.os === DeviceOSType.Pybricks &&
        client.slot !== undefined
    ) {
        logDebug(
            `👉 Enforcing slot ${client.slot} for both compile and run phases for Pybricks device.`,
        );
        args.slot = client.slot;
    }
}

export async function runPhase2Async(args: runOptions): Promise<void> {
    const client = ConnectionManager.client;

    // 2. Upload
    if (!args.data || !args.filename) {
        throw new Error('No compiled program data available to upload.');
    }
    if (!hasState(StateProp.Connected) || !client) {
        throw new Error('No device selected. Please connect to a device first.');
    }
    if (
        args.language === 'lego' &&
        client.classDescriptor.os !== DeviceOSType.Pybricks
    ) {
        throw new Error(
            'The generated code is only compatible with LEGO devices connected running Pybricks.',
        );
    }

    // ask for slot if not provided and required
    if (client.classDescriptor.requiresSlot) {
        if (args.slot === undefined)
            args.slot = await pickSlot('Enter the slot number to upload program to');
        if (args.slot === undefined || Number.isNaN(args.slot))
            throw new Error('No valid slot number selected.');
    } else {
        if (args.slot === undefined) args.slot = 0;
    }
    await client.action_stop();

    if (args.data.length <= PROGRAM_SIZE_DISPLAY_PROGRESS_THRESHOLD) {
        await client.action_upload(args.data, args.slot, args.filename);
    } else {
        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: `Uploading ${args.data?.byteLength} bytes to hub...`,
                cancellable: true,
            },
            async (progress, token) => {
                if (!args.data || args.slot === undefined) return; // should not happen

                await client.action_upload(
                    args.data,
                    args.slot,
                    args.filename,
                    (incrementPct: number) => {
                        progress.report({ increment: Math.ceil(incrementPct) });
                        if (token.isCancellationRequested) {
                            throw new Error('Upload cancelled by user.');
                        }
                    },
                );
            },
        );
    }

    // 3. Start Program on device
    logDebug('🟢 Starting program on device...', args.filename, undefined, true);
    await client.action_start(args.slot);
}

export async function runAsync(args: runOptions): Promise<void> {
    await runPhase1Async(args);
    await runPhase2Async(args);
}
