/** Helper functions to transform code for plotting commands.
 *
 * A source code line with a plot command looks like this:
 * print("some text")  # plot(var1, var2, ...)
 * print("some text")  # plot(var1:name1, var2:name2, ...)
 *
 * The code is transformed to insert a print statement that outputs the plot command to stdout:
 * print(f"plot: var1:{var1}, var2:{var2}"); print("some text")
 * print(f"plot: name1:{var1}, name2:{var2}"); print("some text")
 */

import { logDebug } from '../extension';
import { CompileModule } from '../logic/compile';

export const PLOT_COMMAND_PREFIX = 'plot';

// Matches lines with # plot(var1, var2, ...) // or # plot(var1:name1)
export function checkLineForPlot(line: string) {
    return line.match(
        new RegExp(`^[^#]*#\\s*${PLOT_COMMAND_PREFIX}\\s*(?:\\(([^)]*)\\))`),
    );
}

export function transformCodeForPlot(module: CompileModule) {
    const lines = module.content.split('\n');
    const linesOut: string[] = [];
    let instrumentCount = 0;
    for (let lineno = 0; lineno < lines.length; lineno++) {
        let line = lines[lineno];
        //-- match # plot(var1, var2, ...)
        const match = checkLineForPlot(line);
        if (match) {
            const vars = match[1]
                ?.split(',')
                .map((v) => v.trim())
                .filter(Boolean);
            const indentation = line.match(/^\s*/)?.[0] ?? '';
            // e.g. print(f"plot: var1={var1}, var2={var2}")
            const varpayload = vars
                .map((v) => {
                    const [var1, name] = v.split(':').map((s) => s.trim());
                    return `${name ?? var1}: {${var1}}`;
                })
                .join(', ');
            const instructions = `print(f"${PLOT_COMMAND_PREFIX}: ${varpayload}")`;
            line = `${indentation}${instructions}; ${line}`;
            instrumentCount++;
        }
        linesOut.push(line);
    }

    module.content = linesOut.join('\n');
    if (instrumentCount > 0) {
        logDebug(
            `Note: Transforming code for plot helpers. Compiled an instrumented version of code, that might yield to side effects and different line numbers.`,
        );
    }

    //return { code: linesOut.join('\n'), breakpoints };
}
