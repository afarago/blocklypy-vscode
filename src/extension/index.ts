import * as vscode from 'vscode';

type LogDebugEvent = {
    message: string;
    filepath?: string;
    line?: number;
    show?: boolean;
};

type LogDebugFromHubEvent = {
    message: string;
    filepath?: string;
    line?: number;
    linebreak?: boolean; // default true
};

let debugLogEventEmitter = new vscode.EventEmitter<LogDebugEvent>();
export { debugLogEventEmitter };

let debugLogEventFromHubEmitter = new vscode.EventEmitter<LogDebugFromHubEvent>();
export { debugLogEventFromHubEmitter };

export function logDebug(
    message: string,
    filepath?: string,
    line: number | undefined = undefined,
    show: boolean = false,
) {
    debugLogEventEmitter.fire({ message, filepath, line, show });
}

export function logDebugFromHub(
    message: string,
    filepath?: string,
    line?: number,
    linebreak = true,
) {
    debugLogEventFromHubEmitter.fire({ message, filepath, line, linebreak });
}

let treeRefreshEventEmitter = new vscode.EventEmitter<boolean | undefined>();
export { treeRefreshEventEmitter };

export function RefreshTree(checkStaleAlso?: boolean) {
    treeRefreshEventEmitter.fire(checkStaleAlso);
}
