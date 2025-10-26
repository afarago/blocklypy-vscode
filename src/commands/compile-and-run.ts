import * as vscode from 'vscode';

import { BLOCKLYPY_COMMANDS_VIEW_ID } from '../const';
import { PYBRICKS_DEBUG_TYPE } from '../debug-tunnel/register';
import { logDebug } from '../extension';
import { runAsync, runPhase1Async } from '../logic/run';

export async function compileOnlyAsync(
    isCompiled?: boolean,
    debug = false,
): Promise<void> {
    await runPhase1Async({
        noDebug: !debug,
        compiled: isCompiled,
    });
}

export async function compileAndRunAsync(
    slot_input?: number,
    isCompiled?: boolean,
    debug = false,
): Promise<void> {
    await vscode.window.withProgress(
        {
            location: { viewId: BLOCKLYPY_COMMANDS_VIEW_ID },
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
                logDebug(`${String(e)}`);
            }
        },
    );
}
