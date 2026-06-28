import { decodeTunnelMessage, TunnelMessageType } from './tunnel-notification-parser';

describe('tunnel-notification-parser', () => {
    it('parses graph and display payloads from a mock byte buffer', () => {
        const bytes = new Uint8Array([
            0x32,
            0x00,
            0x08,
            TunnelMessageType.GraphValue,
            7,
            0x3f,
            0xa0,
            0x00,
            0x00,
            TunnelMessageType.DisplayShow,
            1,
        ]);

        const payloads = decodeTunnelMessage(bytes);

        expect(payloads).toHaveLength(2);
        expect(payloads[0]).toEqual({
            type: TunnelMessageType.GraphValue,
            correlationId: 7,
            value: 1.25,
        });
        expect(payloads[1]).toEqual({
            type: TunnelMessageType.DisplayShow,
            fullscreen: true,
        });
    });

    it('parses weather-at-offset request payload with string fields', () => {
        const bytes = new Uint8Array([
            0x32,
            0x00,
            0x09,
            TunnelMessageType.WeatherAtOffsetRequest,
            42,
            3,
            6,
            0x54,
            0x65,
            0x73,
            0x74,
            0x00,
        ]);

        const payloads = decodeTunnelMessage(bytes);

        expect(payloads).toEqual([
            {
                type: TunnelMessageType.WeatherAtOffsetRequest,
                correlationId: 42,
                days: 3,
                hours: 6,
                location: 'Test',
            },
        ]);
    });

    it('maps unknown payload type to Unknown payload object', () => {
        const bytes = new Uint8Array([0x32, 0x00, 0x01, 0xfe]);

        const payloads = decodeTunnelMessage(bytes);

        expect(payloads).toEqual([
            {
                type: TunnelMessageType.Unknown,
                type2: 0xfe,
            },
        ]);
    });
});
