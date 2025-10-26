import { compile } from '@pybricks/mpy-cross-v6';
import { parse, walk } from '@pybricks/python-program-analysis';
import path from 'path';
import * as vscode from 'vscode';
import { FILENAME_SAMPLE_COMPILED, FILENAME_SAMPLE_RAW, MAIN_MODULE } from '.';
import { ConnectionManager } from '../communication/connection-manager';
import {
    DEBUG_ASSET_MODULES,
    PybricksDebugEnabled,
    transformCodeForDebugTunnel,
} from '../debug-tunnel/compile-helper';
import { logDebug } from '../extension';
import { extensionContext } from '../extension-common';
import Config, { FeatureFlags } from '../extension/config';
import { transformCodeForPlot } from '../plot/compile-helper';
import { BlocklypyViewerProvider } from '../views/BlocklypyViewerProvider';
import { setState, StateProp } from './state';


export type CompileModule = {
    name: string;
    path: string;
    filename: string;
    content: string;
    uri: vscode.Uri;
    breakpoints?: number[];
    usercode: boolean; // user module vs internal module, added automatically, not by user
    mpy?: Uint8Array; // filled after compilation
};

/**
 * one of these will be set by the extension activating code
 * universal: binary data of the my-cross.wasm file
 * web: URI for the web extension host
 */
export const mpyCrossWasm: {
    binary?: Uint8Array;
    uri?: vscode.Uri;
} = {};

function getBreakpointsFromEditors(): Map<string, number[]> {
    const breakpointsByFile = new Map<string, number[]>();

    for (const bp of vscode.debug.breakpoints) {
        if (bp instanceof vscode.SourceBreakpoint) {
            const uripath = bp.location.uri.path;
            const line = bp.location.range.start.line + 1;
            if (!breakpointsByFile.has(uripath)) breakpointsByFile.set(uripath, []);
            breakpointsByFile.get(uripath)!.push(line);
        }
    }
    return breakpointsByFile;
}

export function ensurePyExtension(pathname: string): string {
    if (!pathname.toLowerCase().endsWith('.py')) {
        return pathname + '.py';
    }
    return pathname;
}

