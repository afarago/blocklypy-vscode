import { fmod, sumComplement32, crc32, xor8 } from './math';

describe('fmod', () => {
    it('returns same as % for positive numbers', () => {
        expect(fmod(10, 3)).toBe(1);
    });

    it('returns positive result for negative dividend', () => {
        expect(fmod(-1, 360)).toBe(359);
    });

    it('returns zero when evenly divisible', () => {
        expect(fmod(9, 3)).toBe(0);
    });

    it('handles floating point inputs', () => {
        expect(fmod(1.5, 1.0)).toBeCloseTo(0.5);
    });
});

describe('sumComplement32', () => {
    it('returns zero complement for empty input', () => {
        expect(sumComplement32([])).toBe(0);
    });

    it('sum + complement equals zero (mod 2^32)', () => {
        const data = [0x12345678, 0xabcdef01, 0x00ff00ff];
        const checksum = sumComplement32(data);
        let total = 0;
        for (const n of data) total += n;
        total += checksum;
        expect(total & ~0).toBe(0);
    });

    it('single value produces its two-complement', () => {
        const data = [1];
        const checksum = sumComplement32(data);
        expect((1 + checksum) & ~0).toBe(0);
    });
});

describe('crc32', () => {
    it('returns consistent value for known input', () => {
        const first = crc32([0x00000000]);
        const second = crc32([0x00000000]);
        expect(first).toBe(second);
    });

    it('returns different values for different inputs', () => {
        // Use inputs with high bit set so the XOR with 0xffffffff produces a
        // positive intermediate value that actually exercises the lookup table.
        expect(crc32([0x80000000])).not.toBe(crc32([0x80000001]));
    });

    it('returns 0xffffffff for empty input (initial CRC value)', () => {
        expect(crc32([])).toBe(0xffffffff);
    });
});

describe('xor8', () => {
    it('returns 0xff for empty input', () => {
        expect(xor8([])).toBe(0xff);
    });

    it('xors all bytes with 0xff seed', () => {
        expect(xor8([0xff])).toBe(0x00);
        expect(xor8([0x0f])).toBe(0xf0);
    });

    it('is commutative over input order', () => {
        expect(xor8([0x01, 0x02, 0x03])).toBe(xor8([0x03, 0x01, 0x02]));
    });

    it('masks input to 8 bits', () => {
        expect(xor8([0x1ff])).toBe(xor8([0xff]));
    });
});
