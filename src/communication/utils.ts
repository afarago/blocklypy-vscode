import crc32 from 'crc-32';

export class UUIDu {
    static to128(uuid: string | number): string {
        if (typeof uuid === 'number') {
            return (
                ('00000000' + uuid.toString(16)).slice(-8) +
                '-0000-1000-8000-00805f9b34fb'
            );
        }
        return uuid;
    }

    static to16(uuid: string | number): string {
        if (typeof uuid === 'number') {
            return uuid.toString(16).slice(-4);
        }
        return uuid;
    }

    static toString(uuid: string | number, expand: boolean = false): string {
        if (uuid === undefined || uuid === null) {
            throw new TypeError(`Invalid UUID: ${String(uuid)}`);
        }

        if (typeof uuid === 'number') {
            uuid = uuid.toString(16).slice(-4);
        }

        const cleaned = uuid.replace(/[^a-fA-F0-9]/g, '').toLowerCase();
        if (cleaned.length === 4) {
            if (!expand) return cleaned;
            else return '0000' + cleaned + '-0000-1000-8000-00805f9b34fb';
        } else if (cleaned.length === 8) {
            return cleaned + '-0000-1000-8000-00805f9b34fb';
        } else if (cleaned.length === 32) {
            return (
                cleaned.slice(0, 8) +
                '-' +
                cleaned.slice(8, 12) +
                '-' +
                cleaned.slice(12, 16) +
                '-' +
                cleaned.slice(16, 20) +
                '-' +
                cleaned.slice(20)
            );
        }
        return cleaned;
    }

    static normalizeKey(uuid: string | number): string {
        return UUIDu.toString(uuid, true).replace(/-/g, '').toLowerCase();
    }

    static equalUuids(a: string | number, b: string | number): boolean {
        return UUIDu.normalizeKey(a) === UUIDu.normalizeKey(b);
    }
}

const CRC32_ALIGNMENT = 4;
export function crc32WithAlignment(data: Uint8Array, seed = 0): number {
    const remainder = data.byteLength % CRC32_ALIGNMENT;
    const alignedData = new Uint8Array(
        data.byteLength + ((CRC32_ALIGNMENT - remainder) % CRC32_ALIGNMENT),
    );
    alignedData.set(Buffer.from(data));

    return crc32.buf(alignedData, seed);
}

export function decodeNumberStringToBuffer(str: string): Buffer {
    const bytes = str
        .trim()
        .split(/\s+/)
        .map((num) => parseInt(num, 10));
    return Buffer.from(bytes);
}