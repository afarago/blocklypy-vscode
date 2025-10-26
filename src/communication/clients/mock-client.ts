import { type ClientClassDescriptor } from '.';
import { RefreshTree } from '../../extension';
import { type DeviceMetadata, LayerKind } from '../layers';
import { BaseClient } from './base-client';

export class MockClient extends BaseClient {
    public static override readonly classDescriptor: ClientClassDescriptor = {
        os: undefined,
        layer: LayerKind.MOCK,
        deviceType: 'mock',
        description: 'Mock Device',
        supportsModularMpy: true,
        requiresSlot: false,
    };

    private _connected: boolean = false;

    public override get descriptionKVP(): [string, string][] {
        return [] as [string, string][];
    }

    public get connected() {
        return this._connected;
    }

    // eslint-disable-next-line @typescript-eslint/require-await
    protected async connectWorker(
        _onDeviceUpdated: (device: DeviceMetadata) => void,
        onDeviceRemoved: (device: DeviceMetadata, id?: string) => void,
    ) {
        const metadata = this.metadata;
        if (!metadata) throw new Error('No metadata client');

        this._connected = true;
        this._exitStack.push(() => {
            if (onDeviceRemoved) onDeviceRemoved(metadata);
            RefreshTree();
        });
    }

    protected override async disconnectWorker() {
        this._connected = false;

        // forced, even ok to remove current client

        RefreshTree(true);

        return Promise.resolve();
    }

    public async write(_data: Uint8Array, _withoutResponse: boolean = false) {
        // NOOP
    }

    protected async handleIncomingData(_data: Buffer): Promise<void> {
        // NOOP
    }

    public override async sendTerminalUserInputAsync(_text: string) {
        // NOOP
    }
}
