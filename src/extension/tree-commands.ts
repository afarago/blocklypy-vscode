import * as vscode from 'vscode';
import { DeviceMetadata } from '../communication';
import { ConnectionManager } from '../communication/connection-manager';
import { BaseLayer, DeviceChangeEvent } from '../communication/layers/base-layer';
import { EXTENSION_KEY } from '../const';
import { PybricksDebugEnabled } from '../debug-tunnel/compile-helper';
import { getStateString, hasState, onStateChange, StateProp } from '../logic/state';
import { Commands } from './commands';
import Config, {
    configDescriptionsFromPackage,
    ConfigKeys,
    FeatureFlags,
} from './config';
import { BaseTreeDataProvider, BaseTreeItem, TreeItemData } from './tree-base';
import { getSignalIcon, ToCapialized } from './utils';

enum Subtree {
    Commands = 'Commands',
    Devices = 'Devices',
    Settings = 'Settings and Feature Flags',
}

const DEVICE_VISIBILITY_CHECK_INTERVAL = 10 * 1000;

export interface TreeItemExtData extends TreeItemData {
    metadata?: DeviceMetadata;
}

class CommandsTreeDataProvider extends BaseTreeDataProvider<TreeItemExtData> {
    public deviceMap = new Map<string, TreeItemExtData>();

    override getTreeItem(element: TreeItemExtData): BaseTreeItem {
        const retval = super.getTreeItem(element) as BaseTreeItem;

        // customize label for some commands
        switch (element.command) {
            case String(Commands.DisconnectDevice):
                retval.label =
                    hasState(StateProp.Connected) && ConnectionManager.client?.connected
                        ? `Disconnect from ${ConnectionManager.client?.name}`
                        : 'Disconnect';
                break;
            case String(Commands.StopUserProgram):
                const slotname = ConnectionManager.client?.slotName;
                retval.label = `${retval.command?.title} ${
                    slotname ? `[${slotname}]` : ''
                }`;
                break;
            case String(Commands.StatusPlaceHolder):
                retval.label = 'Status: ' + ToCapialized(getStateString());
                break;
            case String(Commands.ToggleSetting):
                if (element.contextValue === 'config') {
                    retval.check = element.check =
                        Config.get<boolean>(element.id as ConfigKeys) === true;
                } else if (element.contextValue === 'feature-flag') {
                    retval.check = element.check =
                        Config.FeatureFlag.get(element.id as FeatureFlags) === true;
                }
                break;
            case String(Commands.ConnectDevice):
                if (element.title && element.id) {
                    const active =
                        element?.id === ConnectionManager.client?.id &&
                        ConnectionManager.client?.connected
                            ? '🔵 '
                            : '';
                    retval.label = `${active}${element.title} [${element.contextValue}]`;
                }
        }
        return retval;
    }

    getChildren(element?: TreeItemExtData): vscode.ProviderResult<TreeItemExtData[]> {
        if (!element?.id)
            return [
                {
                    command: Commands.StatusPlaceHolder,
                },
                ...(hasState(StateProp.Connected)
                    ? [
                          {
                              title: Subtree.Commands,
                              id: Subtree.Commands,
                              command: '',
                              collapsibleState:
                                  vscode.TreeItemCollapsibleState.Expanded,
                          },
                      ]
                    : []),
                {
                    title: Subtree.Devices,
                    id: Subtree.Devices,
                    command: '',
                    collapsibleState: vscode.TreeItemCollapsibleState.Expanded,
                },
                {
                    title: Subtree.Settings,
                    id: Subtree.Settings,
                    command: '',
                    collapsibleState: vscode.TreeItemCollapsibleState.Expanded,
                },
            ];

        if (element.id === Subtree.Commands) {
            // LATER: enable compile and run only for correct file types
            // const isBlocklyPy = vscode.window.active
            // const isActivePython =
            //     vscode.window.activeTextEditor?.document.languageId === 'python';

            const elems = [] as TreeItemData[];
            if (hasState(StateProp.Connected) && ConnectionManager.client?.connected) {
                elems.push({ command: Commands.CompileAndRun });
                if (PybricksDebugEnabled())
                    elems.push({ command: Commands.CompileAndRunWithDebug });
                elems.push({
                    command: hasState(StateProp.Running)
                        ? Commands.StopUserProgram
                        : Commands.StartUserProgram,
                });
                elems.push({ command: Commands.DisconnectDevice });
            }
            return elems;
        } else if (element.id === Subtree.Devices) {
            const elems = Array.from(this.deviceMap.values());

            // scan enabled layers
            if (ConnectionManager.canScan) {
                if (!hasState(StateProp.Scanning)) {
                    elems.push({
                        title: 'Click to start scanning.',
                        // icon: '$(circle-slash)',
                        command: Commands.StartScanning,
                    });
                } else if (elems.length === 0) {
                    // Show scanning status if no devices
                    elems.push({
                        title: 'Scanning for devices...',
                        icon: '$(loading~spin)',
                        command: Commands.StopScanning,
                    });
                }
            }

            // handle non-scanning layers
            if (!hasState(StateProp.Connected)) {
                for (const layer of ConnectionManager.getLayers(false)) {
                    const name = (layer.constructor as typeof BaseLayer).descriptor
                        .name;
                    elems.push({
                        title: `Click to connect to ${name}.`,
                        icon: '$(plug)',
                        command: Commands.ManualConnectDevice,
                        commandArguments: [layer.descriptor.id],
                    });
                }
            }

            return elems;
        } else if (element.id === Subtree.Settings) {
            const settingsToShow = [
                ConfigKeys.DeviceAutoConnectLast,
                ConfigKeys.TerminalAutoClear,
            ];
            const featureFlags = Object.values(FeatureFlags);

            const elems1 = [
                ...settingsToShow.map((key) => [key, 'config'] as const),
                ...featureFlags.map((key) => [key, 'feature-flag'] as const),
            ];

            const elems = elems1
                .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
                .map(
                    ([key, type]) =>
                        ({
                            id: key as string,
                            contextValue: type,
                            title: key as string,
                            command: Commands.ToggleSetting,
                            commandArguments: [type, key],
                            tooltip: configDescriptionsFromPackage.get(key) || '',
                        } satisfies TreeItemExtData),
                );
            return elems;
        }
    }

