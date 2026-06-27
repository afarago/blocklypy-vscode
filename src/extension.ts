import express, { Request, Response } from 'express';
import { Server as HttpServer } from 'node:http';
import * as vscode from 'vscode';
import { compileAndRunAsync } from './commands/compile-and-run';
import { disconnectDeviceAsync } from './commands/disconnect-device';
import { stopUserProgramAsync } from './commands/stop-user-program';
import { StartMode } from './communication/clients/base-client';
import { PybricksBleClient } from './communication/clients/pybricks-ble-client';
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
import { getRecentHubStdout, registerDebugTerminal } from './extension/debug-channel';
import { clearPythonErrors } from './extension/diagnostics';
import { registerCommandsTree } from './extension/tree-commands';
import { registerUriHandler } from './extension/uri-handler';
import { wrapErrorHandling } from './extension/utils';
import { checkMagicHeaderComment } from './logic/compile';
import { runAsync } from './logic/run';
import { hasState, StateProp, waitForStateWithTimeout } from './logic/state';
import { registerMicroPythonNotebookController } from './notebook/blocklypy-micropython-kernel';
import { plotManager } from './plot/plot';
import { BuiltinProgramId } from './pybricks/ble-pybricks-service/protocol';
import { BlocklypyViewerProvider } from './views/BlocklypyViewerProvider';
import { DatalogView } from './views/DatalogView';
import { PythonPreviewProvider } from './views/PythonPreviewProvider';

export let isDevelopmentMode: boolean;
export let extensionContext: vscode.ExtensionContext;
let lastAutostartTimestamp = 0;

const AUTOSTART_DEBOUNCE_MS = 1 * MILLISECONDS_IN_SECOND;
const BLOCKLYPY_RUN_TOOL = 'blocklypy_run';
const BLOCKLYPY_REPL_TOOL = 'blocklypy_repl';
const REPL_OUTPUT_START = '__blocklypy_repl_start__';
const REPL_OUTPUT_END = '__blocklypy_repl_end__';
const REPL_TOOL_TIMEOUT_MS = 10 * MILLISECONDS_IN_SECOND;
const MCP_SERVER_PORT = 4733;
const MCP_SERVER_HOST = '127.0.0.1';
const MCP_HTTP_PATH = '/mcp';
const MCP_TOOL_COMPILE_AND_RUN = 'compile_and_run_pybricks';
const MCP_TOOL_READ_STDOUT = 'read_device_stdout';
const MCP_TOOL_REPL = 'repl_pybricks';
const MCP_STDOUT_DEFAULT_TAIL = 2048;

let mcpHttpServer: HttpServer | undefined;

type BlocklypyRunInput = {
    slot?: number;
};

type BlocklypyReplInput = {
    command: string;
};

type McpToolCallParams = {
    name?: string;
    arguments?: {
        slot?: unknown;
        tail?: unknown;
        command?: unknown;
    };
};

type McpToolCallResult = {
    content: Array<{
        type: 'text';
        text: string;
    }>;
    isError?: boolean;
};

type JsonRpcRequest = {
    jsonrpc?: unknown;
    id?: unknown;
    method?: unknown;
    params?: McpToolCallParams;
};

