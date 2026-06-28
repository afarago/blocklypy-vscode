import { retryWithTimeout, withTimeout } from './async';

describe('withTimeout', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('resolves with the promise value when it settles before timeout', async () => {
        const result = await withTimeout(Promise.resolve(42), 1000);
        expect(result).toBe(42);
    });

    it('rejects with timeout error when promise does not settle in time', async () => {
        const never = new Promise<never>(() => {});
        const race = withTimeout(never, 500);
        jest.advanceTimersByTime(500);
        await expect(race).rejects.toThrow('Operation timed out');
    });

    it('does not reject if promise resolves before timer fires', async () => {
        const fast = Promise.resolve('ok');
        const race = withTimeout(fast, 1000);
        jest.advanceTimersByTime(999);
        await expect(race).resolves.toBe('ok');
    });
});

describe('retryWithTimeout', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('returns the resolved value on first success', async () => {
        const fn = jest.fn().mockResolvedValue('done');
        const resultPromise = retryWithTimeout(fn, undefined, {
            retries: 3,
            timeout: 1000,
            delay: 100,
        });
        await jest.runAllTimersAsync();
        await expect(resultPromise).resolves.toBe('done');
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it('retries on failure and succeeds on second attempt', async () => {
        const fn = jest
            .fn()
            .mockRejectedValueOnce(new Error('fail'))
            .mockResolvedValue('ok');
        const resultPromise = retryWithTimeout(fn, undefined, {
            retries: 3,
            timeout: 1000,
            delay: 100,
        });
        await jest.runAllTimersAsync();
        await expect(resultPromise).resolves.toBe('ok');
        expect(fn).toHaveBeenCalledTimes(2);
    });

    it('throws the last error after exhausting all retries', async () => {
        const fn = jest.fn().mockRejectedValue(new Error('always fails'));
        const resultPromise = retryWithTimeout(fn, undefined, {
            retries: 3,
            timeout: 1000,
            delay: 10,
        });

        // Attach the rejection expectation before timers advance to avoid
        // promise rejection handled asynchronously warnings.
        const rejection = expect(resultPromise).rejects.toThrow('always fails');
        await jest.runAllTimersAsync();
        await rejection;
        expect(fn).toHaveBeenCalledTimes(3);
    });

    it('calls cleanUp between retries', async () => {
        const fn = jest
            .fn()
            .mockRejectedValueOnce(new Error('fail'))
            .mockResolvedValue('ok');
        const cleanUp = jest.fn().mockResolvedValue(undefined);
        const resultPromise = retryWithTimeout(fn, cleanUp, {
            retries: 3,
            timeout: 1000,
            delay: 10,
        });
        await jest.runAllTimersAsync();
        await resultPromise;
        expect(cleanUp).toHaveBeenCalledTimes(1);
    });

    it('doubles delay between retries when backoff is enabled', async () => {
        const fn = jest.fn().mockRejectedValue(new Error('fail'));
        const resultPromise = retryWithTimeout(fn, undefined, {
            retries: 3,
            timeout: 1000,
            delay: 50,
            backoff: true,
        });
        const rejection = expect(resultPromise).rejects.toThrow('fail');

        expect(fn).toHaveBeenCalledTimes(1);

        await jest.advanceTimersByTimeAsync(49);
        expect(fn).toHaveBeenCalledTimes(1);

        await jest.advanceTimersByTimeAsync(1);
        expect(fn).toHaveBeenCalledTimes(2);

        await jest.advanceTimersByTimeAsync(99);
        expect(fn).toHaveBeenCalledTimes(2);

        await jest.advanceTimersByTimeAsync(1);
        expect(fn).toHaveBeenCalledTimes(3);

        await rejection;
    });
});
