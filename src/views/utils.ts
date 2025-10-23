import * as vscode from 'vscode';

export function getScriptUri(
    context: vscode.ExtensionContext,
    webviewContainer: vscode.WebviewPanel | vscode.WebviewView,
    basename: string,
): vscode.Uri {
    return webviewContainer.webview.asWebviewUri(
        //TODO: handle web extension path
        vscode.Uri.joinPath(context.extensionUri, 'dist/webview', basename + '.js'),
    );
}
