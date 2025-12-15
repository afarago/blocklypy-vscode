import * as vscode from 'vscode';

import path from 'path';
import { clearAllSlots, clearSlotAny } from '../commands/clear-slots';
import { compileAndRunAsync, compileOnlyAsync } from '../commands/compile-and-run';
import { connectDeviceAsyncAny } from '../commands/connect-device';
import { PromptDeviceNotificationPlotFilter } from '../commands/device-notifications';
import { disconnectDeviceAsync } from '../commands/disconnect-device';
import { moveSlotAny } from '../commands/move-slot';
import { openHelpPortal } from '../commands/open-help-portal';
import { startUserProgramAsync } from '../commands/start-user-program';
import { stopUserProgramAsync } from '../commands/stop-user-program';
import {
    createPybricksFile,
    insertPybricksTemplate,
} from '../commands/template-helpers';
import { DeviceOSType, StartMode } from '../communication/clients/base-client';
import { HubOSBaseClient } from '../communication/clients/hubos-base-client';
import { PybricksBleClient } from '../communication/clients/pybricks-ble-client';
import { ConnectionManager } from '../communication/connection-manager';
import { BLOCKLYPY_COMMANDS_VIEW_ID, EXTENSION_KEY } from '../const';
import { loadPythonAssetModule } from '../logic/compile';
import { hasState, StateProp } from '../logic/state';
import { plotManager } from '../plot/plot';
import { getActiveFileFolder, getDateTimeString } from '../utils/files';
import { BlocklypyViewerProvider, ViewType } from '../views/BlocklypyViewerProvider';
import { DatalogView } from '../views/DatalogView';
import { PythonPreviewProvider } from '../views/PythonPreviewProvider';
import { HubSlotsPanel } from '../views/hub-slots-panel';
import Config, { ConfigKeys, FeatureFlags } from './config';
import { logDebug } from './debug-channel';
import { showInfo, showWarning } from './diagnostics';
import { promptInstallPybricks } from './pip-check';
import { RefreshTree } from './tree-commands';
import { openOrActivate as openOrActivateAsync, wrapErrorHandling } from './utils';

// Define the BlocklyPyCommand enum for all command strings
export enum Commands {
    ConnectDevice = EXTENSION_KEY + '.connectDevice',
    DisconnectDevice = EXTENSION_KEY + '.disconnectDevice',
    ManualConnectDevice = EXTENSION_KEY + '.manualConnectDevice',
    Compile = EXTENSION_KEY + '.compile',
    CompileAndRun = EXTENSION_KEY + '.compileAndRun',
    CompileAndRunWithDebug = EXTENSION_KEY + '.compileAndRunWithDebug',
    StartUserProgram = EXTENSION_KEY + '.startUserProgram',
    StopUserProgram = EXTENSION_KEY + '.stopUserProgram',
    StatusPlaceHolder = EXTENSION_KEY + '.statusPlaceholder',
    ToggleSetting = EXTENSION_KEY + '.toggleSetting',
    DisplayNextView = EXTENSION_KEY + '.blocklypyViewer.displayNextView',
    DisplayPreviousView = EXTENSION_KEY + '.blocklypyViewer.displayPreviousView',
    DisplayPreview = EXTENSION_KEY + '.blocklypyViewer.displayPreview',
    DisplayPycode = EXTENSION_KEY + '.blocklypyViewer.displayPycode',
    DisplayPseudo = EXTENSION_KEY + '.blocklypyViewer.displayPseudo',
    DisplayGraph = EXTENSION_KEY + '.blocklypyViewer.displayGraph',
    ShowPythonPreview = EXTENSION_KEY + '.showPythonPreview',
    ShowSource = EXTENSION_KEY + '.pythonPreview.showSource',
    MoveSlot = EXTENSION_KEY + '.moveSlot',
    ClearSlot = EXTENSION_KEY + '.clearSlot',
    ClearAllSlots = EXTENSION_KEY + '.clearAllSlots',
    StartScanning = EXTENSION_KEY + '.startScanning',
    StopScanning = EXTENSION_KEY + '.stopScanning',
    DataLogOpenCSV = EXTENSION_KEY + '.datalogOpenCSV',
    DatalogClear = EXTENSION_KEY + '.datalogClear',
    SetChartType = EXTENSION_KEY + '.setChartType',
    PromptDeviceNotificationPlotFilter = EXTENSION_KEY +
        '.promptDeviceNotificationPlotFilter',
    StartREPL = EXTENSION_KEY + '.startREPL',
    StartHubMonitor = EXTENSION_KEY + '.startHubMonitor',
    InsertPybricksTemplate = EXTENSION_KEY + '.insertPybricksTemplate',
    CreatePybricksFile = EXTENSION_KEY + '.createPybricksFile',
    OpenHelpPortal = EXTENSION_KEY + '.openHelpPortal',
    InstallPybricksPackage = EXTENSION_KEY + '.installPybricksPackage',
    ManageHubSlots = EXTENSION_KEY + '.manageHubSlots',
    HubSlotsMoveFromList = EXTENSION_KEY + '.hubSlots.moveFromList',
    HubSlotsClearFromList = EXTENSION_KEY + '.hubSlots.clearFromList',
    // StartJupyter = EXTENSION_KEY + '.startJupyter',
}

