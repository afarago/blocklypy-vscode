import * as vscode from 'vscode';

import { RefreshTree } from '.';
import { ConnectionManager } from '../communication/connection-manager';
import { EXTENSION_KEY } from '../const';
import {
    hasState,
    onStateChange,
    setState,
    StateChangeEvent,
    StateProp,
} from '../logic/state';
import { clearStdOutDataHelpers } from '../logic/stdout-helper';
import { setLastDeviceNotificationPayloads } from '../user-hooks/device-notification-hook';
import {
    BlocklypyViewerContentAvailabilityMap,
    ViewType,
} from '../views/BlocklypyViewerProvider';
import { setStatusBarItem } from './statusbar';
import { ToCapialized } from './utils';

const CONTEXT_BASE = EXTENSION_KEY + '.';

// saga like bahaviour for context management
export function registerContextUtils(context: vscode.ExtensionContext) {
    const handleStateChange = (event: StateChangeEvent) => {
        // --- Saga like behavior to handle specific state changes ---
        switch (event.prop) {
            case StateProp.Connected:
                void setContextConnectedDeviceType(
                    ConnectionManager.client?.deviceType,
                );

                setState(StateProp.Running, false);

                if (!event.value) {
                    setStatusBarItem(false);
                } else {
                    setStatusBarItem(
                        true,
                        ConnectionManager.client?.name,
                        ConnectionManager.client?.description,
                    );
                }

                // DevicesTree.refreshCurrentItem();
                RefreshTree();
                break;

            case StateProp.Running:
                if (event.value) clearStdOutDataHelpers();
                setLastDeviceNotificationPayloads(undefined);
                break;

            case StateProp.Debugging:
                RefreshTree();
                if (!event.value) {
                    void vscode.commands.executeCommand(
                        'blocklypy-vscode-commands.focus',
                    );
                }

                break;
        }

        // set all states as context
        Object.values(StateProp).forEach((prop) => {
            vscode.commands.executeCommand(
                'setContext',
                CONTEXT_BASE + 'is' + ToCapialized(String(prop)),
                hasState(prop),
            );
        });

        // refresh commands tree on any state change
        RefreshTree();
    };
    context.subscriptions.push(onStateChange(handleStateChange));

    // -- react on text editor anc custom view changes --
    handleActiveEditorChange(vscode.window.activeTextEditor);
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor((editor) =>
            handleActiveEditorChange(editor),
        ),
    );
}

function handleActiveEditorChange(editor: vscode.TextEditor | undefined) {
    const langId = editor?.document.languageId;
    // TODO: later combine active custom view id too
    vscode.commands.executeCommand(
        'setContext',
        CONTEXT_BASE + 'activeEditorLangId',
        langId,
    );
    // refresh commands tree on any editor change
    // LATER: this is a workaround for the fact that context changes do not trigger a refresh
    RefreshTree();
}

export async function setContextCustomViewType(value: ViewType | undefined) {
    await vscode.commands.executeCommand(
        'setContext',
        CONTEXT_BASE + 'customViewType',
        value,
    );
}

export async function setContextContentAvailability(
    content: BlocklypyViewerContentAvailabilityMap | undefined,
) {
    for (const key in content) {
        await vscode.commands.executeCommand(
            'setContext',
            `${CONTEXT_BASE}contentAvailability.has${ToCapialized(key)}`,
            content[key as keyof BlocklypyViewerContentAvailabilityMap] === true,
        );
    }
}

export async function setContextPlotDataAvailability(value: boolean) {
    await vscode.commands.executeCommand(
        'setContext',
        `${CONTEXT_BASE}isPlotDataAvailable`,
        value,
    );
}

export async function setContextConnectedDeviceType(value: string | undefined) {
    await vscode.commands.executeCommand(
        'setContext',
        `${CONTEXT_BASE}ConnectedDeviceType`,
        value,
    );
}
