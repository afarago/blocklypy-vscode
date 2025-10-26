import * as vscode from 'vscode';

import { ConnectionManager } from '../communication/connection-manager';
import { logDebug } from '../extension';
import { Commands } from '../extension/commands';
import Config, { ConfigKeys, FeatureFlags } from '../extension/config';
import { hasState, StateProp } from '../logic/state';
import { handleDeviceNotificationForPlotAsync } from '../plot/hubos-plot-helper';
import {
    DeviceNotificationMessageType,
    DeviceNotificationPayload,
} from '../spike/utils/device-notification-parser';

let lastDeviceNotificationPayloads: DeviceNotificationPayload[] | undefined = undefined;
export const setLastDeviceNotificationPayloads = (
    payloads: DeviceNotificationPayload[] | undefined,
) => {
    // const last = lastDeviceNotificationPayloads;
    // store last payloads
    lastDeviceNotificationPayloads = payloads;

    // // check if last payloads are the same as new ones, if not trigger Commands.PromptDeviceNotificationPlotFilter
    // const groups1 = new Set(
    //     last?.map((p) => deviceNotificationToFilterString(p, '').group),
    // );
    // const groups2 = new Set(
    //     payloads?.map((p) => deviceNotificationToFilterString(p, '').group),
    // );
    // const hasNewGroups = [...groups2].some((g) => !groups1.has(g));
    // if (hasNewGroups) {
    //     // prompt user to update the device notification plot filter when payloads change
    //     vscode.commands.executeCommand(Commands.PromptDeviceNotificationPlotFilter);
    // }
};
export function getLastDeviceNotificationPayloads() {
    return lastDeviceNotificationPayloads;
}

// eslint-disable-next-line @typescript-eslint/require-await
export async function handleDeviceNotificationAsync(
    payloads: DeviceNotificationPayload[] | undefined,
) {
    // const previous = getLastDeviceNotificationPayloads();
    // const isFirstPacketAfterStartup = previous === undefined && payloads !== undefined;
    // TODO: implement getting a prompt after connect to pybricks and receiving first packet
    // if (isFirstPacketAfterStartup) {
    //     vscode.commands.executeCommand(Commands.PromptDeviceNotificationPlotFilter);
    // }
    setLastDeviceNotificationPayloads(payloads);

    if (Config.FeatureFlag.get(FeatureFlags.LogDeviceNotification)) {
        const payloadsToLog = payloads?.map((p) => {
            const kind = DeviceNotificationMessageType[p.type];
            return { kind, ...p };
        });
        logDebug(`DeviceNotificationPayload: ${JSON.stringify(payloadsToLog)}`);
    }

    if (Config.FeatureFlag.get(FeatureFlags.PlotDeviceNotification)) {
        // TODO: later just check if _any_ notifications come from, maybe register sources for plotmanager

        // Pybricks can send it while app is running, hubOS sends both in idle and running state
        // hubOS: only use this while in idle state // TODO: later revisit this
        if (
            ConnectionManager.client?.isPybricks ||
            (ConnectionManager.client?.isHubOS && !hasState(StateProp.Running))
        ) {
            handleDeviceNotificationForPlotAsync(payloads ?? []);
        }
    }
}

export async function updateDeviceNotifications() {
    // periodic notifications
    const enabled =
        Config.FeatureFlag.get(FeatureFlags.LogDeviceNotification) ||
        Config.FeatureFlag.get(FeatureFlags.PlotDeviceNotification);

    if (enabled) {
        const filter = Config.get<string>(ConfigKeys.DeviceNotificationPlotFilter, '');
        if (filter?.length === 0) {
            vscode.commands.executeCommand(Commands.PromptDeviceNotificationPlotFilter);
        }

        if (ConnectionManager.client?.connected && ConnectionManager.client?.isHubOS) {
            await ConnectionManager.client.updateDeviceNotifications();
        }
    }
}
