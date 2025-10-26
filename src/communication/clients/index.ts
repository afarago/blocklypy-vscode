import { LayerKind } from '../layers';

export interface ClientClassDescriptor {
    deviceType: string;
    description: string;
    supportsModularMpy: boolean;
    requiresSlot: boolean;
    os: DeviceOSType | undefined;
    layer: LayerKind;
}

export enum DeviceOSType {
    HubOS = 'hubos',
    Pybricks = 'pybricks',
}

export enum StartMode {
    REPL = 'repl',
}
