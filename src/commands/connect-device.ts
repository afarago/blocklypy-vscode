import * as vscode from 'vscode';
import { ConnectionManager } from '../communication/connection-manager';
import { BLOCKLYPY_COMMANDS_TREE_VIEW_ID, MILLISECONDS_IN_SECOND } from '../const';
import { showError } from '../extension/diagnostics';
import { hasState, StateProp } from '../logic/state';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function connectDeviceAsyncAny(...args: any[]): Promise<any> {
    let id = args[0] as string | undefined;
    let devtype = args[1] as string | undefined;

    if (!id || !devtype) {
        const devices = ConnectionManager.allDevices.map(
            ({ name, deviceType, metadata }) => {
                const layer = ConnectionManager.getLayerForDevice(metadata);
                return {
                    label: metadata.name || name,
                    description:
                        `${layer?.descriptor.name} (${deviceType})` || deviceType,
                    deviceType,
                    id: metadata.id,
                };
            },
        );
        const pick = await vscode.window.showQuickPick(devices, {
            placeHolder: 'Select device',
        });
        if (!pick) return;

        id = pick.id;
        devtype = pick.deviceType;
    }

    await connectDeviceAsync(id, devtype);
}

export async function connectDeviceAsync(id: string, devtype: string) {
    if (!id?.length || !devtype?.length) {
        const items = ConnectionManager.allDevices.map(
            ({ name, deviceType, metadata }) => ({
                label: name,
                description: deviceType,
                deviceType,
                id: metadata.id,
            }),
        );
        if (!items.length) {
            showError('No devices found. Please make sure Bluetooth is on.');
            return;
        }
        id =
            (await vscode.window.showQuickPick(items, { placeHolder: 'Select device' }))
                ?.id ?? '';
    }

    if (hasState(StateProp.Connected)) {
        // same device is to be reconnected
        if (ConnectionManager.client?.id === id) {
            if (
                ConnectionManager.client.parent?.descriptor.canScan &&
                !ConnectionManager.client.parent?.scanning
            ) {
                await ConnectionManager.client.parent?.startScanning();
            }
        }

        await ConnectionManager.disconnect();

        // same device selected, will disappear, and will need to re-appear
        const DEVICE_REAPPEAR_WAIT_MS = 5 * MILLISECONDS_IN_SECOND;
        await ConnectionManager.waitTillAnyDeviceAppearsAsync(
            [id],
            DEVICE_REAPPEAR_WAIT_MS,
        );
    }

    await vscode.window.withProgress(
        {
            location: { viewId: BLOCKLYPY_COMMANDS_TREE_VIEW_ID },
            cancellable: false,
        },
        async () => {
            // if a name is provided, connect directly
            await ConnectionManager.connect(id, devtype);
        },
    );
}