// eslint-disable-next-line @typescript-eslint/require-await
export async function activate(context: vscode.ExtensionContext): Promise<void> {
    extensionContext = context;
    isDevelopmentMode = context.extensionMode === vscode.ExtensionMode.Development;

    // First, register all commands explicitly
    registerCommands(context);
    registerConfig(context);
    registerCopilotTools(context);
    registerMCPServer(context);

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

function registerCopilotTools(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.lm.registerTool<BlocklypyRunInput>(BLOCKLYPY_RUN_TOOL, {
            prepareInvocation(options) {
                const slot = options.input.slot;
                return {
                    invocationMessage:
                        slot === undefined
                            ? 'Uploading program to connected LEGO device...'
                            : `Uploading program to slot ${slot} on connected LEGO device...`,
                    confirmationMessages: {
                        title: 'Allow BlocklyPy run request?',
                        message:
                            'This will compile, upload, and start code on the connected hub.',
                    },
                };
            },
            async invoke(options) {
                const slotInput = options.input.slot;
                const slot =
                    typeof slotInput === 'number' && Number.isFinite(slotInput)
                        ? Math.trunc(slotInput)
                        : undefined;

                if (slot !== undefined && (slot < 0 || slot > 19)) {
                    return new vscode.LanguageModelToolResult([
                        new vscode.LanguageModelTextPart(
                            'Failed to run: slot must be an integer between 0 and 19.',
                        ),
                    ]);
                }

                try {
                    await compileAndRunAsync(slot);
                    return new vscode.LanguageModelToolResult([
                        new vscode.LanguageModelTextPart(
                            slot === undefined
                                ? 'Program compiled and started successfully.'
                                : `Program compiled and started successfully in slot ${slot}.`,
                        ),
                    ]);
                } catch (err) {
                    return new vscode.LanguageModelToolResult([
                        new vscode.LanguageModelTextPart(
                            `Failed to run: ${String(err)}`,
                        ),
                    ]);
                }
            },
        }),
    );

    context.subscriptions.push(
        vscode.lm.registerTool<BlocklypyReplInput>(BLOCKLYPY_REPL_TOOL, {
            prepareInvocation() {
                return {
                    invocationMessage:
                        'Executing Python snippet in REPL on connected LEGO device...',
                    confirmationMessages: {
                        title: 'Allow BlocklyPy REPL request?',
                        message:
                            'This will execute Python code on the connected Pybricks hub.',
                    },
                };
            },
            async invoke(options) {
                const command = options.input.command?.trim();
                if (!command) {
                    return new vscode.LanguageModelToolResult([
                        new vscode.LanguageModelTextPart(
                            'Failed to run: command must be a non-empty string.',
                        ),
                    ]);
                }

                try {
                    const output = await executeReplCommandAsync(command);
                    return new vscode.LanguageModelToolResult([
                        new vscode.LanguageModelTextPart(output),
                    ]);
                } catch (err) {
                    return new vscode.LanguageModelToolResult([
                        new vscode.LanguageModelTextPart(
                            `Failed to run REPL command: ${String(err)}`,
                        ),
                    ]);
                }
            },
        }),
    );
}

async function executeReplCommandAsync(command: string): Promise<string> {
    const client = ConnectionManager.client;
    if (!client || !client.connected) {
        throw new Error('No connected device. Connect a Pybricks hub first.');
    }
    if (!(client instanceof PybricksBleClient)) {
        throw new Error('REPL tool currently supports only Pybricks BLE hubs.');
    }
    if (!client.hubType?.capabilities.repl) {
        throw new Error('REPL is not supported by the connected hub.');
    }

    const replAlreadyActive =
        hasState(StateProp.Running) && client.slot === BuiltinProgramId.REPL;

    if (!replAlreadyActive) {
        // Match command behavior: stop current user program before entering REPL.
        if (hasState(StateProp.Running)) {
            await client.action_stop();
            await waitForStateWithTimeout(StateProp.Running, false, 1500);
        }
        await client.action_start(StartMode.REPL);
        // Wait for REPL to actually be running before sending any input.
        await waitForStateWithTimeout(StateProp.Running, true, 3000);
    }

    const normalizedCommand = normalizeReplCommand(command);

    const lines: string[] = [];
    let capture = false;
    let finished = false;

    const disposable = client.onStdout((chunk) => {
        const split = chunk.split(/\r?\n/);
        for (const line of split) {
            if (!capture && line.includes(REPL_OUTPUT_START)) {
                capture = true;
                continue;
            }
            if (capture && line.includes(REPL_OUTPUT_END)) {
                finished = true;
                break;
            }
            if (capture) {
                lines.push(line);
            }
        }
    });

    const wrappedCode = [
        `print('${REPL_OUTPUT_START}')`,
        normalizedCommand,
        `print('${REPL_OUTPUT_END}')`,
    ].join('\r\n');

    try {
        await client.sendCodeToRepl(wrappedCode);

        const start = Date.now();
        while (!finished && Date.now() - start < REPL_TOOL_TIMEOUT_MS) {
            await new Promise<void>((resolve) => setTimeout(resolve, 50));
        }

        if (!finished) {
            throw new Error('Timed out waiting for REPL output.');
        }

        const output = lines
            .join('\n')
            .trim()
            .replace(/^>>>\s*/gm, '')
            .trim();
        return output.length > 0 ? output : '(No REPL output)';
    } finally {
        disposable.dispose();
        if (!finished) {
            // Code did not complete (error or timeout) — stop REPL to clean up.
            await client.action_stop().catch(() => undefined);
            await waitForStateWithTimeout(StateProp.Running, false, 1500);
        }
        // On success leave REPL running; avoids the stop→restart BLE churn
        // that triggers Unknown ATT errors on sequential tool calls.
    }
}

