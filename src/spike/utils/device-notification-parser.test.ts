import {
    DeviceNotificationMessageType,
    DeviceNotificationPort,
    parseDeviceNotificationPayloads,
} from './device-notification-parser';

describe('device-notification-parser', () => {
    it('parses battery and force sensor payloads from a mock byte buffer', () => {
        const bytes = new Uint8Array([
            0x3c,
            0x06,
            0x00,
            DeviceNotificationMessageType.Battery,
            85,
            DeviceNotificationMessageType.ForceSensor,
            DeviceNotificationPort.C,
            77,
            1,
        ]);

        const { payloads, length } = parseDeviceNotificationPayloads(bytes);

        expect(length).toBe(bytes.length);
        expect(payloads).toEqual([
            {
                type: DeviceNotificationMessageType.Battery,
                batteryLevel: 85,
            },
            {
                type: DeviceNotificationMessageType.ForceSensor,
                port: DeviceNotificationPort.C,
                value: 77,
                pressed: true,
            },
        ]);
    });

    it('maps unknown payload type to Unknown with raw trailing bytes', () => {
        const bytes = new Uint8Array([0x3c, 0x03, 0x00, 0x99, 0xaa, 0xbb]);

        const { payloads } = parseDeviceNotificationPayloads(bytes);

        expect(payloads).toHaveLength(1);
        expect(payloads[0]).toEqual({
            type: DeviceNotificationMessageType.Unknown,
            msgType: 0x99,
            raw: new Uint8Array([0xaa, 0xbb]),
        });
    });

    it('throws for an invalid device notification header length', () => {
        const invalidBytes = new Uint8Array([
            0x3c,
            0x07,
            0x00,
            DeviceNotificationMessageType.Battery,
            85,
            DeviceNotificationMessageType.ForceSensor,
            DeviceNotificationPort.C,
            77,
            1,
        ]);

        expect(() => parseDeviceNotificationPayloads(invalidBytes)).toThrow(
            'Invalid DeviceNotification',
        );
    });
});
