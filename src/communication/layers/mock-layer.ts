import * as vscode from 'vscode';

import { DeviceMetadata, LayerKind } from '.';
import { MockClient } from '../clients/mock-client';
import { ConnectionState } from '../index';
import { BaseLayer, DeviceChangeEvent, LayerDescriptor } from './base-layer';
// import { setInterval } from 'timers/promises';

export class MockDeviceMetadata extends DeviceMetadata {
    public mockid: string = 'mock-device-001';
    public override get name(): string | undefined {
        return this.mockid;
    }
}
export class MockLayer extends BaseLayer {
    public static override readonly descriptor: LayerDescriptor = {
        id: 'mock',
        name: 'Mock',
        kind: LayerKind.MOCK,
        canScan: false,
    } as const;

    private _supportsHotPlug: boolean = false;
    private _scanHandle: NodeJS.Timeout | undefined = undefined;
    private _isWithinScan: boolean = false;

    public override supportsDevtype(_devtype: string) {
        return _devtype === MockClient.deviceType;
    }

    // eslint-disable-next-line @typescript-eslint/require-await
    public override async initialize() {
        this.state = ConnectionState.Disconnected; // initialized successfully
    }

    public override async connect(id: string, devtype: string): Promise<void> {
        const metadata = this._allDevices.get(id);
        if (!metadata) {
            throw new Error(`Device ${id} not found.`);
        }

        switch (metadata.deviceType) {
            case MockClient.deviceType:
                BaseLayer.activeClient = new MockClient(metadata, this);
                break;
            default:
                throw new Error(`Unknown device type: ${metadata.deviceType}`);
        }

        await super.connect(id, devtype);
    }

    // public override async disconnect() {
    //     await super.disconnect();
    // }

    public override waitForReadyPromise(): Promise<void> {
        return Promise.resolve();
    }

    public override async manualConnect(): Promise<void> {
        await vscode.window
            .showInformationMessage(
                'Do you want to connect to the mock device?',
                { modal: true },
                'Yes',
                'No',
            )
            .then(async (selection) => {
                if (selection === 'Yes') {
                    const mockDeviceMetadata = new MockDeviceMetadata(
                        MockClient.deviceType,
                    );
                    mockDeviceMetadata.validTill = 0;
                    mockDeviceMetadata.reuseAfterReconnect = false;
                    this._allDevices.set(mockDeviceMetadata.id, mockDeviceMetadata);
                    this._deviceChange.fire({
                        metadata: mockDeviceMetadata,
                        layer: this,
                    } satisfies DeviceChangeEvent);

                    await this.connect(mockDeviceMetadata.id, MockClient.deviceType);
                }
            });
    }
}
