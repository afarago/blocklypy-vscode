import { logDebug } from '../extension';
import { showWarning } from '../extension/diagnostics';
import {
    DebugMessage,
    DebugSubCode,
    DebugVarType,
    Message,
    MessageType,
} from '../pybricks/appdata-instrumentation-protocol';
import { DebugTunnel } from './debug-tunnel';

export async function handleIncomingAIPPDebug(
    message: DebugMessage,
): Promise<Message | undefined> {
    if (message.Id !== MessageType.DebugNotification) return;
    switch (message.subcode) {
        case DebugSubCode.StartNotification: {
            // Start

            // send acknowledge
            const canAcknoledge = DebugTunnel.isDebugging();
            await DebugTunnel.sendToHub({
                Id: MessageType.DebugAcknowledge,
                subcode: DebugSubCode.StartAcknowledge,
                success: canAcknoledge,
            });

            // send to debug tunnel
            if (canAcknoledge) {
                logDebug('🐞 Hub started debug session');
                await DebugTunnel.onHubMessage({ type: 'start' });
            } else {
                showWarning('No debugger connected, not acknowledging start.');
            }

            break;
        }

        case DebugSubCode.TrapNotification: {
            // Trap
            const message1 = message as DebugMessage & {
                filename: string;
                line: number;
                variables: Map<string, DebugVarType>;
            };
            const filename = message1.filename;
            const line = message1.line;
            const variables = message1.variables;
            logDebug(
                `⏸️ Hub paused at debug breakpont at ${filename}:${line} ${
                    variables ? JSON.stringify(Object.fromEntries(variables)) : ''
                }`,
                filename,
                line,
                true,
            );

            // send acknowledge
            const canAcknowledge =
                DebugTunnel.isDebugging() &&
                !!DebugTunnel._runtime?.canStopOnLocation(filename, line);
            await DebugTunnel.sendToHub({
                Id: MessageType.DebugAcknowledge,
                subcode: DebugSubCode.TrapAcknowledge,
                success: canAcknowledge,
            });

            if (canAcknowledge) {
                // send to debug tunnel
                await DebugTunnel.onHubMessage({
                    type: 'trap',
                    payload: { filename, line, variables },
                });
            }
            break;
        }

        case DebugSubCode.ContinueResponse: {
            const message1 = message as DebugMessage & { step: boolean };
            const step = message1.step;
            DebugTunnel._runtime?.setResumeMode(step);
            break;
        }
    }
}

// const handleTrapMock = async () => {
//     // resume execution after a short delay
//     const input = await vscode.window.showInputBox({
//         title: 'Answer to Hub: HubTrapRequest',
//         // prompt: `WeatherAtOffsetRequest received. Enter any text to send example response back to the hub.\n\nFormat: "location|temperature|windSpeed|precipitation|condition|windDirection|pressure|offset"\n`,
//         // value: 'Budapest | 12.3 | 21.5 | 0.1 | 1 | NE | 1013 | 0',
//         valueSelection: [0, 0],
//         ignoreFocusOut: true,
//     });
//     if (!input) {
//         console.log('No input, not sending response');
//         return;
//     }
//     await this.sendAppiData(
//         new Uint8Array([PIPMessageType.DebugAcknowledge, 0x04]),
//     );
// };
// setTimeout(() => void handleTrapMock(), 0);
