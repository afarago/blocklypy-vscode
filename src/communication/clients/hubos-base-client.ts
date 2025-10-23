import * as vscode from 'vscode';

import fastq, { queueAsPromised } from 'fastq';
import { DeviceMetadata } from '..';
import { Commands } from '../../extension/commands';
import Config, { ConfigKeys, FeatureFlags } from '../../extension/config';
import { logDebug } from '../../extension/debug-channel';
import { FILENAME_SAMPLE_COMPILED } from '../../logic/compile';
import { setState, StateProp } from '../../logic/state';
import { maybe } from '../../pybricks/utils';
import { HUBOS_SPIKE_SLOTS } from '../../spike';
import { decodeHubOSInboundMessage } from '../../spike/messages';
import {
    BaseMessage,
    InboundMessage,
    OutboundMessage,
} from '../../spike/messages/base-message';
import { ClearSlotRequestMessage } from '../../spike/messages/clear-slot-request-message';
import { ClearSlotResponseMessage } from '../../spike/messages/clear-slot-response-message';
import { ConsoleNotificationMessage } from '../../spike/messages/console-notification-message';
import { DeviceNotificationMessage } from '../../spike/messages/device-notification-message';
import { DeviceNotificationRequestMessage } from '../../spike/messages/device-notification-request-message';
import { InfoRequestMessage } from '../../spike/messages/info-request-message';
import {
    InfoResponse,
    InfoResponseMessage,
    ProductGroupDeviceTypeMap,
} from '../../spike/messages/info-response-message';
import { MoveSlotRequestMessage } from '../../spike/messages/move-slot-request-message';
import { MoveSlotResponseMessage } from '../../spike/messages/move-slot-response-message';
import { ProgramFlowNotificationMessage } from '../../spike/messages/program-flow-notification-message';
import { ProgramFlowRequestMessage } from '../../spike/messages/program-flow-request-message';
import { StartFileUploadRequestMessage } from '../../spike/messages/start-file-upload-request-message';
import { StartFileUploadResponseMessage } from '../../spike/messages/start-file-upload-response-message';
import { TransferChunkRequestMessage } from '../../spike/messages/transfer-chunk-request-message';
import { TransferChunkResponseMessage } from '../../spike/messages/transfer-chunk-response-message';
import { TunnelNotificationMessage } from '../../spike/messages/tunnel-notification-message';
import { pack, unpack } from '../../spike/utils/cobs';
import { DeviceNotificationPayload } from '../../spike/utils/device-notification-parser';
import { TunnelPayload } from '../../spike/utils/tunnel-notification-parser';
import { handleDeviceNotificationAsync } from '../../user-hooks/device-notification-hook';
import { handleTunneleNotificationAsync } from '../../user-hooks/tunnel-notification-hook';
import { withTimeout } from '../../utils/async';
import { BaseLayer } from '../layers/base-layer';
import { crc32WithAlignment } from '../utils';
import { BaseClient, StartMode } from './base-client';

const SPIKE_RECEIVE_MESSAGE_TIMEOUT = 5000;
// const FINALIZE_CAPABILITIES_RETRIES = 5;
const HUBOS_DEVICE_NOTIFICATION_INTERVAL = 250;

export abstract class HubOSBaseClient extends BaseClient {
    private _capabilities: InfoResponse | undefined;
    private _pendingMessagesPromises = new Map<
        number,
        [
            (result: InboundMessage | PromiseLike<InboundMessage>) => void,
            (e: string) => void,
        ]
    >();
    private _incomingDataQueue: queueAsPromised<InboundMessage>;
    private _deviceNotificationQueue: queueAsPromised<DeviceNotificationPayload[]>;
    private _tunnelPayloadQueue: queueAsPromised<TunnelPayload[]>;
    private _consoleMessageQueue: queueAsPromised<string>;

    public get capabilities() {
        return this._capabilities;
    }

    public get descriptionKVP(): [string, string][] {
        const retval: [string, string][] = [];
        const deviceDescription = this.classDescriptor.description;
        if (deviceDescription) retval.push(['type', deviceDescription]);

        const capabilities = this._capabilities;
        if (!capabilities) return retval;

        const hubType = ProductGroupDeviceTypeMap[capabilities.productGroupDeviceType];
        if (hubType) retval.push(['hubType', hubType]);
        const { rpcMajor, rpcMinor, rpcBuild, fwMajor, fwMinor, fwBuild } =
            capabilities;
        retval.push(['firmware', `${fwMajor}.${fwMinor}.${fwBuild}`]);
        retval.push(['software', `${rpcMajor}.${rpcMinor}.${rpcBuild}`]);
        if (this.uniqueSerial) retval.push(['serial', this.uniqueSerial]);

        return retval;
    }

