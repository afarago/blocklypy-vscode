// NOTE: consider themeing
// import { default as uPlot } from 'uplot'; // import 'uplot/dist/uPlot.min.css';

import * as vscode from 'vscode';
import { EXTENSION_KEY } from '../const';
import { setContextPlotDataAvailability } from '../extension/context-utils';
import { plotManager } from '../plot/plot';
import { getScriptUri } from './utils';

const DATALOG_PANEL_ID = EXTENSION_KEY + '-datalogview';
const DATALOG_VIEW_ID = EXTENSION_KEY + '-datalogview';
const DATALOG_WEBVIEW_NAME = 'DatalogWebview';

export class DatalogView implements vscode.WebviewViewProvider {
    public static readonly viewType = DATALOG_VIEW_ID;
    private static _instance: DatalogView | undefined;

    private readonly context: vscode.ExtensionContext;
    private currentWebviewView: vscode.WebviewView | undefined;

    private constructor(context: vscode.ExtensionContext) {
        this.context = context;
    }

    // Better static accessor with proper naming
    public static get Instance(): DatalogView | undefined {
        return DatalogView._instance;
    }

    public static register(context: vscode.ExtensionContext): DatalogView {
        const provider = new DatalogView(context);
        DatalogView._instance = provider; // Save instance

        const reg = vscode.window.registerWebviewViewProvider(
            DatalogView.viewType,
            provider,
            { webviewOptions: { retainContextWhenHidden: true } },
        );
        context.subscriptions.push(reg);
        return provider;
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ): void {
        this.currentWebviewView = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this.context.extensionUri, 'dist'),
                // vscode.Uri.joinPath(
                //     this.context.extensionUri,
                //     'node_modules',
                //     'uplot',
                //     'dist',
                // ),
            ],
        };

        // get classname from DatalogView
        const scriptUri = getScriptUri(this.context, webviewView, DATALOG_WEBVIEW_NAME);
        webviewView.webview.html = this.getHtmlForWebview(scriptUri);

        // Initialize the from the webview with the last header data
        setTimeout(() => {
            this.setHeaders(plotManager.datalogcolumns, plotManager.data).catch(
                console.error,
            );
        }, 100);
    }

    public async setHeaders(cols: string[], rows?: number[][]) {
        await setContextPlotDataAvailability(true);

        if (cols.length > 1) await focusChartView();

        await this.currentWebviewView?.webview.postMessage({
            command: 'setHeaders',
            cols,
            rows,
        });
    }

    public async addData(row: number[]) {
        await this.currentWebviewView?.webview.postMessage({
            command: 'addData',
            row,
        });
    }

    /**
     * Add a marker to the plot at the given timestamp.
     */
    public async addMarker(markerName: string, markerTimestamp: number) {
        await this.currentWebviewView?.webview.postMessage({
            command: 'addMarker',
            markerName,
            markerTimestamp,
        });
    }

    private getHtmlForWebview(scriptSrc: vscode.Uri): string {
        return /* html */ `
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="UTF-8" />
                <meta http-equiv="Content-Security-Policy"
                        content="default-src 'none'; style-src 'self' 'unsafe-inline'; script-src * 'unsafe-inline' 'unsafe-eval';"/>
                <style>
                    html, body, #chart-container, #welcome-view {
                        height: 100%;
                        width: 100%;
                        margin: 0;
                        padding: 0;
                        overflow: hidden;
                    }
                    #chart-container {
                        display: block;
                    }
                    #welcome-view {
                        padding-left: 20px;
                        display: block;
                    }
                </style>
            </head>
            <body>
                <div id="welcome-view">
                    <p><b>Hub has not sent any data yet.</b></p>

                    <p>for Pybricks hubs:</p>
                    <ul>
                        <li>Enable 'plot-device-notification' feature flag.</li>
                        <li>Use print commands <code>print("plot: yaw:", hub.imu.heading())</code> or...</li>
                        <li>Add a comment to the end of the line <code># plot(hub.imu.heading())</code> or...</li>
                        <li>Use the 'Start Hub Monitor' command and select 'Set Device Notification Plot Filter' command to filter which data to plot.</li>
                    </ul>

                    <p>for LEGO® SPIKE HubOS v3 hubs:</p>
                    <ul>
                        <li>Enable 'plot-device-notification' feature flag.</li>
                        <li>Hub will send device notifications when program is not running.</li>
                        <li>Use the line graph blocks while running.</li>
                        <li>Select 'Set Device Notification Plot Filter' command to filter which data to plot.</li>
                    </ul>
                    
                </div>
                <div id="chart-container"></div>
                <script src="${scriptSrc.toString()}"></script>
            </body>
            </html>
        `;
    }
}

// To focus the chart view programmatically:
async function focusChartView() {
    // First open the panel (if not already open & focus)
    await vscode.commands.executeCommand('workbench.action.focusPanel');

    // Then focus the specific view container
    await vscode.commands.executeCommand(
        'workbench.view.extension.' + DATALOG_PANEL_ID,
    );
}
