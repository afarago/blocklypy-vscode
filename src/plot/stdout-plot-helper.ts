import { PLOT_COMMAND_PREFIX } from '../plot/compile-helper';
import { PlotManager } from '../plot/plot';

/**
 * Parse a line from stdout for plot commands and handle them with the PlotManager.
 * @param line A line from stdout
 * @param plotManager
 * @returns void
 *
 * Examples:
 * ```
 * plot: start temperature, humidity
 * plot: temperature: 22.5, humidity: 45.0
 * plot: temperature=22.5, humidity=45.0
 * plot: temperature: 23.0
 * plot: temperature=23.0
 * plot: reflectance: 80.0
 * plot: marker: turn_on_light
 * plot: 10.0, 50.0
 * plot: ,, 80.0
 * plot: 11.0, 51.0, 81.0
 * plot: clear
 * plot: clear temperature
 * plot: clear temperature, humidity
 * plot: end
 *
 */

const PLOT_COMMAND_PREFIX1 = PLOT_COMMAND_PREFIX + ':';

export async function parsePlotCommand(
    line: string,
    plotManager: PlotManager | undefined,
) {
    if (!plotManager) return;

    if (!line.startsWith(PLOT_COMMAND_PREFIX1)) return;
    const line1 = line.substring(PLOT_COMMAND_PREFIX1.length).trim();

    // --- start command with column definitions ---
    // e.g. "start temperature, humidity"
    const defMatch = /^start (.+)$/.exec(line1);
    if (defMatch) {
        const columns = defMatch[1].split(',').map((v) => v.trim());
        plotManager.start(columns);
        return;
    }

    // --- end command ---
    // e.g. "end"
    if (/^end$/.test(line1)) {
        await plotManager.stop();
        return;
    }

    // --- clear command ---
    // e.g. "clear" or "clear temperature, humidity"
    if (/^clear( .+)?$/.test(line1)) {
        // remove "clear " prefix and split by comma
        const lineTrimmed = line1.substring('clear'.length).trim();
        const columnsToClear = lineTrimmed
            ? lineTrimmed.split(',').map((v) => v.trim())
            : undefined;
        plotManager.clear(columnsToClear);
        return;
    }

    // --- marker command ---
    // e.g. "marker: turn_on_light"
    // words after `marker` will become the title of the marker, numbers won't be plotted as data points
    if (/^marker:\s*(.+)$/.test(line1)) {
        const markerName = line1.match(/^marker:\s*(.+)$/)![1].trim();
        plotManager.addMarker(markerName);
        return;
    }

    // if (!plotManager.running) return;
    let values: number[] = [];
    // --- data: multiple paired numeric values ---
    // e.g. "temperature: 22.5, humidity: 45.0"
    if (/^([\w]+[:=]\s*([-+]?\d*\.?\d+)?\s*[, ]*)+$/.test(line1)) {
        const matches = Array.from(line1.matchAll(/([\w]+)[:=]\s*([-+]?\d*\.?\d+)?/g));

        if (!plotManager.running) {
            // if not running, start a new plot with the detected columns
            const columns = matches.map((m) => m[1]);
            plotManager.start(columns);
        } else if (matches.some((m) => !plotManager.columns.includes(m[1]))) {
            // if running, but some columns are new, add them
            const newCols = matches
                .map((m) => m[1])
                .filter((col) => !plotManager.columns.includes(col));
            plotManager.addColumns(newCols);
        }

        values = plotManager.columns.map((col) => {
            const m = matches.find((match) => match[1] === col);
            return m && m[2] !== undefined ? parseFloat(m[2]) : NaN;
        });
    }

    // --- data: simple numeric values ---
    // e.g. "10.0, 50.0" or "11.0, 51.0, 81.0" or ",,80.0" or "1,,3" or "1"
    else if (/^(([-+]?\d*\.?\d+)?\s*,?\s*)+$/.test(line1)) {
        if (!plotManager.running) {
            // if not running, start a new plot with generic column names
            const count = line1.split(',').length;
            const columns = Array.from({ length: count }, (_, i) => `column_${i + 1}`);
            plotManager.start(columns);
        } else {
            // if running, but more values than columns, add new generic columns
            const count = line1.split(',').length;
            if (count > plotManager.columns.length) {
                const newCols = Array.from(
                    { length: count - plotManager.columns.length },
                    (_, i) => `column_${plotManager.columns.length + i + 1}`,
                );
                plotManager.addColumns(newCols);
            }
        }

        // Split by comma, trim whitespace, and parse numbers or NaN for missing
        values = line1.split(',').map((v) => {
            const num = v.trim();
            return num ? Number(num) : NaN;
        });
    }

    // handle the parsed values
    plotManager.setRowValues(values);
}
