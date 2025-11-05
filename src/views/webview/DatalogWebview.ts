import { head, max } from 'lodash';
import { Axis, default as uPlot } from 'uplot';
import 'uplot/dist/uPlot.min.css';

const MAX_DATA_POINTS = 200; // max points to keep in chart

const COLORS = [
    '#7EB26D', // 0: pale green
    '#EAB839', // 1: mustard
    '#6ED0E0', // 2: light blue
    '#EF843C', // 3: orange
    '#E24D42', // 4: red
    '#1F78C1', // 5: ocean
    '#BA43A9', // 6: purple
    '#705DA0', // 7: violet
    '#508642', // 8: dark green
    '#CCA300', // 9: dark sand
];

let chart: uPlot | undefined;
let chartDataByCols: number[][] = [];
let markers: { name: string; timestamp: number }[] = [];
let chartSeries: string[] = [];
let _latestDataRow: number[] = [];
let chartMode = 'lines'; // or 'bar'

// const vscode = acquireVsCodeApi();

type DatalogWebviewMessage =
    | { command: 'setHeaders'; cols: string[]; rows?: number[][]; latest?: number[] }
    | { command: 'addData'; row: number[]; latest: number[] }
    | { command: 'addMarker'; markerName: string; markerTimestamp: number; latest: number[] };

window.addEventListener('message', (event: MessageEvent) => {
    const data = event.data as DatalogWebviewMessage;
    if (data.command === 'setHeaders') {
        const { cols, rows, latest } = data;
        setHeaders(cols, rows, latest);
    } else if (data.command === 'addData') {
        const { row, latest } = data;
        addData(row, latest);
    } else if (data.command === 'addMarker') {
        const { markerName, markerTimestamp } = data;
        addMarker(markerName, markerTimestamp);
    }
});

window.addEventListener('resize', (_e) => {
    chart?.setSize(getSize());
});

// function getVsCodeTheme() {
//     return document.body.classList.contains('vscode-dark') ? 'vs-dark' : 'vs-light';
// }
// window.addEventListener('vscode-theme-change', () => {
//     if (chart && chartSeries.length > 0) {
//         setHeaders(chartSeries, chartData);
//     }
// });

function getSize() {
    return {
        width: window.innerWidth,
        height: window.innerHeight,
    };
}

function setVisibility(hasData: boolean) {
    const container = document.getElementById('chart-container');
    const welcome = document.getElementById('welcome-view');
    if (!container || !welcome) return;

    welcome.style.display = hasData ? 'none' : 'block';
    container.style.display = hasData ? 'block' : 'none';
}

function setHeaders(
    names: string[],
    dataByRows: number[][] = [],
    latest: number[] = [],
) {
    chartSeries = names; // first is x-axis

    // transpose dataByRows to dataByCols
    if (dataByRows.length > 0 && dataByRows[0].length === names.length) {
        chartDataByCols = names.map((_, colIdx) =>
            dataByRows.map((row) => row[colIdx]),
        );
    } else {
        chartDataByCols = Array.from({ length: names.length }, () => []);
    }
    _latestDataRow = latest;

    const dataSeriesNames = names.slice(1);
    // const isLight = getVsCodeTheme() === 'vs-light';

    const container = document.getElementById('chart-container');
    if (!container) return;
    container.innerHTML = ''; // Clear any existing chart
    markers = []; // Clear markers

    // auto scale function with min range
    const autoScaleFn: uPlot.Range.Function = (_self, initMin, initMax, _scaleKey) => {
        let delta = initMax - initMin;
        const MIN_RANGE = 0.5;
        if (delta < MIN_RANGE) {
            let midpoint = (initMin + initMax) / 2;
            let newMin = midpoint - MIN_RANGE / 2;
            let newMax = midpoint + MIN_RANGE / 2;
            return [newMin, newMax] as uPlot.Range.MinMax;
        }
        return [initMin, initMax] as uPlot.Range.MinMax;
    };

    // TODO: somehow make there is a narrow gap on the top - to be removed
    if (chartMode === 'lines') {
        const axeOpts: Axis[] = [
            {
                scale: 'x',
                side: Axis.Side.Bottom,
                stroke: '#7779',
                grid: {
                    show: true,
                    stroke: '#7776',
                    dash: [],
                    width: 2,
                },
                ticks: { show: true, stroke: '#7776' },
                gap: 0,
                size: 25,
                labelSize: 12,
            },
            ...dataSeriesNames.map((name, idx) => ({
                label: name,
                scale: `num${idx}`,
                side: Axis.Side.Left,
                stroke: COLORS[idx % COLORS.length],
                gap: 0,
                size: 30,
                grid: {
                    show: true,
                    stroke: '#7776',
                    dash: [2, 5],
                    width: 1,
                },
                ticks: { show: true, stroke: '#7776' },
                labelSize: 12,
            })),
        ];
        const opts: uPlot.Options = {
            legend: { show: true },
            ...getSize(),
            padding: [null, 0, null, 0],
            series: [
                // x-axis
                {
                    scale: 'x',
                    label: names[0],
                    width: 2,
                    stroke: '#7774',
                },
                // y-axes
                ...dataSeriesNames.map((name, idx) => ({
                    scale: `num${idx}`,
                    label: name,
                    width: 2,
                    stroke: COLORS[idx % COLORS.length],
                    fill: COLORS[idx % COLORS.length] + '22',
                })),
            ],
            axes: axeOpts,
            scales: {
                x: {
                    time: false,
                },
                ...Object.fromEntries(
                    dataSeriesNames.map((_, idx) => [
                        `num${idx}`,
                        { range: autoScaleFn },
                    ]),
                ),
            },
            plugins: [
                axisIndicsPlugin(axeOpts),
                annotationsPlugin(markers),
            ],
        };

        const alignedData = chartDataByCols.map((arr) => new Float64Array(arr));
        try {
            chart = new uPlot(opts, alignedData, container);
        } catch {
            // NOOP
        }
        setVisibility(alignedData?.[0]?.length > 0);
    } else if (chartMode === 'bar') {
        // TODO: implement bar chart
        setVisibility(false);
    }
}

