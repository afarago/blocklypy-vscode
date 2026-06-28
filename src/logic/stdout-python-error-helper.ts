export let inErrorFrame = true;
export let currentErrorFrame: {
    filename: string;
    line: number;
    message: string;
} | null = null;
type ErrorCallback = (filename: string, line: number, message: string) => void;

/**
 * Determines if a message should be treated as an error output without changing state
 * @param message The message to check
 * @returns true if the message should be treated as error output
 */
export function isErrorOutput(message: string): boolean {
    // If we're already in an error frame, this is an error output
    if (inErrorFrame) return true;

    // Check if this starts a new error traceback
    return message.trim().startsWith('Traceback (most recent call last):');
}

export function parsePythonError(text: string, onErrorCb?: ErrorCallback) {
    /*
            Find the traceback block:

            Traceback (most recent call last):
              File "__main__.py", line 9, in <module>
              File "test1.py", line 9, in <module>
            NameError: name 'PrimeHub2' isn't defined
        */
    const lines = text.trimEnd().split(/\r?\n/);
    lines.forEach((line) => {
        parsePythonErrorLine(line.replace(/[\r\n]$/, ''), onErrorCb);
    });
}

export function parsePythonErrorLine(line: string, onErrorCb?: ErrorCallback) {
    if (!inErrorFrame) {
        if (isErrorOutput(line)) inErrorFrame = true;
        return;
    }

    const match = /^\s+File "([^"]+)", line (\d+)(?:, in .+)?/.exec(line);
    if (match)
        currentErrorFrame = {
            filename: match[1],
            line: parseInt(match[2], 10) - 1,
            message: '',
        };
    else {
        if (!currentErrorFrame) {
            inErrorFrame = false;
            console.warn('No error frame found before error message');
            return; // no stack frame yet, handle it gracefully
        }
        const trimmed = line.trim();
        if (!trimmed || /^\^+$/.test(trimmed)) {
            return;
        }

        // In syntax/indentation errors, traceback may contain code snippets
        // before the final "*Error" line; only emit on real error lines.
        const isErrorLine = /^[A-Za-z_][A-Za-z0-9_.]*(Error|Exception)(:|$)/.test(
            trimmed,
        );
        if (!isErrorLine) {
            return;
        }

        currentErrorFrame.message = trimmed; // message comes after the last stack frame

        const error_local = { ...currentErrorFrame };
        if (onErrorCb)
            onErrorCb(error_local.filename, error_local.line, error_local.message);
        inErrorFrame = false;
        currentErrorFrame = null;
    }
}

export function resetPythonErrorParser() {
    inErrorFrame = false;
    currentErrorFrame = null;
}
