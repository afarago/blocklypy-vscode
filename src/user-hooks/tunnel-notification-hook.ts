import * as vscode from 'vscode';

import { HubOSBaseClient } from '../communication/clients/hubos-base-client';
import { ConnectionManager } from '../communication/connection-manager';
import { logDebug } from '../extension';
import Config, { FeatureFlags } from '../extension/config';
import { plotManager } from '../plot/plot';
import { TunnelRequestMessage } from '../spike/messages/tunnel-request-message';
import {
    TunnelMessageType,
    TunnelPayload,
    TunnelWeatherForecastCondition,
} from '../spike/utils/tunnel-notification-parser';
import { sleep } from '../utils';

export async function handleTunneleNotificationAsync(
    payloads: TunnelPayload[] | undefined,
) {
    if (!payloads) return;

    for (const msg of payloads ?? []) {
        if (Config.FeatureFlag.get(FeatureFlags.LogTunnelNotification)) {
            console.debug(
                `[HubOS:TunnelMessage] ${TunnelMessageType[msg.type]}, ${JSON.stringify(
                    msg,
                )}`,
            );
        }

        // TODO: handle these messages
        // BarGraphChange
        // DisplayNextImage
        // GraphShow
        // DisplayHide,

        switch (msg.type) {
            case TunnelMessageType.LineGraphPlot:
                // CHECK: how about not ignoring x for LineGraphPlot
                plotManager.setCellData(`color_${msg.color}`, msg.y);
                break;

            case TunnelMessageType.BarGraphSetValue:
                plotManager.setCellData(`color_${msg.color}`, msg.value);
                break;

            case TunnelMessageType.GraphClear:
                plotManager.clear();
                break;

            case TunnelMessageType.LineGraphRequestValue:
            case TunnelMessageType.BarGraphRequestValue: {
                await sendGraphRequestValueResponseAsync(msg);
                break;
            }

            case TunnelMessageType.DisplayText:
            case TunnelMessageType.DisplayTextForTime: {
                logDebug(`ℹ️ ${msg.text}`);
                break;
            }

            case TunnelMessageType.DisplayImage: {
                logDebug(`🧩🖼️ image_${msg.image}`);
                break;
            }

            case TunnelMessageType.SoundPlay: {
                logDebug(`🧩🔉 Playing sound ${msg.crc}...`);
                break;
            }

            case TunnelMessageType.SoundPlayUntilDone: {
                await sendSoundPlayDoneResponseAsync(msg);
                break;
            }

            case TunnelMessageType.WeatherAtOffsetRequest: {
                await sendWeatherForecastResponseAsync(msg);
                break;
            }
        }
    }
}

async function sendGraphRequestValueResponseAsync(msg: TunnelPayload) {
    if (
        !ConnectionManager.client?.isHubOS ||
        !(ConnectionManager.client instanceof HubOSBaseClient)
    ) {
        return;
    }
    if (
        msg.type !== TunnelMessageType.LineGraphRequestValue &&
        msg.type !== TunnelMessageType.BarGraphRequestValue
    )
        return;

    const column = `color_${msg.color}`;
    const colidx = plotManager.columns.indexOf(column);
    const value = plotManager.latest?.[colidx ?? -1];
    const payload: TunnelPayload = {
        type: TunnelMessageType.GraphValue,
        correlationId: msg.correlationId,
        value: value ?? 0,
    };
    const response = new TunnelRequestMessage([payload]);
    await ConnectionManager.client.sendMessage(response);
}

async function sendWeatherForecastResponseAsync(msg: TunnelPayload) {
    if (
        !ConnectionManager.client?.isHubOS ||
        !(ConnectionManager.client instanceof HubOSBaseClient)
    ) {
        return;
    }

    if (msg.type !== TunnelMessageType.WeatherAtOffsetRequest) return;

    const input = await vscode.window.showInputBox({
        title: 'Answer to Hub: WeatherAtOffsetRequest',
        prompt: `WeatherAtOffsetRequest received. Enter any text to send example response back to the hub.\n\nFormat: "location|temperature|windSpeed|precipitation|condition|windDirection|pressure|offset"\n`,
        value: 'Budapest | 12.3 | 21.5 | 0.1 | 1 | NE | 1013 | 0',
        valueSelection: [0, 0],
        ignoreFocusOut: true,
    });
    if (input === undefined) return; // cancelled
    const [
        location,
        temperature,
        windSpeed,
        precipitation,
        condition,
        windDirection,
        pressure,
        offset,
    ] = input.split('|').map((s) => s.trim());

    const payload = {
        type: TunnelMessageType.WeatherForecast,
        correlationId: msg.correlationId,
        location,
        temperature: parseFloat(temperature),
        windSpeed: parseFloat(windSpeed),
        precipitation: parseFloat(precipitation),
        condition: parseInt(condition, 10) as TunnelWeatherForecastCondition,
        windDirection,
        pressure: parseFloat(pressure),
        offset: parseInt(offset),
    } as TunnelPayload;

    const response1 = new TunnelRequestMessage([payload]);
    await ConnectionManager.client.sendMessage(response1);
}

async function sendSoundPlayDoneResponseAsync(msg: TunnelPayload) {
    if (
        !ConnectionManager.client?.isHubOS ||
        !(ConnectionManager.client instanceof HubOSBaseClient)
    ) {
        return;
    }
    if (msg.type !== TunnelMessageType.SoundPlayUntilDone) return;
    const client = ConnectionManager.client;
    logDebug(`🧩🔉 Playing sound ${msg.crc} until done...`);

    await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: `Playing sound...`,
            cancellable: false,
        },
        async () => {
            if (!client.connected || !client.sendMessage) return;

            // Just wait 1 seconds here, as we don't have a notification when the sound is done
            await sleep(1000);

            // Send SoundDone message back to the hub
            const response1 = new TunnelRequestMessage([
                {
                    type: TunnelMessageType.SoundDone,
                    correlationId: msg.correlationId,
                } as TunnelPayload,
            ]);
            await client.sendMessage(response1);
        },
    );
}