export const CommandMetaData: CommandMetaDataEntryExtended[] = [
    {
        command: Commands.OpenHelpPortal,
        title: 'Pybricks Help Portal',
        icon: '$(book)',
        handler: openHelpPortal, // Use the imported command handler
    },
    {
        command: Commands.ToggleSetting,
        handler: async (...args: unknown[]) => {
            const contextValue = args[0] as string | undefined;
            const id = args[1] as string | undefined;
            if (!contextValue || !id) return;

            if (contextValue === 'config') await Config.toggle(id as ConfigKeys);
            else if (contextValue === 'feature-flag')
                await Config.FeatureFlag.toggle(id as FeatureFlags);
            RefreshTree();
        },
    },
    {
        command: Commands.StatusPlaceHolder,
        title: 'Status',
        icon: '$(debug-stackframe)',
        handler: async () => {},
    },
    {
        command: Commands.DisplayNextView,
        handler: async () => {
            await BlocklypyViewerProvider.Get?.rotateViewsAsync(true);
        },
    },
    {
        command: Commands.DisplayPreviousView,
        handler: async () => {
            await BlocklypyViewerProvider.Get?.rotateViewsAsync(false);
        },
    },
    {
        command: Commands.DisplayPycode,
        handler: async () =>
            BlocklypyViewerProvider.Get?.showViewAsync(ViewType.Pycode),
    },
    {
        command: Commands.DisplayPseudo,
        handler: async () =>
            BlocklypyViewerProvider.Get?.showViewAsync(ViewType.Pseudo),
    },
    {
        command: Commands.DisplayPreview,
        handler: async () =>
            BlocklypyViewerProvider.Get?.showViewAsync(ViewType.Preview),
    },
    {
        command: Commands.DisplayGraph,
        handler: async () => BlocklypyViewerProvider.Get?.showViewAsync(ViewType.Graph),
    },
    {
        command: Commands.ShowPythonPreview,
        handler: async () => {
            const editor = vscode.window.activeTextEditor;
            if (editor && editor.document.languageId === 'python') {
                await vscode.commands.executeCommand(
                    'vscode.openWith',
                    PythonPreviewProvider.encodeUri(editor.document.uri),
                    PythonPreviewProvider.TypeKey,
                    {
                        viewColumn: vscode.ViewColumn.Beside,
                        preview: true,
                    },
                );
            } else {
                showInfo('Open a Python file to preview.');
            }
        },
    },
    {
        command: Commands.ShowSource,
        handler: async () => {
            const uri: vscode.Uri | undefined = PythonPreviewProvider.Get?.ActiveUri;
            if (!uri) return;
            const origialUri = PythonPreviewProvider.decodeUri(uri);
            await openOrActivateAsync(origialUri);
        },
    },
    {
        command: Commands.ConnectDevice,
        handler: connectDeviceAsyncAny,
    },
    {
        command: Commands.ManualConnectDevice,
        handler: async (...args: unknown[]) => {
            const layerid = args[0] as string | undefined;
            await ConnectionManager.connectManuallyOnLayer(layerid);
        },
    },
    {
        command: Commands.Compile,
        handler: async () => {
            await compileOnlyAsync();
        },
    },
    {
        command: Commands.CompileAndRun,
        handler: async () => {
            await compileAndRunAsync();
        },
    },
    {
        command: Commands.CompileAndRunWithDebug,
        handler: async () => {
            await compileAndRunAsync(undefined, undefined, true);
        },
    },
    {
        command: Commands.StartUserProgram,
        handler: async (...args: unknown[]) => {
            const slot_input = args[0] as number | undefined;
            await startUserProgramAsync(slot_input);
        },
    },
    {
        command: Commands.StopUserProgram,
        handler: stopUserProgramAsync,
    },
    {
        command: Commands.DisconnectDevice,
        handler: disconnectDeviceAsync,
    },
    {
        command: Commands.MoveSlot,
        handler: moveSlotAny,
    },
    {
        command: Commands.ClearSlot,
        handler: clearSlotAny,
    },
    {
        command: Commands.ClearAllSlots,
        handler: clearAllSlots,
    },
    {
        command: Commands.StartScanning,
        title: 'Start Scanning',
        icon: '$(radio-tower)',
        handler: async () => {
            await ConnectionManager.startScanning();
        },
    },
    {
        command: Commands.StopScanning,
        title: 'Stop Scanning',
        icon: '$(radio-tower)',
        handler: async () => {
            ConnectionManager.stopScanning();
            await Promise.resolve();
        },
    },
    {
        command: Commands.DataLogOpenCSV,
        title: 'Open Data Log CSV',
        icon: '$(file-symlink-file)',
        tooltip: 'Auto-save plots to workspace folder using the "plot:" commands.',
        handler: async () => {
            const columns = plotManager.datalogcolumns;
            const data = plotManager.data;
            if (!columns?.length || !data?.length)
                return showInfo('No plot data available.');

            const folderUri = getActiveFileFolder();
            if (!folderUri) return showWarning('No folder or workspace available.');

            const now = new Date();
            const filename = `datalog-${getDateTimeString(now)}.csv`;
            const fileUri = vscode.Uri.joinPath(folderUri, filename);

            await plotManager.openDataFile(fileUri);
            logDebug(`📄 Started datalogging to ${fileUri.fsPath}`);
        },
    },
    {
        command: Commands.DatalogClear,
        handler: async () => {
            await plotManager.resetPlotParser();
        },
    },
    {
        command: Commands.SetChartType,
        handler: async () => {
            await DatalogView.Instance?.setChartType(null);
        },
    },
    {
        command: Commands.PromptDeviceNotificationPlotFilter,
        handler: async () => {
            await PromptDeviceNotificationPlotFilter();
        },
    },
    {
        command: Commands.StartREPL,
        handler: async () => {
            const client = ConnectionManager.client;
            if (!client) {
                throw new Error('Connect a device first.');
            }
            if (
                client?.classDescriptor.os !== DeviceOSType.HubOS &&
                (client?.classDescriptor.os !== DeviceOSType.Pybricks ||
                    !(client instanceof PybricksBleClient) ||
                    !client.hubType?.capabilities.repl)
            ) {
                throw new Error(
                    'Connect a HubOS or Pybricks REPL compatible device first.',
                );
            }

            // Stop any running program
            if (hasState(StateProp.Running)) await client.action_stop();

            await client?.action_start(StartMode.REPL);
        },
    },
    {
        command: Commands.StartHubMonitor,
        handler: async () => {
            const client = ConnectionManager.client;
            if (
                client?.classDescriptor.os !== DeviceOSType.Pybricks ||
                !(client instanceof PybricksBleClient)
            ) {
                throw new Error('Connect a Pybricks device first.');
            }
            if (
                !Config.FeatureFlag.get(
                    FeatureFlags.PybricksUseApplicationInterfaceForPybricksProtocol,
                ) ||
                !Config.FeatureFlag.get(FeatureFlags.PlotDeviceNotification)
            ) {
                const BTN_ENABLE = 'Enable';
                const answer = await vscode.window.showWarningMessage(
                    'Do you want to enable the Pybricks Application Interface and Device Notification plot feature flags now?',
                    {
                        modal: true,
                        detail: `The Hub Monitor requires these feature flags to be enabled. You can change them later in the extension settings if needed.`,
                    },
                    BTN_ENABLE,
                );

                if (answer === BTN_ENABLE) {
                    await Config.FeatureFlag.set(
                        FeatureFlags.PybricksUseApplicationInterfaceForPybricksProtocol,
                        true,
                    );
                    await Config.FeatureFlag.set(
                        FeatureFlags.PlotDeviceNotification,
                        true,
                    );
                } else {
                    throw new Error(
                        'Enable the Pybricks Application Interface and Device Notification plot feature flags to use Hub Monitor.',
                    );
                }
            }
            if (!client.hubType?.capabilities.repl) {
                throw new Error('REPL is not supported by hub.');
            }

            const { uri, content } = await loadPythonAssetModule('hubmonitor.min.py');
            if (!uri || !content) throw new Error('Hub Monitor script not found.');

            await vscode.window.withProgress(
                {
                    location: { viewId: BLOCKLYPY_COMMANDS_VIEW_ID },
                },
                async () => {
                    await client.action_start(StartMode.REPL, content);
                    logDebug(
                        `📡 Started Hub Monitor from ${path.basename(
                            uri.fsPath,
                        )}. Use device notification filter command.`,
                    );
                },
            );
        },
    },
    {
        command: Commands.InsertPybricksTemplate,
        handler: async () => {
            await insertPybricksTemplate();
        },
    },
    {
        command: Commands.CreatePybricksFile,
        handler: async () => {
            await createPybricksFile();
        },
    },
    {
        command: Commands.InstallPybricksPackage,
        handler: async () => {
            await promptInstallPybricks();
        },
    },
    {
        command: Commands.HubSlotsMoveFromList,
        handler: async (...args: unknown[]) => {
            const item = args[0] as { slotIndex?: number } | undefined;
            if (typeof item?.slotIndex === 'number') {
                await moveSlotAny(item.slotIndex);
            } else {
                await moveSlotAny();
            }
        },
    },
    {
        command: Commands.HubSlotsClearFromList,
        handler: async (...args: unknown[]) => {
            const item = args[0] as { slotIndex?: number } | undefined;
            if (typeof item?.slotIndex === 'number') {
                await clearSlotAny(String(item.slotIndex));
            } else {
                await clearSlotAny();
            }
        },
    },
    {
        command: Commands.ManageHubSlots,
        title: 'Manage Hub Slots',
        icon: '$(list-selection)',
        // eslint-disable-next-line @typescript-eslint/require-await
        handler: async () => {
            const client = ConnectionManager.client;
            if (!client) {
                throw new Error('Connect a device first.');
            }
            if (!(client instanceof HubOSBaseClient)) {
                throw new Error('This device does not support slot management.');
            }
            const extension = vscode.extensions.getExtension(
                'afarago.blocklypy-vscode',
            );
            if (!extension) throw new Error('Extension not found');
            HubSlotsPanel.show({ extensionUri: extension.extensionUri }, client);
        },
    },
];

