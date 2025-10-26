import * as vscode from 'vscode';

import { ConnectionManager } from '../communication/connection-manager';
import { showWarning } from '../extension/diagnostics';
import { hasState, onStateChange, StateChangeEvent, StateProp } from '../logic/state';
import {
    AppDataInstrumentationPybricksProtocol,
    DebugSubCode,
    DebugVarType,
    Message,
    MessageType,
} from '../pybricks/appdata-instrumentation-protocol';
import { sleep } from '../utils';
import { IRuntimeVariableType, PybricksTunnelDebugRuntime } from './runtime';

type HubDebugMessage =
    | {
          type: 'start';
      }
    | {
          type: 'trap';
          payload: {
              filename: string;
              line: number;
              variables: Map<string, IRuntimeVariableType>;
          };
      };

export class DebugTunnel {
    static _runtime: PybricksTunnelDebugRuntime | undefined;
    static _state_isTrapped: boolean = false;

    static isDebugging(): boolean {
        return this._runtime !== undefined;
    }

    static async onHubMessage(message: HubDebugMessage) {
        // Handle messages received from the hub

        // scenario 1. no debugger connected -> send exit and close session
        if (!this._runtime) {
            showWarning('No debugger connected, sending exit to hub');
            // await this.sendToHub('exit\n');
            await this.sendToHub({
                Id: MessageType.DebugAcknowledge,
                subcode: DebugSubCode.TerminateRequest,
            });
            return;
        }

        // scenario 2. debugger connected -> handle message
        switch (message.type) {
            case 'start':
                this._state_isTrapped = false;
                break;
            case 'trap':
                this._state_isTrapped = true;
                // debug callback to indicate we are at a breakpoint/trap
                this._runtime.onHubUpdateVariables(message.payload.variables);
                this._runtime.onHubTrapped(message.payload.line);
                break;
        }
    }

    public static async sendToHub(message: Message) {
        let client = ConnectionManager.client;
        const encodeds = AppDataInstrumentationPybricksProtocol.encode(message);
        // logDebug(
        //     `Sending to hub: ${encodeds
        //         .map((encoded) => bufferToHexString(encoded))
        //         .join(' | ')}`,
        // );
        await sleep(100); // small delay to avoid congestion
        for (const encoded of encodeds) {
            await client?.action_sendAppData(encoded);
            // logDebug(`Sent to hub: ${Buffer.from(encoded).toString('hex')}`); //!!
        }
    }

    public static registerRuntime(value: PybricksTunnelDebugRuntime) {
        this._runtime = value;
    }

    public static async deregisterRuntime() {
        if (this._runtime) {
            this._runtime.endSession();
            // this._runtime.dispose();
            this._runtime = undefined;
        }
        // if we are trapped, send exit to hub
        if (this._state_isTrapped) {
            await this.sendToHub({
                Id: MessageType.DebugAcknowledge,
                subcode: DebugSubCode.TrapAcknowledge,
                success: false,
            });
            this._state_isTrapped = false;
        }
    }

    public static async stopSession() {
        if (this._runtime) {
            this._runtime.endSession();
            // this._runtime.dispose();
            this._runtime = undefined;
        }
        // if we are running, stop
        if (hasState(StateProp.Running)) {
            // vscode.commands.executeCommand('workbench.action.debug.stop');
            await ConnectionManager.client?.action_stop();
        }
    }

    public static async performContinueAfterTrap(step: boolean) {
        if (!this._state_isTrapped) return;
        this._state_isTrapped = false;
        await this.sendToHub({
            Id: MessageType.DebugAcknowledge,
            subcode: DebugSubCode.ContinueRequest,
            step,
        });
    }

    public static async performSetVariable(
        _varName: string,
        value: IRuntimeVariableType,
    ) {
        if (!this._state_isTrapped) return;
        let value1: DebugVarType = null;
        switch (typeof value) {
            case 'string':
            case 'number':
            case 'boolean':
                value1 = value;
                break;
            default:
                value1 = null;
                if (value1 === undefined || value1 === null) break;

                showWarning(
                    `Unsupported variable type for setting variable: ${typeof value}`,
                );
                return;
        }

        await this.sendToHub({
            Id: MessageType.DebugAcknowledge,
            subcode: DebugSubCode.SetVariableRequest,
            varname: _varName,
            value: value1,
        });
        //TODO: await response and check for ack or error
    }

    public static canStartSession(): boolean {
        return hasState(StateProp.Connected) === true;
    }
}

export function registerDebugTunnel(context: vscode.ExtensionContext) {
    // eslint-disable-next-line @typescript-eslint/require-await
    const handleStateChange = async (event: StateChangeEvent) => {
        if (
            (event.prop === StateProp.Connected && !event.value) ||
            (event.prop === StateProp.Running && !event.value)
        ) {
            vscode.debug.stopDebugging();
        }
    };
    context.subscriptions.push(onStateChange(handleStateChange));
}
