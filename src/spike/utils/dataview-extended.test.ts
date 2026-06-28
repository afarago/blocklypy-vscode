import { DataViewExtended } from './dataview-extended';

describe('DataViewExtended', () => {
    describe('endianness', () => {
        it('writes and reads integer and float values in little-endian mode', () => {
            const bytes = new Uint8Array(14);
            const writer = new DataViewExtended(bytes, 0, true);

            writer.writeUInt16(0x1234);
            writer.writeInt16(-2);
            writer.writeUInt32(0x12345678);
            writer.writeFloat(1.5);

            expect(Array.from(bytes)).toEqual([
                0x34, 0x12, 0xfe, 0xff, 0x78, 0x56, 0x34, 0x12, 0x00, 0x00, 0xc0, 0x3f,
                0x00, 0x00,
            ]);

            const reader = new DataViewExtended(bytes, 0, true);
            expect(reader.readUInt16()).toBe(0x1234);
            expect(reader.readInt16()).toBe(-2);
            expect(reader.readUInt32()).toBe(0x12345678);
            expect(reader.readFloat()).toBeCloseTo(1.5, 6);
        });

        it('writes and reads integer and float values in big-endian mode', () => {
            const bytes = new Uint8Array(14);
            const writer = new DataViewExtended(bytes, 0, false);

            writer.writeUInt16(0x1234);
            writer.writeInt16(-2);
            writer.writeUInt32(0x12345678);
            writer.writeFloat(1.5);

            expect(Array.from(bytes)).toEqual([
                0x12, 0x34, 0xff, 0xfe, 0x12, 0x34, 0x56, 0x78, 0x3f, 0xc0, 0x00, 0x00,
                0x00, 0x00,
            ]);

            const reader = new DataViewExtended(bytes, 0, false);
            expect(reader.readUInt16()).toBe(0x1234);
            expect(reader.readInt16()).toBe(-2);
            expect(reader.readUInt32()).toBe(0x12345678);
            expect(reader.readFloat()).toBeCloseTo(1.5, 6);
        });
    });

    describe('boundary conditions', () => {
        it('supports reading the final byte exactly at the end boundary', () => {
            const reader = new DataViewExtended(new Uint8Array([0xaa]), 0, true);

            expect(reader.readUInt8()).toBe(0xaa);
            expect(reader.offset).toBe(1);
        });

        it('reads and writes strings with null terminator handling', () => {
            const bytes = new Uint8Array(8);
            const writer = new DataViewExtended(bytes, 0, true);

            writer.writeString('ab');
            expect(bytes[0]).toBe(0x61);
            expect(bytes[1]).toBe(0x62);
            expect(bytes[2]).toBe(0x00);
            expect(writer.offset).toBe(3);

            const reader = new DataViewExtended(bytes, 0, true);
            expect(reader.readString()).toBe('ab');
            expect(reader.offset).toBe(3);
        });

        it('returns available bytes when readBuffer exceeds remaining length', () => {
            const reader = new DataViewExtended(
                new Uint8Array([0x10, 0x20, 0x30]),
                1,
                true,
            );

            const result = reader.readBuffer(5);

            expect(Array.from(result)).toEqual([0x20, 0x30]);
            expect(reader.offset).toBe(6);
        });
    });

    describe('overflow handling', () => {
        it('throws RangeError and keeps offset when reading past the buffer end', () => {
            const reader = new DataViewExtended(new Uint8Array([0x01]), 0, true);

            expect(() => reader.readUInt16()).toThrow(RangeError);
            expect(reader.offset).toBe(0);
        });

        it('throws RangeError and keeps offset when writing past the buffer end', () => {
            const writer = new DataViewExtended(new Uint8Array(3), 0, true);

            expect(() => writer.writeUInt32(0x12345678)).toThrow(RangeError);
            expect(writer.offset).toBe(0);
        });

        it('applies numeric wrap-around semantics for overflowing integer writes', () => {
            const bytes = new Uint8Array(4);
            const writer = new DataViewExtended(bytes, 0, true);

            writer.writeUInt8(0x1ff);
            writer.writeInt8(130);
            writer.writeUInt16(0x1ffff);

            const reader = new DataViewExtended(bytes, 0, true);
            expect(reader.readUInt8()).toBe(0xff);
            expect(reader.readInt8()).toBe(-126);
            expect(reader.readUInt16()).toBe(0xffff);
        });
    });
});
