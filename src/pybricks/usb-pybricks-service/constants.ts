// Pybricks WebUSB protocol constants (pybricks-code src/usb/index.ts).
// Hubs with Pybricks firmware expose a composite interface with class:subclass:protocol ff:c5:f5
// for GATT-like control reads and bulk IN/OUT framing compatible with the Pybricks BLE profile.

export const pybricksUsbClass = 0xff;
export const pybricksUsbSubclass = 0xc5;
export const pybricksUsbProtocol = 0xf5;

export const pybricksUsbRequestMaxLength = 20;

export const LEGO_USB_VENDOR_ID = 0x0694;

export enum PybricksUsbInterfaceRequest {
    Gatt = 0x01,
    Pybricks = 0x02,
}

export enum PybricksUsbInEndpointMessageType {
    Response = 1,
    Event = 2,
}

export enum PybricksUsbOutEndpointMessageType {
    Subscribe = 1,
    Command = 2,
}

/** Extracts the 16-bit UUID fragment from a 128-bit GATT UUID string (characters 4-8). */
export function uuid16FromGattString(uuid: string): number {
    return parseInt(uuid.slice(4, 8), 16);
}

export enum LegoUsbProductId {
    Ev3 = 0x0005,
    SpikePrime = 0x0009,
    SpikeEssential = 0x000d,
    MindstormsRobotInventor = 0x0010,
}

export const PYBRICKS_USB_PRODUCT_IDS: number[] = [
    LegoUsbProductId.Ev3,
    LegoUsbProductId.SpikePrime,
    LegoUsbProductId.SpikeEssential,
    LegoUsbProductId.MindstormsRobotInventor,
];

export function legoUsbProductLabel(productId: number): string {
    switch (productId) {
        case LegoUsbProductId.Ev3:
            return 'EV3';
        case LegoUsbProductId.SpikePrime:
            return 'SPIKE Prime';
        case LegoUsbProductId.SpikeEssential:
            return 'SPIKE Essential';
        case LegoUsbProductId.MindstormsRobotInventor:
            return 'Robot Inventor';
        default:
            return 'Pybricks USB';
    }
}
