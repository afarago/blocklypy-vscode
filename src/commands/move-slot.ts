import { ConnectionManager } from '../communication/connection-manager';
import { logDebug } from '../extension/debug-channel';
import { HUBOS_SPIKE_SLOTS } from '../spike';
import { checkHubOSSlotPrerequisites } from './clear-slots';
import { pickSlot } from './utils';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function moveSlotAny(...args: any[]): Promise<any> {
    const from = args[0] as number | undefined;
    const to = args[1] as number | undefined;
    // undefined if (!from || !to) return;

    await moveSlot(from, to);
}

export async function moveSlot(from?: number, to?: number) {
    const client = ConnectionManager.client;
    if (!checkHubOSSlotPrerequisites() || !client) return;

    for (const [key, value] of [
        ['from', from],
        ['to', to],
    ]) {
        if (value === undefined || Number.isNaN(value)) {
            const picked = await pickSlot(`Enter the slot number to move ${key}`);
            if (key === 'from') from = picked;
            else to = picked;
        }
    }

    if (
        typeof from !== 'number' ||
        typeof to !== 'number' ||
        from === to ||
        from < 0 ||
        to < 0 ||
        from >= HUBOS_SPIKE_SLOTS ||
        to >= HUBOS_SPIKE_SLOTS
    ) {
        throw new Error(
            'Invalid slot numbers. Please enter different numbers between 0 and 19.',
        );
    }

    // move slot
    const success = await client.action_move_slot(from, to);
    if (!success) {
        logDebug(`Failed to move slot ${from} to ${to}.`);
        return;
    }

    // show success to user
    logDebug(`Moved program from slot ${from} to ${to}.`);

    // workaround to reset to heart slot - to reset to the heart program
    await ConnectionManager.client!.action_start(from);
}
