import * as vscode from 'vscode';

import { BLOCKLYPY_COMMANDS_TREE_VIEW_ID } from '../const';
import { PYBRICKS_DEBUG_TYPE } from '../debug-tunnel/register';
import { logDebug } from '../extension/debug-channel';
import { runAsync, runPhase1Async } from '../logic/run';

export async function compileOnlyAsync(
    isCompiled?: boolean,
    debug = false,
): Promise<void> {
    try {
        await runPhase1Async({
            noDebug: !debug,
            compiled: isCompiled,
        });
    } catch (e) {
        const error = String(e).replace(/\n(?!\r)/g, '\r\n');
        logDebug(`❌ Compilation failed: ${error}`);
    }
}

export async function compileAndRunAsync(
    slot_input?: number,
    isCompiled?: boolean,
    debug = false,
): Promise<void> {
    await vscode.window.withProgress(
        {
            location: { viewId: BLOCKLYPY_COMMANDS_TREE_VIEW_ID },
            cancellable: false,
        },
        async () => {
            try {
                if (!debug) {
                    // quick start without debugging, much faster than DAP in noDebug mode
                    await runAsync({
                        noDebug: !debug,
                        compiled: isCompiled,
                        slot: slot_input,
                    });
                } else {
                    await vscode.debug.startDebugging(undefined, {
                        type: PYBRICKS_DEBUG_TYPE,
                        name: 'Debug File',
                        request: 'launch',
                        noDebug: !debug,
                        compiled: isCompiled,
                        slot: slot_input,
                        stopOnEntry: true,
                    });
                }
            } catch (e) {
                const error = String(e).replace(/\n(?!\r)/g, '\r\n');
                logDebug(`❌ Compile and run failed: ${error}`);
            }
        },
    );
}
