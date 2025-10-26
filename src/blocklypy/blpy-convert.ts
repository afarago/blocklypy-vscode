import {
    convertProjectToPython,
    IPyConverterFile,
    IPyConverterOptions,
} from 'blocklypy';
import * as vscode from 'vscode';
import { logDebug } from '../extension';
import GraphvizLoader from '../utils/graphviz-helper';
import { checkExtraFilesForConversion } from './collectfiles';

export async function convertFileToPython(uri: vscode.Uri) {
    const fileUint8Array = await vscode.workspace.fs.readFile(uri);

    const file: IPyConverterFile = {
        name: uri.path.split('/').pop() || 'project',
        buffer: fileUint8Array.buffer as ArrayBuffer,
    };

    // collect additional extra files, such as image for .proj file followig the wedo 2.0 app approach <filewithoutextension\LobbyPreview.jpg>
    const allFiles = await checkExtraFilesForConversion(uri, file);

    const options = {
        output: { 'blockly.svg': true, 'wedo2.preview': true },
        debug: {
            showExplainingComments: true,
            onCustomBlock: handleCustomBlock,
        },
        log: {
            callback: (_level, ...args: unknown[]) => {
                const line = Array.isArray(args) ? args.join(' ') : String(args);
                logDebug(line);
            },
        },
    } satisfies IPyConverterOptions;

    const result = await convertProjectToPython(allFiles, options);
    const filename = Array.isArray(result.name)
        ? result.name.join(', ')
        : result.name || 'Unknown';

    const pycode: string | undefined = Array.isArray(result.pycode)
        ? result.pycode.join('\n')
        : result.pycode;

    const pseudo: string | undefined = result.plaincode;

    const preview: string | undefined =
        result.extra?.['blockly.svg'] || result.extra?.['wedo2.preview'];

    const graphviz = await GraphvizLoader();

    const dependencygraph = result.dependencygraph;
    let graph: string | undefined = undefined;
    if (dependencygraph) {
        graph = await graphviz?.dot(dependencygraph);
    }

    const content = {
        filename,
        pycode,
        pseudo,
        preview,
        graph,
    };
    return content;
}

const handleCustomBlock = (
    blockName: string,
    blockArgs: Record<string, unknown>,
): { pycode: string | string[] } | undefined => {
    switch (blockName) {
        case 'linegraphmonitor_lineGraphClear':
            return { pycode: `print("plot: clear")` };
            break;

        case 'linegraphmonitor_lineGraphClearLine':
            const color2 = blockArgs?.COLOR;
            return { pycode: `print(f"plot: clear color_{${String(color2)}}")` };
            break;

        case 'bargraphmonitor_barGraphClearData':
            return { pycode: `print(f"plot: clear")` };
            break;

        case 'linegraphmonitor_lineGraphAddTo':
        case 'bargraphmonitor_barGraphSetValue':
            {
                const color = blockArgs?.COLOR;
                const value = blockArgs?.VALUE;
                return {
                    pycode: `print(f"plot: color_{${String(color)}}:{${String(
                        value,
                    )}}")`,
                };
            }
            break;

        // case 'linegraphmonitor_lineGraphGetValue': {
        //     // keep in python code a global plot variable -- not much of a value
        //     const color = blockArgs?.COLOR;
        //     const value = blockArgs?.VALUE; // min, max, interval, default
        //     return {
        //         pycode: `42`,
        //     };
        //     break;
        // }
    }
};
