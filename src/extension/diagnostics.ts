import path from 'path';
import * as vscode from 'vscode';
import { __MAIN_MODULE_PATH } from '../logic';
import { ensurePyExtension } from '../logic/compile';
import {
    BlocklypyViewerProvider,
    BlocklypyViewerState,
} from '../views/BlocklypyViewerProvider';

const DiagnosticsCollection =
    vscode.languages.createDiagnosticCollection('BlocklyPy Pybricks');

export async function reportPythonError(
    filename: string,
    line: number,
    message: string,
) {
    if (message === 'SystemExit:') {
        // don't show SystemExit errors
        return;
    }

    const { editor, blviewer } = await findEditorForFile(filename);
    const active = editor ?? blviewer;
    if (!active) return;

    const range = new vscode.Range(line, 0, line, 100); // highlight the whole line
    const diagnostic = new vscode.Diagnostic(
        range,
        message,
        vscode.DiagnosticSeverity.Error,
    );
    DiagnosticsCollection.set(active.document.uri, [diagnostic]);

    // For regular editors, use normal diagnostics
    if (editor) {
        editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
        editor.selection = new vscode.Selection(line, 0, line, 0);
    }

    // For custom viewers, use custom URI scheme
    else if (blviewer) {
        // // Create a custom URI with your scheme
        // const customUri = vscode.Uri.parse(
        //     `${BLOCKLYPY_URI_SCHEME}:${
        //         active.document.uri.fsPath
        //     }?line=${line}&message=${encodeURIComponent(message)}`,
        // );

        // // Set the diagnostic with the custom URI
        // diagnostic.source = 'BlocklyPy';
        // DiagnosticsCollection.set(customUri, [diagnostic]);

        await blviewer.setErrorLineAsync(line, message);
    }
}

export function clearPythonErrors() {
    DiagnosticsCollection.clear();
}

// async function showEditorErrorDecoration(
//     filename: string,
//     line: number,
//     errorMsg: string,
// ) {
//     const { editor, blviewer } = await findEditorForFile(filename);
//     const active = editor ?? blviewer;
//     if (!active) return;
// }

async function findEditorForFile(
    filename: string,
): Promise<{ editor?: vscode.TextEditor; blviewer?: BlocklypyViewerState }> {
    if (filename === __MAIN_MODULE_PATH) {
        return {
            editor: vscode.window.activeTextEditor,
            blviewer: BlocklypyViewerProvider.activeBlocklypyViewer,
        };
    } else {
        // Check all open tabs in all tab groups
        for (const group of vscode.window.tabGroups.all) {
            for (const tab of group.tabs) {
                if (tab.input instanceof vscode.TabInputText) {
                    const fileName = tab.input.uri.fsPath;
                    if (fileName.endsWith(filename)) {
                        // Try to find a visible editor for this tab
                        const openEditor = vscode.window.visibleTextEditors.find(
                            (ed) => ed.document.fileName === fileName,
                        );
                        if (openEditor) {
                            const editor = openEditor;
                            return { editor };
                        } else {
                            // Open the document if not visible
                            const editor = await vscode.workspace
                                .openTextDocument(tab.input.uri)
                                .then((doc) =>
                                    vscode.window.showTextDocument(doc, {
                                        preview: false,
                                    }),
                                );
                            return { editor };
                        }
                    }
                } else if (
                    tab.input instanceof vscode.TabInputCustom &&
                    tab.input.viewType === BlocklypyViewerProvider.TypeKey
                ) {
                    const tab_filename = tab.input.uri.fsPath;
                    const tab_filename_py = ensurePyExtension(
                        path.basename(tab_filename),
                    );
                    // const blviewer = tab.input.uri.fsPath;
                    if (tab_filename_py.endsWith(filename)) {
                        const provider = BlocklypyViewerProvider.Get;
                        let blviewer: BlocklypyViewerState | undefined;
                        if (provider) {
                            blviewer = provider.getDocumentByUri(tab.input.uri);
                            return { blviewer };
                        }
                    }
                }
            }
        }
        return {};
    }
}

export function showInfo(message: string) {
    void vscode.window?.showInformationMessage(message);
}
export function showWarning(message: string) {
    void vscode.window?.showWarningMessage(message);
}
export function showError(message: string) {
    void vscode.window?.showErrorMessage(message);
}

// show information and wait for user to dismiss
export async function showInfoAsync(message: string) {
    await vscode.window?.showInformationMessage(message);
}
// show warning and wait for user to dismiss
export async function showWarningAsync(message: string) {
    await vscode.window?.showWarningMessage(message);
}
// show error and wait for user to dismiss
export async function showErrorAsync(message: string) {
    await vscode.window?.showErrorMessage(message);
}