function addData(line: number[], latest: number[]) {
    if (chart && chartSeries.length > 0) {
        chartSeries.forEach((_, index) => {
            chartDataByCols[index].push(line[index]);
        });
        _latestDataRow = latest;

        // sliding window to keep max data points
        if (chartDataByCols[0].length > MAX_DATA_POINTS) {
            chartDataByCols.forEach((arr) =>
                arr.splice(0, arr.length - MAX_DATA_POINTS),
            );
        }

        const alignedData = chartDataByCols.map((arr) => new Float64Array(arr));
        chart.setData(alignedData);
        setVisibility(true);
    } else {
        setVisibility(false);
    }
}

function addMarker(markerName: string, markerTimestamp: number) {
    markers.push({ name: markerName, timestamp: markerTimestamp });
}

function axisIndicsPlugin(axes: Axis[]): uPlot.Plugin {
    let indicsEls = Array(axes.length) as HTMLDivElement[];
    let valuesEls = Array(axes.length) as (HTMLElement | Text)[];

    const initHook = (u: uPlot) => {
        const axesEls = Array.from(u.root.querySelectorAll('.u-axis'));

        axesEls.forEach((el, idx) => {
            if (idx === 0) return; // don't show for x-axis

            const axisOpt = axes[idx];
            const indic = (indicsEls[idx] = document.createElement('div'));
            indic.classList.add('u-indic-y');
            indic.style.backgroundColor =
                typeof axisOpt.stroke === 'string' ? axisOpt.stroke : '#aaa';
            indic.style.color = '#444';
            indic.style.borderRadius = '3px';
            indic.style.textAlign = 'center';
            indic.style.overflow = 'hidden';

            const value = (valuesEls[idx] = document.createTextNode(''));
            indic.appendChild(value);

            el.appendChild(indic);
        });
    };

    const setLegendHook = (u: uPlot) => {
        u.series.forEach((s, seriesIdx) => {
            if (seriesIdx === 0) return; // skip x-axis
            const el = indicsEls[seriesIdx];
            const valIdx = u.cursor.idxs?.[seriesIdx];

            if (typeof valIdx === 'number') {
                const val = u.data[seriesIdx][valIdx] as number;

                if (val !== null) {
                    valuesEls[seriesIdx].nodeValue = val.toString();

                    const pos = u.valToPos(val, s.scale ?? 'x');

                    el.style.display = 'block';
                    el.style.transform = `translateY(-50%) translateY(${pos}px)`;

                    return;
                }
            }

            el.style.display = 'none';
        });
    };

    return {
        opts: (_u, opts) =>
            uPlot.assign({}, opts, {
                cursor: {
                    y: false,
                },
            }) as uPlot.Options,
        hooks: {
            init: initHook,
            setLegend: setLegendHook,
        },
    };
};

/**
 * Create a uPlot plugin to show markers on the chart.
 * @param markers A list of the markers to show. It's a reference that allows external update.
 * @returns 
 */
function annotationsPlugin(markers: { name: string; timestamp: number }[]): uPlot.Plugin {
    const MARKER_CLASS_NAME = 'u-marker';

    function placeMark(u: uPlot, timestamp: number, name: string) {
        let markEl = document.createElement('div');
        markEl.classList.add(MARKER_CLASS_NAME);

        let leftCss = Math.round(u.valToPos(timestamp, 'x'));

        Object.assign(markEl.style, {
            position: 'absolute',
            left: `${leftCss}px`,
            height: '100%',
            borderLeft: `1px dashed #800`,
        });

        let labelEl = document.createElement('div');
        labelEl.textContent = name;
        labelEl.title = `${name}\n${timestamp}s`;

        Object.assign(labelEl.style, {
            border: `1px dashed #800`,
            borderWidth: `1px 1px 1px 0`,
            maxWidth: '120px',
            cursor: 'pointer',
            top: 0,
            padding: '0 2px',
            background: '#3337',
        });

        markEl.appendChild(labelEl);
        u.over.appendChild(markEl);
    }

    return {
        hooks: {
            drawClear: [
                (u: uPlot) => {
                    for (const el of Array.from(u.over.querySelectorAll('.' + MARKER_CLASS_NAME))) {
                        el.remove();
                    }

                    markers.forEach(marker => {
                        const xScale = u.scales.x;
                        if (
                            xScale.min !== undefined && xScale.max !== undefined &&
                            (marker.timestamp >= xScale.min && marker.timestamp <= xScale.max)
                        ) {
                            placeMark(u, marker.timestamp, marker.name);
                        }
                    });
                }
            ],
        },
    };
}
