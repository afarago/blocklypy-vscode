import { DeviceMetadata, LayerKind } from '.';
import { ConnectionState } from '../index';
import { BaseLayer, LayerDescriptor } from './base-layer';
// import { setInterval } from 'timers/promises';

export class DeviceMetadataForWebUSB extends DeviceMetadata {
    private _resolvedName: string | undefined = undefined;

    constructor(
        public devtype: string,
        public portinfo: SerialPortInfo,
        public serialNumber: string,
    ) {
        super(devtype);
    }

    public override get name(): string | undefined {
        return this._resolvedName ?? this.portinfo.locationId; //!!
    }

    public override set name(_value: string | undefined) {
        this._resolvedName = _value;
    }

    public get hasResolvedName(): boolean {
        return this._resolvedName !== undefined;
    }

    public override get id(): string {
        return DeviceMetadata.generateId(this.devtype, this.portinfo.locationId); //!! .path);
    }
}

export class USBWebLayer extends BaseLayer {
    public static override readonly descriptor: LayerDescriptor = {
        id: 'webusb',
        name: 'Web Universal Serial Bus',
        kind: LayerKind.USB,
        canScan: false,
    } as const;

    public override supportsDevtype(_devtype: string) {
        return false;
        // return HubOSUsbClient.deviceType === _devtype; //!!
    }

    // eslint-disable-next-line @typescript-eslint/require-await
    public override async initialize() {
        this.state = ConnectionState.Disconnected; // initialized successfully
    }

    public override async connect(id: string, devtype: string): Promise<void> {
        //!!
        // const metadata = this._allDevices.get(id) as DeviceMetadataForUSB;
        // if (!metadata) {
        //     throw new Error(`Device ${id} not found.`);
        // }

        // switch (metadata.devtype) {
        //     case HubOSUsbClient.deviceType:
        //         BaseLayer.activeClient = new HubOSUsbClient(metadata, this);
        //         break;
        //     // case PybricksUsbClient.devtype:
        //     //     this._client = new PybricksUsbClient(metadata);
        //     //     break;
        //     default:
        //         throw new Error(`Unknown device type: ${metadata.devtype}`);
        // }

        await super.connect(id, devtype);
    }

    public override waitForReadyPromise(): Promise<void> {
        return Promise.resolve();
    }

    // eslint-disable-next-line @typescript-eslint/require-await
    public override async manualConnect(): Promise<void> {
        throw new Error('Not implemented');
    }
}