    constructor(_metadata: DeviceMetadata | undefined, parent: BaseLayer) {
        super(_metadata, parent);

        this._incomingDataQueue = fastq.promise(async (message: InboundMessage) => {
            // console.log(`Processing message: 0x${message.Id.toString(16)}`);
            await this.handleIncomingMessage(message);
        }, 1);

        // handle console messages
        this._consoleMessageQueue = fastq.promise(async (text: string) => {
            await this.handleWriteStdout(text);
        }, 1);

        // user hooks, to be reworked later
        this._deviceNotificationQueue = fastq.promise(
            async (payload: DeviceNotificationPayload[]) => {
                await handleDeviceNotificationAsync(payload);
            },
            1,
        );
        this._tunnelPayloadQueue = fastq.promise(async (payload: TunnelPayload[]) => {
            await handleTunneleNotificationAsync(payload);
        }, 1);
    }

    public async finalizeConnect() {
        const response = await this.sendMessage<InfoResponseMessage>(
            new InfoRequestMessage(),
        );
        if (response?.info) this._capabilities = response.info;
        // response will be handled in handleIncomingDataAsync (as well)

        if (!this._capabilities) {
            throw new Error(
                'Failed to get capabilities or resolved name from HubOS device',
            );
        }

        await this.updateDeviceNotifications();
        const reg1 = Config.onChanged.event(async (e) => {
            if (!e.affectsConfiguration(Config.getKey(ConfigKeys.FeatureFlags))) return;
            await this.updateDeviceNotifications();
        });
        this._exitStack.push(() => void reg1.dispose());
    }

    public override async updateDeviceNotifications(): Promise<void> {
        // periodic notifications
        const enabled =
            Config.FeatureFlag.get(FeatureFlags.LogDeviceNotification) ||
            Config.FeatureFlag.get(FeatureFlags.PlotDeviceNotification);

        if (enabled) {
            const filter = Config.get<string>(
                ConfigKeys.DeviceNotificationPlotFilter,
                '',
            );
            if (filter?.length === 0) {
                vscode.commands.executeCommand(
                    Commands.PromptDeviceNotificationPlotFilter,
                );
            }

            await this.sendMessage(
                new DeviceNotificationRequestMessage(
                    enabled ? HUBOS_DEVICE_NOTIFICATION_INTERVAL : 0,
                ),
            );
        }
    }

    public async sendMessage<TResponse extends InboundMessage>(
        message: OutboundMessage,
    ): Promise<TResponse | undefined> {
        const payload = pack(message.serialize());
        const resultTypeId = message.acceptsResponse();
        const resultPromise = new Promise<InboundMessage>((resolve, reject) => {
            this._pendingMessagesPromises.set(resultTypeId, [resolve, reject]);
        });

        await this.write(payload, true);

        const [response, _] = await maybe(
            withTimeout<TResponse>(
                resultPromise as Promise<TResponse>,
                SPIKE_RECEIVE_MESSAGE_TIMEOUT,
            ),
        );
        return response;
    }

    public async handleIncomingData(data: Buffer) {
        const unpacked = unpack(data);

        // console.log(
        //     `Received frame: len:${unpacked.length}, data:${Buffer.from(
        //         unpacked,
        //     ).toString('hex')}`,
        // );
        try {
            const [_, message] = decodeHubOSInboundMessage(unpacked);
            if (!message) {
                logDebug(
                    `Failed to decode message frame: ${Buffer.from(unpacked).toString(
                        'hex',
                    )}`,
                );
                return;
            }

            // this.onIncomingMessage.fire(message);
            // this.handleIncomingMessage(message);
            await this._incomingDataQueue.push(message);
        } catch (e) {
            logDebug(`Error handling message: ${String(e)}`);
        }
    }