function normalizeReplCommand(command: string): string {
    const lines = command.split(/\r?\n/);
    const filtered = lines.filter((line) => {
        const trimmed = line.trim();
        if (/^from\s+pybricks\.hubs\s+import\s+\w+\s*$/i.test(trimmed)) {
            return false;
        }
        if (/^hub\s*=\s*\w+\s*\(\s*\)\s*$/i.test(trimmed)) {
            return false;
        }
        if (/^raise\s+SystemExit\s*\(\s*\)\s*$/i.test(trimmed)) {
            return false;
        }
        return true;
    });

    return filtered.join('\r\n').trim();
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
        await stopMCPServerAsync();

        // Place cleanup logic here
        await wrapErrorHandling(stopUserProgramAsync)();
        await wrapErrorHandling(disconnectDeviceAsync)();
        ConnectionManager.finalize();
        plotManager.dispose();
    } catch (err) {
        console.error('Error during deactivation:', err);
    }
}

function registerMCPServer(context: vscode.ExtensionContext): void {
    void startMCPServerAsync();
    context.subscriptions.push({
        dispose: () => {
            void stopMCPServerAsync();
        },
    });
}

async function startMCPServerAsync(): Promise<void> {
    if (mcpHttpServer) {
        console.log('BlocklyPy MCP Server already running');
        return;
    }

    try {
        console.log('Starting BlocklyPy MCP Server...');
        const app = express();
        app.use(express.json({ limit: '1mb' }));

        // Simple JSON-RPC handler
        app.post(MCP_HTTP_PATH, async (req: Request, res: Response) => {
            try {
                const { jsonrpc, id, method, params } = req.body as JsonRpcRequest;

                if (jsonrpc !== '2.0') {
                    res.status(400).json({
                        jsonrpc: '2.0',
                        error: { code: -32600, message: 'Invalid Request' },
                        id: null,
                    });
                    return;
                }

                let result;
                switch (method) {
                    case 'initialize':
                        result = {
                            protocolVersion: '2024-11-05',
                            capabilities: { tools: {} },
                            serverInfo: {
                                name: 'blocklypy-commander',
                                version: '0.7.33',
                            },
                        };
                        break;

                    case 'tools/list':
                        result = {
                            tools: [
                                {
                                    name: MCP_TOOL_COMPILE_AND_RUN,
                                    description:
                                        'Compile and upload the currently active Python program, then start it on the connected hub.',
                                    inputSchema: {
                                        type: 'object',
                                        properties: {
                                            slot: {
                                                type: 'number',
                                                description:
                                                    'Optional slot number to upload/run on supported hubs (0-19).',
                                            },
                                        },
                                    },
                                },
                                {
                                    name: MCP_TOOL_READ_STDOUT,
                                    description:
                                        'Read recent stdout text received from the connected hub.',
                                    inputSchema: {
                                        type: 'object',
                                        properties: {
                                            tail: {
                                                type: 'number',
                                                description:
                                                    'Number of trailing characters to return from buffered stdout.',
                                            },
                                        },
                                    },
                                },
                                {
                                    name: MCP_TOOL_REPL,
                                    description:
                                        'Execute a Python snippet in the MicroPython REPL on the connected Pybricks hub and return its stdout output.',
                                    inputSchema: {
                                        type: 'object',
                                        properties: {
                                            command: {
                                                type: 'string',
                                                description:
                                                    'Python code to execute in the REPL.',
                                            },
                                        },
                                        required: ['command'],
                                    },
                                },
                            ],
                        };
                        break;

                    case 'tools/call':
                        result = await handleToolCall(params ?? {});
                        break;

                    default:
                        // Notifications (no id) are fire-and-forget; respond 200 with no body.
                        if (id === undefined || id === null) {
                            res.status(200).end();
                            return;
                        }
                        res.status(200).json({
                            jsonrpc: '2.0',
                            error: { code: -32601, message: 'Method not found' },
                            id,
                        });
                        return;
                }

                res.json({ jsonrpc: '2.0', result, id });
            } catch (error) {
                console.error('Failed to process MCP HTTP request:', error);
                res.status(500).json({
                    jsonrpc: '2.0',
                    error: { code: -32603, message: String(error) },
                    id: (req.body as JsonRpcRequest | undefined)?.id ?? null,
                });
            }
        });

        // Health check endpoint
        app.get('/health', (_req: Request, res: Response) => {
            res.json({
                status: 'ok',
                server: 'blocklypy-commander',
                version: '0.7.33',
            });
        });

        await new Promise<void>((resolve, reject) => {
            const httpServer = app.listen(MCP_SERVER_PORT, MCP_SERVER_HOST, () => {
                console.log(
                    `✅ BlocklyPy MCP Server running at http://${MCP_SERVER_HOST}:${MCP_SERVER_PORT}${MCP_HTTP_PATH}`,
                );
                resolve();
            });

            httpServer.on('error', (error: Error) => {
                console.error('❌ Failed to start BlocklyPy MCP Server:', error);
                reject(error);
            });

            mcpHttpServer = httpServer;
        });
    } catch (error) {
        console.error('❌ Exception while starting MCP server:', error);
        throw error;
    }
}

