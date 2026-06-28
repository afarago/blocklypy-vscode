import { encode, decode, pack, unpack, DELIMITER, XOR } from './cobs';

describe('COBS encode/decode', () => {
    it('round-trips empty data', () => {
        const data = new Uint8Array([]);
        expect(decode(encode(data))).toEqual(data);
    });

    it('round-trips data with no delimiter bytes', () => {
        const data = new Uint8Array([0x10, 0x20, 0x30, 0xff]);
        expect(decode(encode(data))).toEqual(data);
    });

    it('round-trips data containing 0x00 (delimiter)', () => {
        const data = new Uint8Array([0x00, 0x10, 0x00]);
        expect(decode(encode(data))).toEqual(data);
    });

    it('round-trips data containing 0x01 and 0x02 (delimiters)', () => {
        const data = new Uint8Array([0x01, 0x02, 0x03]);
        expect(decode(encode(data))).toEqual(data);
    });

    it('round-trips data consisting entirely of delimiter bytes', () => {
        const data = new Uint8Array([0x00, 0x00, 0x00]);
        expect(decode(encode(data))).toEqual(data);
    });

    it('encoded output contains no bytes <= 0x02', () => {
        const data = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x80, 0xff]);
        const encoded = encode(data);
        for (const byte of encoded) {
            expect(byte).toBeGreaterThan(0x02);
        }
    });

    it('round-trips a long block that exceeds MAX_BLOCK_SIZE (84 bytes)', () => {
        const data = new Uint8Array(100).fill(0x42);
        expect(decode(encode(data))).toEqual(data);
    });
});

describe('COBS pack/unpack', () => {
    it('appends DELIMITER byte at end', () => {
        const data = new Uint8Array([0x10, 0x20]);
        const packed = pack(data);
        expect(packed[packed.length - 1]).toBe(DELIMITER);
    });

    it('round-trips arbitrary data', () => {
        const data = new Uint8Array([0x00, 0x01, 0x05, 0xff]);
        expect(unpack(pack(data))).toEqual(data);
    });

    it('packed bytes (excluding delimiter) are XOR-masked', () => {
        const data = new Uint8Array([0x10]);
        const packed = pack(data);
        // All bytes except the trailing delimiter should equal their encode counterpart XOR'd with XOR constant
        const encoded = encode(data);
        for (let i = 0; i < encoded.length; i++) {
            expect(packed[i]).toBe(encoded[i] ^ XOR);
        }
    });
});