    private async handleIncomingMessage(message: BaseMessage) {
        try {
            // logDebug(`Received message: 0x${id.toString(16)}`);
            const id = message.Id;
            const pending = this._pendingMessagesPromises.get(id);
            if (pending) {
                pending[0](message);
                pending[1] = () => {}; // prevent memory leaks
                this._pendingMessagesPromises.delete(id);
            }

            switch (id) {
                case InfoResponseMessage.Id: {
                    const infoMsg = message as InfoResponseMessage;
                    this._capabilities = infoMsg.info;
                    console.log('Capabilities:', this._capabilities);
                    break;
                }
                case DeviceNotificationMessage.Id: {
                    const deviceMsg = message as DeviceNotificationMessage;
                    await this._deviceNotificationQueue.push(deviceMsg.payloads);
                    break;
                }
                case ProgramFlowNotificationMessage.Id: {
                    const programFlowMsg = message as ProgramFlowNotificationMessage;
                    setState(StateProp.Running, programFlowMsg.action === 0);
                    break;
                }
                case ConsoleNotificationMessage.Id: {
                    const consoleMsg = message as ConsoleNotificationMessage;
                    await this._consoleMessageQueue.push(consoleMsg.text);
                    break;
                }
                case TunnelNotificationMessage.Id: {
                    const tunnelMsg = message as TunnelNotificationMessage;
                    await this._tunnelPayloadQueue.push(tunnelMsg.tunnelData);
                    break;
                }
            }
        } catch (e) {
            logDebug(`Error decoding message: ${String(e)}`);
            return;
        }
    }

    public override async action_start(
        slot?: number | StartMode,
        _replContent?: string,
    ) {
        if (typeof slot !== 'number') throw new Error('Start slot must be a number');
        await this.sendMessage(new ProgramFlowRequestMessage(true, slot)); // 1 = start
    }

    public override async action_stop() {
        await this.sendMessage(new ProgramFlowRequestMessage(false)); // 0 = stop
        // hubos-usb does not send a notification when stopping the program, so we set it here
        setState(StateProp.Running, false);
    }

    public override async action_upload(
        data: Uint8Array,
        slot: number,
        filename?: string,
    ) {
        if (!this._capabilities) return;

        const uploadSize = data.byteLength;

        // initiate upload
        const clearResponse = await this.sendMessage<ClearSlotResponseMessage>(
            new ClearSlotRequestMessage(slot),
        );
        if (!clearResponse?.success) console.warn(`Failed to clear slot ${slot}`); // not critical

        // watch out for the extension - .mpy or .py repsectively
        const uploadResponse = await this.sendMessage<StartFileUploadResponseMessage>(
            new StartFileUploadRequestMessage(
                filename ?? FILENAME_SAMPLE_COMPILED,
                slot,
                crc32WithAlignment(data),
            ),
        );
        if (!uploadResponse?.success)
            throw new Error(`Failed to initiate file upload to ${slot}`);

        const blockSize: number = this._capabilities.maxChunkSize;
        // const increment = (1 / Math.ceil(uploadSize / blockSize)) * 100;
        let runningCrc = 0;

        for (let loop = 0; loop < uploadSize; loop += blockSize) {
            const chunk = data.slice(loop, loop + blockSize);
            runningCrc = crc32WithAlignment(chunk, runningCrc);

            const resp = await this.sendMessage<TransferChunkResponseMessage>(
                new TransferChunkRequestMessage(runningCrc, new Uint8Array(chunk)),
            );
            if (!resp?.success) console.warn('Failed to send chunk'); // TODO: retry?
            //progress?.report({ increment });
            // await sleep(100); // let the hub finish processing the last chunk
        }
    }

    public override async action_move_slot(from: number, to: number): Promise<boolean> {
        if (from === to) return false;

        if (from < 0 || from >= HUBOS_SPIKE_SLOTS)
            throw new Error(`Source slot ${from} is out of range`);
        if (to < 0 || to >= HUBOS_SPIKE_SLOTS)
            throw new Error(`Destination slot ${to} is out of range`);

        const response = await this.sendMessage<MoveSlotResponseMessage>(
            new MoveSlotRequestMessage(from, to),
        );

        return !!response?.success;
    }

    public override async action_clear_slot(slot: number): Promise<boolean> {
        const response = await this.sendMessage<ClearSlotResponseMessage>(
            new ClearSlotRequestMessage(slot),
        );
        return !!response?.success;
    }

    public override async action_clear_all_slots(): Promise<{
        completed: number[];
        failed: number[];
    }> {
        const completed = [] as number[];
        const failed = [] as number[];
        for (let slot = 0; slot < HUBOS_SPIKE_SLOTS; slot++) {
            const response = await this.sendMessage<ClearSlotResponseMessage>(
                new ClearSlotRequestMessage(slot),
            );

            const success = !!response?.success;
            if (success) completed.push(slot);
            else failed.push(slot);
        }
        return { completed, failed };
    }
}
