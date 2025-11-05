import * as vscode from 'vscode';

import fs from 'fs';
import { EventEmitter } from 'vscode';
import { MILLISECONDS_IN_SECOND } from '../const';
import { DatalogView } from '../views/DatalogView';

export const BUFFER_FLUSH_TIMEOUT_MS = 1 * MILLISECONDS_IN_SECOND; // ms
const PLOT_MAX_ROWS = 100000;

type PlotStartEvent = { columns: string[]; rows: number[][] | undefined };
type PlotDataEvent = number[];
// type PlotBarUpdateEvent = number[];

export class PlotManager {
    private _initialized = false;
    private _startTime: number = 0;
    private _columns: string[] | undefined = undefined;
    private _buffer: number[] | undefined = undefined;
    private _bufferTimeout: NodeJS.Timeout | null = null;
    private _lastValues: number[] | undefined = undefined;
    private _data: number[][] | undefined = undefined;
    private _datastream: fs.WriteStream | null = null;

    public readonly onPlotStarted = new EventEmitter<PlotStartEvent>();
    public readonly onPlotData = new EventEmitter<PlotDataEvent>();

    public static create(): PlotManager {
        const pm = new PlotManager();
        pm.onPlotStarted.event(() => {
            // write header to file
            // todo; check if already open, do sg to "resize"
        });
        let lineCountForFlush = 0;
        pm.onPlotData.event((row) => {
            // write to file
            if (pm._datastream) {
                pm._datastream.write(
                    row
                        .map((v) =>
                            typeof v === 'number' && !isNaN(v) ? v.toString() : '',
                        )
                        .join(',') + '\n',
                );
                if (++lineCountForFlush % 50 === 0) pm._datastream.uncork();
            }
        });

        pm.onPlotStarted.event(({ columns, rows }) => {
            // send to webview
            DatalogView.Instance?.setHeaders(columns, rows).catch(console.error);
        });
        pm.onPlotData.event((row) => {
            // send to webview
            DatalogView.Instance?.addData(row).catch(console.error);
        });

        return pm;
    }

    private get delta(): number {
        const now = Date.now();
        const seconds = ((now - this._startTime) / 1000).toFixed(3);
        return Number(seconds);
    }

    public get datalogcolumns(): string[] {
        return ['timestamp', ...(this._columns ?? [])];
    }

    public get data(): number[][] {
        return this._data ? this._data : [];
    }

    public get latest(): number[] | undefined {
        return this._lastValues;
    }

    public async close() {
        if (this._datastream) {
            await new Promise<void>((resolve, reject) => {
                this._datastream!.end(() => {
                    this._datastream = null;
                    resolve();
                });
                this._datastream!.on('error', reject);
            });
        }

        this._buffer = undefined;
        this._startTime = 0;
        if (this._bufferTimeout) {
            clearTimeout(this._bufferTimeout);
            this._bufferTimeout = null;
        }

        // this._columns = undefined;
        // this._lastValues = undefined;
        // this._data = [];
    }

    public get bufferComplete(): boolean {
        if (!this._initialized || !this._columns?.length || !this._buffer?.length)
            return false;
        return (
            this._buffer.length === this._columns.length &&
            this._buffer.every((v) => typeof v === 'number' && !isNaN(v))
        );
    }

    private resetBuffer(resetLastValues: boolean = false) {
        if (!this._initialized || !this._columns?.length) return;
        this._buffer = new Array(this._columns.length).fill(NaN);

        if (resetLastValues) {
            this._lastValues = new Array(this._columns.length).fill(NaN);
        }
    }

    private flushBuffer() {
        if (
            !this._initialized ||
            !this._columns?.length ||
            !this._buffer?.length ||
            !this._lastValues?.length
        )
            return;

        const hasData = this._buffer.some((v) => typeof v === 'number' && !isNaN(v));
        if (!hasData) return;

        const lineToWrite = [this.delta, ...this._buffer];
        this._data?.push(lineToWrite);
        if (this._data && this._data.length > PLOT_MAX_ROWS) {
            this._data.shift(); // keep last entries
        }

        this.onPlotData.fire(lineToWrite);

        this.resetBuffer(false);
        this._bufferTimeout = null;
    }

    public async resetPlotParser() {
        await this.close();

        this._columns = this._data = this._lastValues = this._buffer = undefined;
        this._initialized = false;
        this.resetBuffer(true);

        // reset all also on listener/view side
        this.onPlotStarted.fire({ columns: this.datalogcolumns, rows: [] });
    }

    public clear(columnsToClear?: string[]) {
        if (!this._initialized || !this._columns?.length || !this._buffer?.length)
            return;

        let allColumnsToClear = false;
        if (!columnsToClear?.length) {
            // clear all
            allColumnsToClear = true;
        } else {
            // specific columns to clear
            // if any column does not exist, ignore the paty
            // check if all existing columns are mentioned
            const allExist = this._columns.every((col) =>
                columnsToClear?.includes(col),
            );

            if (allExist) {
                allColumnsToClear = true;
            } else {
                // clear specific columns both buffer and data
                columnsToClear.forEach((col) => {
                    const idx = this._columns?.indexOf(col);
                    if (idx !== undefined && idx >= 0 && idx < this._buffer!.length) {
                        this._buffer![idx] = NaN;
                        this._data =
                            this._data?.map((row) => {
                                row[idx + 1] = NaN; // +1 because of timestamp column
                                return row;
                            }) || [];
                    }
                });
                return;
            }
        }

        if (allColumnsToClear) {
            // clear all
            this._data = [];
            this.resetBuffer(true);
            return;
        }
    }

