import * as vscode from 'vscode';
import { HubOSBaseClient } from '../communication/clients/hubos-base-client';
import { Commands } from '../extension/commands';
import { HUBOS_SPIKE_SLOTS } from '../spike';
import { getNonce, getScriptUri } from './utils';

const HUB_SLOTS_WEBVIEW_NAME = 'HubSlotsWebview';

interface SlotData {
    index: number;
    hasCode: boolean;
    size?: number;
}

interface HubSlotsMessage {
    command: 'refresh' | 'delete' | 'move';
    slot: number;
    from: number;
    to: number;
}

let slots: SlotData[] = [];

export class HubSlotsPanel {
    private static currentPanel: HubSlotsPanel | undefined;
    private readonly panel: vscode.WebviewPanel;
    private readonly context: { extensionUri: vscode.Uri };
    private readonly client: HubOSBaseClient;
    private _disposables: vscode.Disposable[] = [];

    private constructor(
        context: { extensionUri: vscode.Uri },
        client: HubOSBaseClient,
    ) {
        this.context = context;
        this.client = client;

        this.panel = vscode.window.createWebviewPanel(
            'hubos-slots',
            'Hub Slots Manager',
            vscode.ViewColumn.Beside,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [
                    vscode.Uri.joinPath(context.extensionUri, 'dist'),
                    vscode.Uri.joinPath(context.extensionUri, 'asset'),
                ],
            },
        );

        this.panel.webview.html = this.getHtmlForWebview(this.panel.webview);

        this.panel.webview.onDidReceiveMessage(
            async (message: HubSlotsMessage) => {
                switch (message.command) {
                    case 'refresh':
                        await this.refresh();
                        break;
                    case 'delete':
                        await vscode.commands.executeCommand(
                            Commands.ClearSlot,
                            message.slot,
                        );
                        slots[message.slot].hasCode = false;
                        await this.refresh(true);
                        break;
                    case 'move':
                        await vscode.commands.executeCommand(
                            Commands.MoveSlot,
                            message.from,
                            message.to,
                        );
                        slots[message.from].hasCode = false;
                        slots[message.to].hasCode = true;
                        await this.refresh(true);
                        break;
                }
            },
            null,
            this._disposables,
        );

        this.panel.onDidDispose(() => this.dispose(), null, this._disposables);

