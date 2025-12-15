import * as vscode from 'vscode';
import { HUBOS_SPIKE_SLOTS } from '../spike';

const HUBOS_SLOTS = Array(HUBOS_SPIKE_SLOTS).fill(0);
    ;
export async function pickSlot(
    message: string,
    slots: number[] | undefined = undefined,
): Promise<number | undefined> {
    const picked = await vscode.window.showQuickPick(
        (slots ?? HUBOS_SLOTS).map((_, i) => i.toString()),
        {
            placeHolder: `${message} (0-${HUBOS_SPIKE_SLOTS - 1})`,
        },
    );
    const retval = parseInt(picked || '');
    if (Number.isNaN(retval)) return undefined;
    return retval;
}