    public start(columns_: string[]) {
        this._startTime = Date.now();
        this._columns = columns_;
        this._data = [];

        this._initialized = true;
        this.resetBuffer(true);
        this.onPlotStarted.fire({ columns: this.datalogcolumns, rows: this.data });
    }

    public addColumns(newColumns: string[]) {
        if (!this.running) {
            this.start(newColumns);
            return;
        }

        if (!this._initialized || !this._columns?.length || !this._buffer?.length)
            return;
        if (!newColumns.length) return;

        newColumns.forEach((col) => {
            if (!this._columns?.includes(col)) this._columns?.push(col);
        });

        // resize buffer and last values
        this._buffer.push(...new Array<number>(newColumns.length).fill(NaN));
        this._lastValues?.push(...new Array<number>(newColumns.length).fill(NaN));

        // resize data rows
        if (this._data) {
            this._data = this._data.map((row) => [
                ...row,
                ...new Array<number>(newColumns.length).fill(NaN),
            ]);
        }

        this.onPlotStarted.fire({ columns: this.datalogcolumns, rows: this.data });
    }

    public async stop() {
        this.flushBuffer();
        await this.close();
    }

    public flushPlotBuffer() {
        this.flushBuffer();
    }

    public get running(): boolean {
        return (
            this._initialized &&
            !!this._columns?.length &&
            !!this._buffer?.length &&
            !!this._lastValues?.length
        );
    }

    public get columns(): string[] {
        return this._columns || [];
    }

    public getBufferAt(index: number): number {
        if (!this._initialized || !this._columns?.length || !this._buffer?.length)
            return Number.NaN;
        if (index < 0 || index >= this._buffer.length) return Number.NaN;
        return this._buffer[index];
    }

    public setBufferAt(index: number, value: number) {
        if (
            !this._initialized ||
            !this._columns?.length ||
            !this._buffer?.length ||
            !this._lastValues?.length
        )
            return;

        if (index < 0 || index >= this._buffer.length) return;
        this._buffer[index] = value;
        this._lastValues[index] = value;
    }

    public setCellRow(rows: { name: string; value: number }[]) {
        rows.forEach(({ name, value }) => this.setCellData(name, value));
    }

    public setCellData(name: string, value: number) {
        if (!this.running) this.start([name]);
        let idx = this._columns?.indexOf(name);
        if (idx === undefined || idx < 0) {
            this.addColumns([name]);
            idx = this._columns?.indexOf(name);
        }

        if (typeof idx === 'number' && idx >= 0) {
            const values = Array(this._columns?.length).fill(NaN) as number[];
            values[idx] = value;
            this.setRowValues(values);
        }
    }

    public setRowValues(values: number[]) {
        if (
            !this._initialized ||
            !this._columns?.length ||
            !this._buffer?.length ||
            !this._lastValues?.length
        )
            return;

        // check if any values are overlapping
        for (let i = 0; i < this.columns.length; i++) {
            if (!isNaN(values[i]) && !isNaN(this.getBufferAt(i))) {
                // overlapping value, flush buffers
                this.flushPlotBuffer();
                break;
            }
        }

        // merge values to buffer
        for (let i = 0; i < Math.min(values.length, this.columns.length); i++) {
            if (typeof values[i] === 'number' && !isNaN(values[i])) {
                this.setBufferAt(i, values[i]);
            }
        }

        // check if buffer is full
        this.processPostDataReceived();
    }

    public addMarker(markerName: string) {
        if (!this.running) return;
        DatalogView.Instance?.addMarker(markerName, this.delta).catch(console.error);
    }

    public processPostDataReceived() {
        if (!this._initialized || !this._columns?.length || !this._buffer?.length)
            return;
        if (this.bufferComplete) {
            this.flushPlotBuffer();
        } else if (this._bufferTimeout === null) {
            this._bufferTimeout = setTimeout(() => {
                this.flushBuffer();
            }, BUFFER_FLUSH_TIMEOUT_MS);
        }
    }

    public async openDataFile(uri: vscode.Uri) {
        if (!this.data || !this.columns) throw new Error('No plot data available.');
        const data1 = this.data.map((row) =>
            row.map((v) =>
                typeof v === 'number' && !Number.isNaN(v) ? v.toString() : '',
            ),
        ); // clone
        const csvRows = [
            this.datalogcolumns.join(','),
            ...data1.map((row) => row.join(',')),
        ];
        const csvContent = csvRows.join('\n');

        // we will stream subsequent data to this file
        const datastream = fs.createWriteStream(uri.fsPath, {
            flags: 'w',
            flush: true,
        });
        if (!datastream) throw new Error('Failed to open datalog file for writing.');

        await new Promise<void>((resolve, reject) => {
            datastream?.write(csvContent, (error) => {
                if (error) {
                    reject(error);
                } else {
                    resolve();
                }
            });
        });
        await vscode.window.showTextDocument(uri, { preview: false });

        // keep it running
        if (this.running) this._datastream = datastream;
    }
}

export const plotManager = PlotManager.create();
