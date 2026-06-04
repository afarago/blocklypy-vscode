import * as vscode from 'vscode';
import { getActiveFileFolder, getDateTimeString } from '../utils/files';

export function registerUriHandler(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.window.registerUriHandler({
            async handleUri(uri: vscode.Uri): Promise<void> {
                if (uri.path === '/import') {
                    await importFromClipboard();
                }
            },
        }),
    );
}

async function importFromClipboard(): Promise<void> {
    const clipboardText = await vscode.env.clipboard.readText();
    if (!clipboardText.trim()) {
        void vscode.window.showWarningMessage(
            'BlocklyPy: Clipboard is empty — nothing to import.',
        );
        return;
    }

    const folder = getActiveFileFolder();
    const timestamp = getDateTimeString(new Date());
    const fileUri = vscode.Uri.joinPath(folder, `pybricks-${timestamp}.py`);

    await vscode.workspace.fs.writeFile(fileUri, Buffer.from(clipboardText, 'utf-8'));
    await vscode.window.showTextDocument(fileUri, { preview: false });
}