        // Initial load
        void this.refresh();
    }

    public static show(context: { extensionUri: vscode.Uri }, client: HubOSBaseClient) {
        if (HubSlotsPanel.currentPanel) {
            HubSlotsPanel.currentPanel.panel.reveal(vscode.ViewColumn.Beside);
            // Update client if needed, or just refresh
            //void HubSlotsPanel.currentPanel.refresh();
        } else {
            HubSlotsPanel.currentPanel = new HubSlotsPanel(context, client);
        }
    }

    public dispose() {
        HubSlotsPanel.currentPanel = undefined;
        this.panel.dispose();
        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) {
                x.dispose();
            }
        }
    }

    private async refresh(allowCache: boolean = false) {
        try {
            if (!allowCache) {
                const occupiedSlots = await this.client.action_list_slots();
                slots = Array.from({ length: HUBOS_SPIKE_SLOTS }, (_, i) => ({
                    index: i,
                    hasCode: occupiedSlots.includes(i),
                }));
            }

            this.panel.webview.postMessage({
                command: 'update',
                slots: slots,
            });
        } catch (e) {
            vscode.window.showErrorMessage(`Failed to refresh slots: ${String(e)}`);
        }
    }

    private getHtmlForWebview(webview: vscode.Webview): string {
        const scriptUri = getScriptUri(
            this.context as vscode.ExtensionContext,
            this.panel,
            HUB_SLOTS_WEBVIEW_NAME,
        );
        const codiconsUri = webview.asWebviewUri(
            vscode.Uri.joinPath(
                this.context.extensionUri,
                'dist',
                'codicons',
                'codicon.css',
            ),
        );
        const nonce = getNonce();

        return `<!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <meta http-equiv="Content-Security-Policy" content="default-src 'none'; font-src ${
                    webview.cspSource
                }; style-src ${
            webview.cspSource
        } 'unsafe-inline'; script-src 'nonce-${nonce}';">
                <link href="${codiconsUri.toString()}" rel="stylesheet" />
                <title>Hub Slots</title>
                <style>
                    * {
                        box-sizing: border-box;
                    }

                    body {
                        font-family: var(--vscode-font-family);
                        font-size: var(--vscode-font-size);
                        font-weight: var(--vscode-font-weight);
                        color: var(--vscode-foreground);
                        background-color: var(--vscode-editor-background);
                        padding: 16px 20px;
                        margin: 0;
                    }

                    .container {
                        max-width: 900px;
                        margin: 0 auto;
                    }

                    .header {
                        display: flex;
                        align-items: center;
                        justify-content: space-between;
                        margin-bottom: 20px;
                    }

                    .title {
                        font-size: 16px;
                        font-weight: 600;
                        margin-bottom: 4px;
                    }

                    .subtitle {
                        font-size: 12px;
                        color: var(--vscode-descriptionForeground);
                    }

                    .header-left {
                        display: flex;
                        flex-direction: column;
                    }

                    .header-actions {
                        display: flex;
                        align-items: center;
                        gap: 8px;
                    }

                    button {
                        padding: 4px 14px;
                        font-size: 13px;
                        font-family: var(--vscode-font-family);
                        line-height: 20px;
                        border: 1px solid transparent;
                        cursor: pointer;
                        outline: none;
                        display: inline-flex;
                        align-items: center;
                        justify-content: center;
                        white-space: nowrap;
                        border-radius: 2px;
                    }

                    button:focus {
                        outline: 1px solid var(--vscode-focusBorder);
                        outline-offset: 2px;
                    }

                    button:disabled {
                        opacity: 0.4;
                        cursor: not-allowed;
                    }

                    .btn-primary {
                        background-color: var(--vscode-button-background);
                        color: var(--vscode-button-foreground);
                    }

                    .btn-primary:hover:not(:disabled) {
                        background-color: var(--vscode-button-hoverBackground);
                    }

                    .btn-primary:active:not(:disabled) {
                        filter: brightness(0.9);
                    }

                    .btn-secondary {
                        background-color: var(--vscode-button-secondaryBackground);
                        color: var(--vscode-button-secondaryForeground);
                    }

                    .btn-secondary:hover:not(:disabled) {
                        background-color: var(--vscode-button-secondaryHoverBackground);
                    }

                    .btn-secondary:active:not(:disabled) {
                        filter: brightness(0.9);
                    }

                    /* Slot List Styles */
                    .slot-list {
                        display: grid;
                        grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
                        gap: 12px;
                        margin-top: 10px;
                    }

                    .slot-item {
                        border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
                        padding: 10px 12px;
                        border-radius: 4px;
                        display: flex;
                        justify-content: space-between;
                        align-items: center;
                        transition: background-color 0.1s ease-out, border-color 0.1s ease-out;
                        min-height: 44px;
                    }

                    .slot-item.occupied {
                        background-color: var(--vscode-list-activeSelectionBackground);
                        color: var(--vscode-list-activeSelectionForeground);
                        border-color: var(--vscode-list-activeSelectionForeground);
                    }
                    
                    .slot-item.occupied .slot-info {
                         color: var(--vscode-list-activeSelectionForeground);
                    }

                    .slot-item.empty {
                        opacity: 0.6;
                    }

                    .slot-item:hover {
                        background-color: var(--vscode-list-hoverBackground);
                        border-color: var(--vscode-focusBorder);
                    }
                    
                    /* When occupied and hovered, maybe keep the active selection bg but darken it slightly or just rely on border */
                    .slot-item.occupied:hover {
                        background-color: var(--vscode-list-activeSelectionBackground);
                        filter: brightness(1.1);
                    }

                    .slot-info {
                        display: flex;
                        align-items: center;
                        font-size: 13px;
                        font-weight: 500;
                    }

                    .slot-actions {
                        display: flex;
                        gap: 6px;
                        opacity: 0; /* Hide actions by default until hover */
                        transition: opacity 0.1s ease-in;
                    }

                    .slot-item:hover .slot-actions,
                    .slot-item:focus-within .slot-actions {
                        opacity: 1;
                    }

                    /* Icon button styles for slots */
                    .slot-actions button {
                        padding: 4px;
                        height: 24px;
                        font-size: 14px;
                        background-color: transparent;
                        color: inherit;
                        border: 1px solid transparent;
                    }
                    
                    .slot-actions button:hover {
                        background-color: var(--vscode-toolbar-hoverBackground);
                        border-radius: 4px;
                    }

                    .codicon {
                        font-size: 16px;
                        vertical-align: middle;
                    }
                    
                    .slot-actions .codicon {
                        font-size: 14px;
                    }

                    .refresh-label {
                        margin-left: 6px;
                    }

                    .move-mode .slot-item.target-candidate {
                        border-color: var(--vscode-focusBorder);
                        box-shadow: 0 0 0 2px var(--vscode-focusBorder);
                        cursor: pointer;
                    }

                    .move-mode .slot-item.target-candidate:hover {
                        background-color: var(--vscode-editor-selectionHighlightBackground);
                    }
                    
                    /* Keyboard shortcut badge */
                    .kbd {
                        font-size: 10px;
                        margin-left: 4px;
                        padding: 0 4px;
                        background-color: var(--vscode-keybindingLabel-background);
                        color: var(--vscode-keybindingLabel-foreground);
                        border: 1px solid var(--vscode-keybindingLabel-border);
                        border-radius: 3px;
                        box-shadow: inset 0 -1px 0 var(--vscode-keybindingLabel-bottomBorder, var(--vscode-keybindingLabel-border));
                        font-family: var(--vscode-font-family);
                        line-height: 14px;
                        display: inline-block;
                        vertical-align: middle;
                    }
                </style>
            </head>
            <body>
                <div class="container">
                    <div class="header">
                        <div class="header-left">
                            <div class="title">Hub Slots</div>
                            <div class="subtitle">Manage program slots on your hub. Use move to copy code between slots.</div>
                        </div>
                        <div class="header-actions">
                            <button id="refresh-btn" class="btn-primary">
                                <span class="codicon codicon-sync"></span>
                                <span class="refresh-label">Refresh</span>
                            </button>
                        </div>
                    </div>
                    <div id="slot-list" class="slot-list"></div>
                </div>
                <script nonce="${nonce}" src="${String(scriptUri)}"></script>
            </body>
            </html>`;
    }
}