    public checkForStaleDevices(forced: boolean = false) {
        const now = Date.now();
        let changed = false;
        for (const [id, item] of this.deviceMap.entries()) {
            if (!forced && ConnectionManager.client?.id === id) continue;

            if (now > (item.metadata?.validTill ?? 0)) {
                this.deviceMap.delete(id);
                changed = true;
            }
        }
        if (changed) {
            this.refresh();
        }
    }
}

export const TreeDP = new CommandsTreeDataProvider();
export function registerCommandsTree(context: vscode.ExtensionContext) {
    // vscode.window.registerTreeDataProvider(EXTENSION_KEY + '-commands', TreeCommands);
    TreeDP.init(context);

    const treeview = vscode.window.createTreeView(EXTENSION_KEY + '-commands', {
        treeDataProvider: TreeDP,
    });
    context.subscriptions.push(treeview);

    // --- Commands tree ---
    onStateChange(() => {
        treeview.badge = {
            value: hasState(StateProp.Connected) ? 1 : 0,
            tooltip: 'Connected devices',
        };
    });

    // --- Devices tree ---
    treeview.onDidChangeVisibility(async (e) => {
        if (e.visible) {
            try {
                await ConnectionManager.startScanning();

                if (!hasState(StateProp.Connected))
                    await ConnectionManager.autoConnectOnInit();
            } catch {
                // noop - will fail with the startup
            }
        } else {
            ConnectionManager.stopScanning();
        }
    });

    const addDevice = (event: DeviceChangeEvent) => {
        const metadata = event.metadata;
        const id = metadata.id;
        if (!id) return;

        const item = TreeDP.deviceMap.get(id) ?? ({} as TreeItemExtData);
        const isNew = item.command === undefined;
        const name = metadata.name ?? 'Unknown';
        // const tooltip =
        //     ConnectionManager.client?.id === id
        //         ? MarkdownStringFromLines(ConnectionManager.client?.descriptionKVP)
        //         : MarkdownStringFromLines(metadata.mdtooltip);

        Object.assign(item, {
            name,
            id,
            metadata,
            title: name,
            command: Commands.ConnectDevice,
            commandArguments: [id, metadata.deviceType],
            description: metadata.broadcastAsString
                ? `⛁ ${metadata.broadcastAsString}`
                : '',
            //  on ch:${device.lastBroadcast.channel}
            contextValue: metadata.deviceType,
        } as TreeItemExtData);

        if (metadata.rssi !== undefined) item.icon = getSignalIcon(metadata.rssi);

        if (isNew) {
            TreeDP.deviceMap.set(id, item);
            TreeDP.refresh();
        } else {
            TreeDP.refreshItem(item);
        }
    };
    context.subscriptions.push(ConnectionManager.onDeviceChange(addDevice));

    // Periodically remove devices not seen for X seconds
    // Except for currently connected device, that will not broadcast, yet it should stay in the list
    const timer = setInterval(
        () => TreeDP.checkForStaleDevices(),
        DEVICE_VISIBILITY_CHECK_INTERVAL,
    );

    context.subscriptions.push(
        treeview,
        new vscode.Disposable(() => clearInterval(timer)),
    );

    // --- Settings tree ---
    treeview.onDidChangeCheckboxState(
        (e: vscode.TreeCheckboxChangeEvent<TreeItemData>) => {
            e.items.forEach(([elem]) => {
                if (elem.command) {
                    vscode.commands.executeCommand(
                        elem.command,
                        ...(elem.commandArguments ?? []),
                    );
                }
            });
        },
    );

    context.subscriptions.push(
        Config.onChanged.event(async (e) => {
            if (
                !e.affectsConfiguration(
                    Config.getKey(ConfigKeys.DeviceAutoConnectLast),
                ) &&
                !e.affectsConfiguration(Config.getKey(ConfigKeys.FeatureFlags))
            ) {
                return;
            }

            if (!hasState(StateProp.Connected))
                await ConnectionManager.autoConnectOnInit();
        }),
    );
}
