import { DeviceNotificationMessage } from '../spike/messages/device-notification-message';
import { TunnelNotificationMessage } from '../spike/messages/tunnel-notification-message';
import { TunnelRequestMessage } from '../spike/messages/tunnel-request-message';
import { DataViewExtended } from '../spike/utils/dataview-extended';
import { DeviceNotificationMessageType } from '../spike/utils/device-notification-parser';
import { TunnelMessageType } from '../spike/utils/tunnel-notification-parser';
import {
    AppDataInstrumentationPybricksProtocol,
    DebugSubCode,
    DebugVarTypeEnum,
    decodeMessageRaw,
    encodeMessageRaw,
    MessageType,
    PlotSubCode,
} from './appdata-instrumentation-protocol';

function makeBuffer(writer: (view: DataViewExtended) => void) {
    const bytes = new Uint8Array(256);
    const view = new DataViewExtended(bytes, 0, true);
    writer(view);
    return bytes.slice(0, view.offset);
}

describe('appdata instrumentation protocol', () => {
    beforeEach(() => {
        AppDataInstrumentationPybricksProtocol.reset();
    });

    it('decodes debug trap notifications with mixed variable types', () => {
        const bytes = makeBuffer((view) => {
            view.writeUInt8(MessageType.DebugNotification);
            view.writeUInt8(DebugSubCode.TrapNotification);
            view.writeString('main.py');
            view.writeUInt16(42);
            view.writeUInt8(5);

            view.writeString('counter');
            view.writeUInt8(DebugVarTypeEnum.Int);
            view.writeInt32(123);

            view.writeString('ratio');
            view.writeUInt8(DebugVarTypeEnum.Float);
            view.writeFloat(3.14);

            view.writeString('message');
            view.writeUInt8(DebugVarTypeEnum.String);
            view.writeString('hello');

            view.writeString('enabled');
            view.writeUInt8(DebugVarTypeEnum.Bool);
            view.writeBool(true);

            view.writeString('empty');
            view.writeUInt8(DebugVarTypeEnum.None);
        });

        const decoded = decodeMessageRaw(bytes);

        expect(decoded).toEqual(
            expect.objectContaining({
                Id: MessageType.DebugNotification,
                subcode: DebugSubCode.TrapNotification,
                filename: 'main.py',
                line: 42,
            }),
        );

        const variables = (
            decoded as Extract<typeof decoded, { variables?: Map<string, unknown> }>
        ).variables;
        expect(variables).toBeInstanceOf(Map);
        expect(variables?.get('counter')).toBe(123);
        expect(variables?.get('ratio')).toBeCloseTo(3.14, 6);
        expect(variables?.get('message')).toBe('hello');
        expect(variables?.get('enabled')).toBe(true);
        expect(variables?.get('empty')).toBeNull();
    });

    it('decodes plot cell updates with named values', () => {
        const bytes = makeBuffer((view) => {
            view.writeUInt8(MessageType.PlotNotification);
            view.writeUInt8(PlotSubCode.UpdateCells);
            view.writeUInt8(2);
            view.writeString('yaw');
            view.writeFloat(42.1);
            view.writeString('pitch');
            view.writeFloat(-3.5);
        });

        const decoded = decodeMessageRaw(bytes);

        expect(decoded).toEqual(
            expect.objectContaining({
                Id: MessageType.PlotNotification,
                subcode: PlotSubCode.UpdateCells,
            }),
        );

        const values = (
            decoded as Extract<
                typeof decoded,
                { values: { name: string; value: number }[] }
            >
        ).values;
        expect(values).toHaveLength(2);
        expect(values[0]?.name).toBe('yaw');
        expect(values[0]?.value).toBeCloseTo(42.1, 5);
        expect(values[1]?.name).toBe('pitch');
        expect(values[1]?.value).toBeCloseTo(-3.5, 5);
    });

    it('encodes debug continue requests with the step flag', () => {
        const encoded = encodeMessageRaw({
            Id: MessageType.DebugAcknowledge,
            subcode: DebugSubCode.ContinueRequest,
            step: true,
        });

        expect(Array.from(encoded)).toEqual([
            MessageType.DebugAcknowledge,
            DebugSubCode.ContinueRequest,
            1,
        ]);
    });

    it('routes device notification payloads through decodeMessageRaw', () => {
        const bytes = new Uint8Array([
            MessageType.DeviceNotification,
            23,
            0,
            DeviceNotificationMessageType.Battery,
            85,
            DeviceNotificationMessageType.ImuValues,
            1,
            2,
            0x01,
            0x01,
            0x02,
            0x01,
            0x03,
            0x01,
            0x04,
            0x01,
            0x05,
            0x01,
            0x06,
            0x01,
            0x07,
            0x01,
            0x08,
            0x01,
            0x09,
            0x01,
        ]);

        const decoded = decodeMessageRaw(bytes);

        expect(decoded).toBeInstanceOf(DeviceNotificationMessage);
        expect((decoded as DeviceNotificationMessage).payloads).toEqual([
            {
                type: DeviceNotificationMessageType.Battery,
                batteryLevel: 85,
            },
            {
                type: DeviceNotificationMessageType.ImuValues,
                faceUp: 1,
                yawFace: 2,
                yaw: 0x0101,
                pitch: 0x0102,
                roll: 0x0103,
                accX: 0x0104,
                accY: 0x0105,
                accZ: 0x0106,
                gyroX: 0x0107,
                gyroY: 0x0108,
                gyroZ: 0x0109,
            },
        ]);
    });

    it('routes serialized tunnel payloads through decodeMessageRaw', () => {
        const message = new TunnelRequestMessage([
            {
                type: TunnelMessageType.WeatherAtOffsetRequest,
                correlationId: 42,
                days: 3,
                hours: 6,
                location: 'Test',
            },
        ]);

        const decoded = decodeMessageRaw(message.serialize());

        expect(decoded).toBeInstanceOf(TunnelNotificationMessage);
        expect((decoded as TunnelNotificationMessage).tunnelData).toEqual(
            message.tunnelData,
        );
    });
});