// TODO: rethink moving to return and changing to pure function
export const compiledModules = new Map<string, CompileModule>();
export async function compileWorkerAsync(
    isCompiled: boolean = true,
    debug: boolean = false,
): Promise<{
    uri: vscode.Uri;
    data: Uint8Array;
    filename: string;
    files: string[];
    slot: number | undefined;
    language: string;
}> {
    await vscode.commands.executeCommand('workbench.action.files.saveAll');

    const parts: BlobPart[] = [];
    const { uri, content, filename, folder, language } = getActivePythonCode();
    if (!content) throw new Error('No Python code available to compile.');

    const slot = checkMagicHeaderComment(content).slot;
    if (isCompiled === false) {
        const data = encoder.encode(content);
        // NOTE: cannot add debug unless the concatenation trick is used
        return {
            uri,
            data,
            filename: FILENAME_SAMPLE_RAW,
            files: [uri.fsPath],
            slot,
            language,
        };
    }

    let mpyCurrent: Uint8Array | undefined;
    const modules: CompileModule[] = [];
    const filename_py = ensurePyExtension(path.basename(filename)); // was: MAIN_MODULE_PATH,
    modules.push({
        uri,
        name: MAIN_MODULE,
        path: filename_py,
        usercode: true,
        filename: filename,
        content,
    });
    compiledModules.clear();

    setState(StateProp.Compiling, true);
    try {
        const checkedModules = new Set<string>();
        const assetImportedModules = new Set<string>();
        const breakpointsFromEditors = getBreakpointsFromEditors();
        const breakpointsCompiled = new Map<string, number[] | undefined>();

        const compileHooks: Array<(module: CompileModule) => void> = [];
        //-- add debug hook if enabled
        if (debug && PybricksDebugEnabled()) {
            compileHooks.push((module) => {
                transformCodeForDebugTunnel(
                    module,
                    breakpointsFromEditors.get(module.uri.path),
                );
                breakpointsCompiled.set(module.uri.path, module.breakpoints);
            });
            DEBUG_ASSET_MODULES.forEach((module) => assetImportedModules.add(module));
        }

        //-- add plot hook if enabled
        if (Config.FeatureFlag.get(FeatureFlags.PlotDataFromStdout)) {
            // TODO: check - I would add it before, it would be logical to add after but that does not work
            compileHooks.push(transformCodeForPlot);
        }

        // Process modules until there are no more to process
        while (modules.length > 0) {
            const module = modules.pop()!;
            if (checkedModules.has(module.name)) continue;
            checkedModules.add(module.name);

            // transform user modules for any hooks tunnel
            if (module.usercode) {
                compileHooks.forEach((hook) => hook(module));
            }

            // Compiling module may reveal more imports, so check those too
            const importedModules = findImportedModules(module.content);
            for (const importedModule of importedModules) {
                if (checkedModules.has(importedModule) || !folder) {
                    continue;
                }
                const resolvedModule = await resolveModuleAsync(
                    folder,
                    importedModule,
                    assetImportedModules,
                );
                if (resolvedModule) {
                    modules.push(resolvedModule);
                } else {
                    checkedModules.add(importedModule);
                }
            }

            // Compile one module
            if (
                ConnectionManager.client?.classDescriptor.supportsModularMpy !==
                    false ||
                parts.length === 0
            ) {
                // Either the device supports modular .mpy files, or there is only one
                const [status, mpy] = await compileInternal(
                    module.path,
                    module.name,
                    module.content,
                );
                if (status !== 0 || !mpy) {
                    logDebug(
                        `❌ Failed to compile ${
                            module.name
                        }\n  ${module.content.replace(/([^\r])\n/g, '$1\r\n')}`,
                    );
                    throw new Error(`Failed to compile ${module.name}`);
                }
                module.mpy = mpy;
                compiledModules.set(module.uri.fsPath, module);

                mpyCurrent = mpy;

                parts.push(encodeUInt32LE(mpy.length));
                parts.push(cString(module.name) as BlobPart);
                parts.push(mpy as BlobPart);
            } else {
                break;
            }

            checkedModules.add(module.name);
        }
        // Compile finished

        // Enlist breakpoints, add warning if any breakpoints were compiled
        if (breakpointsCompiled.size > 0) {
            logDebug(
                `Note: Transforming code for debug tunnel. Compiled an instrumented version of code, that might yield to side effects and different line numbers.`,
            );
            for (const [file, bps] of breakpointsCompiled.entries()) {
                if (bps && bps.length > 0) {
                    logDebug(
                        `Compiled breakpoints for ${path.basename(file)}: ${bps
                            .map((line) => `#${line}`)
                            .join(', ')}`,
                    );
                }
            }
        }
    } finally {
        setState(StateProp.Compiling, false);
    }

    // Check if modular .mpy files are supported or just a single file is needed
    if (ConnectionManager.client?.classDescriptor.supportsModularMpy !== false) {
        const blob = new Blob(parts);
        const buffer = await blob.arrayBuffer();
        return {
            uri,
            data: new Uint8Array(buffer),
            filename: FILENAME_SAMPLE_COMPILED,
            files: Array.from(compiledModules.values()).map((m) => m.uri.fsPath),
            slot,
            language,
        };
    } else {
        if (modules.length > 1 || parts.length > 3 * 1 || !mpyCurrent) {
            throw new Error(
                'Modular .mpy files are not supported by the connected device. Please combine all code into a single file.',
            );
        }
        return {
            uri,
            data: mpyCurrent,
            filename: FILENAME_SAMPLE_COMPILED,
            files: [uri.fsPath],
            slot,
            language,
        };
    }
}

export function getActivePythonUri(): vscode.Uri | undefined {
    const editor = vscode.window.activeTextEditor;
    if (editor && editor.document.languageId === 'python') {
        return editor.document.uri;
    }

    const customViewer = BlocklypyViewerProvider.activeBlocklypyViewer;
    if (customViewer) {
        return customViewer.uri;
    }

    return undefined;
}

export function getActivePythonCode(): {
    uri: vscode.Uri;
    content: string;
    filename: string;
    language: string;
    folder?: string;
} {
    const editor = vscode.window.activeTextEditor;
    if (editor) {
        const uri = editor.document.uri;
        const content = editor.document.getText();
        const folder = path.dirname(uri.fsPath);
        const filename = path.basename(uri.fsPath);
        return { uri, content, filename, folder, language: editor.document.languageId };
    }

    const customViewer = BlocklypyViewerProvider.activeBlocklypyViewer;
    if (customViewer) {
        const uri = customViewer.uri;
        const content = customViewer?.content?.pycode ?? '';
        const filename = customViewer.filename;
        return { uri, content, filename, language: 'lego' };
    }

    throw new Error('No active Python or Blocklypy editor found.');
}

async function compileInternal(
    path: string,
    name: string,
    content: string,
): Promise<[number, Uint8Array | undefined]> {
    // HACK: This is a workaround for https://github.com/pybricks/support/issues/2185
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    // const fetch_backup = (global as any).fetch;
    // if (isUniversal()) {
    //     // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    //     (global as any).fetch = undefined;
    // }
    try {
        const compiled = await compile(
            path,
            content,
            [],
            mpyCrossWasm.uri?.toString(), // web extension
            mpyCrossWasm.binary, // universal extension
        )
            .catch((e) => {
                console.error(`Failed to compile ${name}: ${e}`);
                return { status: 1, mpy: undefined };
            })
            .finally(() => {
                // if (isUniversal()) {
                //     // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment
                //     (global as any).fetch = fetch_backup;
                // }
            });
        return [compiled.status, compiled.mpy];
    } catch {
        // NOOP
    }
    return [1, undefined];
}

async function resolveModuleAsync(
    folder: string,
    module: string,
    assetImportedModules: ReadonlySet<string>,
): Promise<CompileModule | undefined> {
    const relativePath = ensurePyExtension(module.replace(/\./g, path.sep));

    // try relative loading from the current file
    // this even allows overriding the asset loaded modules
    let absolutePath = path.join(folder, relativePath);
    try {
        const uri = vscode.Uri.file(absolutePath);
        const stats = await vscode.workspace.fs.stat(uri);
        if (stats.type === vscode.FileType.File) {
            return {
                uri,
                name: module,
                path: relativePath,
                usercode: true,
                filename: path.basename(relativePath),
                content: Buffer.from(await vscode.workspace.fs.readFile(uri)).toString(
                    'utf8',
                ),
            };
        }
    } catch {
        // ignore errors
    }

    // check if it is an asset module
    if (assetImportedModules.has(module)) {
        // this will ignore __main__, but it is OK as we dont want that from assets
        try {
            const { uri, content } = await loadPythonAssetModule(relativePath);
            return {
                uri,
                name: module,
                path: relativePath,
                usercode: false,
                filename: path.basename(relativePath),
                content,
            };
        } catch (e) {
            // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
            console.error(`Error loading asset module ${module}: ${e}`);
        }
    }
}

function findImportedModules(py: string): ReadonlySet<string> {
    const modules = new Set<string>();

    const tree = parse(py);

    walk(tree, {
        onEnterNode(node, _ancestors) {
            if (node.type === 'import') {
                for (const name of node.names) {
                    modules.add(name.path);
                }
            } else if (node.type === 'from') {
                modules.add(node.base);
            }
        },
    });

    return modules;
}

const encoder = new TextEncoder();
function cString(str: string): Uint8Array {
    return encoder.encode(str + '\x00');
}

function encodeUInt32LE(value: number): ArrayBuffer {
    const buf = new ArrayBuffer(4);
    const view = new DataView(buf);
    view.setUint32(0, value, true);
    return buf;
}

export function checkMagicHeaderComment(py: string): {
    autostart?: boolean;
    slot?: number;
} {
    if (py.match(/^\s*#\s*LEGO/i)) {
        const autostart = py.match(/\bautostart\b/i) !== null;
        const slot = py.match(/\bslot:\s*(\d{1,2})/i);
        return {
            autostart: autostart,
            slot: slot ? parseInt(slot[1]) : undefined,
        };
    } else {
        return {};
    }
}

export async function loadPythonAssetModule(
    relativePath: string,
): Promise<{ uri: vscode.Uri; content: string }> {
    const uri = vscode.Uri.joinPath(
        extensionContext.extensionUri,
        'asset',
        'python-libs',
        relativePath,
    );
    const file = await vscode.workspace.fs.readFile(uri);
    const content = Buffer.from(file).toString('utf8');
    return { uri, content };
}