export type CommandMetaDataEntry = {
    command: Commands;
    title?: string;
    icon?: string | { light: string; dark: string };
};

type CommandMetaDataEntryExtended = CommandMetaDataEntry & {
    tooltip?: string;
    handler?: CommandHandler;
};

type CommandHandler = (...args: unknown[]) => Promise<unknown>;

function getHandler(entry: CommandMetaDataEntryExtended): CommandHandler | undefined {
    if (entry.handler) {
        return wrapErrorHandling((...args: unknown[]) => entry.handler!(...args));
    }
    return undefined;
}

export function registerCommands(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        ...CommandMetaData.map((cmd) => {
            return vscode.commands.registerCommand(
                cmd.command,
                getHandler(cmd) ??
                    (() => {
                        showInfo(`Command "${cmd.command}" not implemented yet.`);
                    }),
            );
        }),
    );
}

let _commandsFromPackageJsonCache: CommandMetaDataEntry[];
export function getCommandsFromPackageJson(
    context: vscode.ExtensionContext,
): CommandMetaDataEntry[] {
    if (_commandsFromPackageJsonCache) return _commandsFromPackageJsonCache;

    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const packageEntries = context.extension.packageJSON.contributes
        .commands as CommandMetaDataEntry[];
    _commandsFromPackageJsonCache = packageEntries.concat(CommandMetaData);

    return _commandsFromPackageJsonCache;
}
