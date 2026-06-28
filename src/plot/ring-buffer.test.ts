import { RingBuffer } from './ring-buffer';

describe('RingBuffer', () => {
    it('keeps insertion order before reaching capacity', () => {
        const buffer = new RingBuffer<number>(4);

        buffer.push(1);
        buffer.push(2);
        buffer.push(3);

        expect(buffer.length).toBe(3);
        expect(buffer.toArray()).toEqual([1, 2, 3]);
    });

    it('wraps around and evicts oldest values on overflow', () => {
        const buffer = new RingBuffer<number>(3);

        buffer.push(10);
        buffer.push(20);
        buffer.push(30);
        buffer.push(40);
        buffer.push(50);

        expect(buffer.length).toBe(3);
        expect(buffer.toArray()).toEqual([30, 40, 50]);
        expect(buffer.get(0)).toBe(30);
        expect(buffer.get(1)).toBe(40);
        expect(buffer.get(2)).toBe(50);
    });

    it('returns undefined for out-of-range reads and enforces extraction limits', () => {
        const buffer = new RingBuffer<number>(2);

        buffer.push(7);
        buffer.push(8);
        buffer.push(9);

        expect(buffer.toArray()).toEqual([8, 9]);
        expect(buffer.get(-1)).toBeUndefined();
        expect(buffer.get(2)).toBeUndefined();
    });
});