async function handleToolCall(params: McpToolCallParams): Promise<McpToolCallResult> {
    const { name, arguments: args } = params;

    if (name === MCP_TOOL_COMPILE_AND_RUN) {
        const slotRaw = args?.slot;
        const slot =
            typeof slotRaw === 'number' && Number.isFinite(slotRaw)
                ? Math.trunc(slotRaw)
                : undefined;

        if (slot !== undefined && (slot < 0 || slot > 19)) {
            return {
                content: [
                    {
                        type: 'text',
                        text: 'Error: slot must be an integer between 0 and 19.',
                    },
                ],
                isError: true,
            };
        }

        try {
            await runAsync({
                noDebug: true,
                slot,
            });
            return {
                content: [
                    {
                        type: 'text',
                        text:
                            slot === undefined
                                ? 'Successfully uploaded and started on device.'
                                : `Successfully uploaded and started on device in slot ${slot}.`,
                    },
                ],
            };
        } catch (err) {
            return {
                content: [
                    {
                        type: 'text',
                        text: `Error: ${String(err)}`,
                    },
                ],
                isError: true,
            };
        }
    }

    if (name === MCP_TOOL_READ_STDOUT) {
        const tailRaw = args?.tail;
        const tail =
            typeof tailRaw === 'number' && Number.isFinite(tailRaw)
                ? Math.max(1, Math.min(16384, Math.trunc(tailRaw)))
                : MCP_STDOUT_DEFAULT_TAIL;
        const text = getRecentHubStdout(tail);

        return {
            content: [
                {
                    type: 'text',
                    text:
                        text.length > 0
                            ? text
                            : '(No recent hub stdout is buffered yet.)',
                },
            ],
        };
    }

    if (name === MCP_TOOL_REPL) {
        const commandRaw = args?.command;
        if (typeof commandRaw !== 'string' || !commandRaw.trim()) {
            return {
                content: [
                    {
                        type: 'text',
                        text: 'Error: command must be a non-empty string.',
                    },
                ],
                isError: true,
            };
        }
        try {
            const output = await executeReplCommandAsync(commandRaw.trim());
            return { content: [{ type: 'text', text: output }] };
        } catch (err) {
            return {
                content: [{ type: 'text', text: `Error: ${String(err)}` }],
                isError: true,
            };
        }
    }

    return {
        content: [{ type: 'text', text: `Unknown tool: ${name}` }],
        isError: true,
    };
}

async function stopMCPServerAsync(): Promise<void> {
    const httpServer = mcpHttpServer;
    mcpHttpServer = undefined;

    if (httpServer) {
        await new Promise<void>((resolve) => {
            httpServer.close(() => {
                console.log('BlocklyPy MCP Server stopped');
                resolve();
            });
        });
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
