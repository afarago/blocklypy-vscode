import * as vscode from 'vscode';

import { ConnectionManager } from '../communication/connection-manager';
import { logDebug } from '../extension/debug-channel';
import { hasState, StateProp } from '../logic/state';
import { pickSlot } from './utils';

export function checkHubOSSlotPrerequisites() {
    if (!hasState(StateProp.Connected) || !ConnectionManager.client) {
        throw new Error('No device selected. Please connect to a device first.');
    }

    if (!ConnectionManager.client?.isHubOS) {
        throw new Error(
            `The connected device (${ConnectionManager.client.deviceType}) does not support clearing all slots.`,
        );
    }

    return true;
}

async function confirmSlotClearByUser(message: string) {
    return (
        (await vscode.window.showWarningMessage(
            `Are you sure you want to clear ${message}? This action cannot be undone.`,
            { modal: true },
            'Yes',
        )) === 'Yes'
    );
}

export async function clearAllSlots() {
    const client = ConnectionManager.client;
    if (!checkHubOSSlotPrerequisites() || !client) return;
    if (!(await confirmSlotClearByUser('all slots'))) return;

    const { completed, failed } = await client.action_clear_all_slots();

    const message = Array.from([
        ['Cleared', completed],
        ['Not cleared', failed],
    ] as const)
        .map(([message, slots]) => `${message} slots: ${slots.join(', ')}`)
        .join(' | ');
    logDebug(`${message}.`);

    // workaround to reset to heart slot
    await client.action_start(0);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function clearSlotAny(...args: any[]) {
    let slot: number | undefined = parseInt((args[0] as string | undefined) ?? '', 10);

    const client = ConnectionManager.client;
    if (!checkHubOSSlotPrerequisites() || !client) return;
    if (slot === undefined || Number.isNaN(slot))
        slot = await pickSlot('Enter the slot number to clear');
    if (slot === undefined || Number.isNaN(slot))
        throw new Error('No slot number provided');

    if (!(await confirmSlotClearByUser(`slot ${slot}`))) return;

    const success = await client?.action_clear_slot(slot);
    if (!success) {
        logDebug(`Failed to clear slot ${slot}. It may be empty or an error occurred.`);
        return;
    }
    logDebug(`Cleared slot ${slot}.`);

    // workaround to reset to heart slot
    await client.action_start(slot);
}
