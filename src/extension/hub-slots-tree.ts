import * as vscode from 'vscode';
import { HubOSBaseClient } from '../communication/clients/hubos-base-client';
import { ConnectionManager } from '../communication/connection-manager';
import { HUBOS_SPIKE_SLOTS } from '../spike';
import { BaseTreeDataProvider, TreeItemData } from './tree-base';

export interface HubSlotItem extends TreeItemData {
    slotIndex: number;
    occupied: boolean;
}

export class HubSlotsTreeDataProvider extends BaseTreeDataProvider<HubSlotItem> {
    async getChildren(): Promise<HubSlotItem[]> {
        const client = ConnectionManager.client as HubOSBaseClient | undefined;
        const occupiedSlots = client ? await client.action_list_slots() : [];

        const items: HubSlotItem[] = [];
        for (let i = 0; i < HUBOS_SPIKE_SLOTS; i++) {
            const occupied = occupiedSlots.includes(i);
            items.push({
                slotIndex: i,
                occupied,
                title: `Slot ${i}`,
                description: occupied ? 'Occupied' : 'Empty',
                command: '',
                contextValue: occupied ? 'hubSlotOccupied' : 'hubSlotEmpty',
            });
        }
        return items;
    }
}

export function registerHubSlotsTree(
    context: vscode.ExtensionContext,
): HubSlotsTreeDataProvider {
    const provider = new HubSlotsTreeDataProvider();
    provider.init(context);

    const treeview = vscode.window.createTreeView('blocklypy-vscode-hubslots-tree', {
        treeDataProvider: provider,
    });
    context.subscriptions.push(treeview);

    return provider;
}
