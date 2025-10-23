import * as vscode from 'vscode';
import { DeviceMetadata } from '../communication';
import { EXTENSION_KEY } from '../const';
import { showWarning } from './diagnostics';
import { TreeDP } from './tree-commands';

// const CONFIG_BASEKEY = EXTENSION_KEY + '.';
export const enum ConfigKeys {
    DeviceLastConnectedName = 'lastconnected-device-name',
    DeviceAutoConnectLast = 'autoconnect-last-device',
    TerminalAutoClear = 'autoclear-terminal',
    ConnectionTimeout = 'connection-timeout',
    DeviceVisibilityTimeout = 'device-visibility-timeout',
    DeviceNotificationPlotFilter = 'device-notification-plot-filter',
    StopScanOnBlur = 'stop-scan-on-blur',

    // Nested object for feature flags
    FeatureFlags = 'feature-flags',
}

export enum FeatureFlags {
    // NOTE: needs to be kept in sync with package.json
    AutoStartOnMagicHeader = 'autostart-on-magicheader',
    LogDeviceNotification = 'log-device-notification',
    LogTunnelNotification = 'log-tunnel-notification',
    PlotDeviceNotification = 'plot-device-notification',
    PlotDataFromStdout = 'plot-data-from-stdout',
    AutoConnectFirstUSBDevice = 'autoconnect-first-usb-device',
    PybricksUseApplicationInterfaceForPybricksProtocol = 'pybricks-application-interface-for-pybricks-protocol',
}
export function getConfig<T>(key: string) {
    // use the extension section so keys are the short names from ConfigKeys
    return vscode.workspace.getConfiguration(EXTENSION_KEY).get<T>(key);
}

export async function updateConfig(key: string, value: unknown) {
    try {
        await vscode.workspace
            .getConfiguration(EXTENSION_KEY)
            .update(key, value, vscode.ConfigurationTarget.Global);
    } catch (err) {
        showWarning(`Error updating config: ${String(err)}`);
    }
}

class Config {
    private static previousConfig: vscode.WorkspaceConfiguration | undefined =
        undefined;
    public static onChanged =
        new vscode.EventEmitter<vscode.ConfigurationChangeEvent>();

    public static handleUpdate(e: vscode.ConfigurationChangeEvent) {
        this.onChanged.fire(e);
    }
    private static read<T>(key: ConfigKeys, defaultValue?: T): T {
        const value = getConfig<T>(key);
        if (value === undefined && defaultValue !== undefined) {
            return defaultValue;
        }
        return value as T;
    }
    private static async write(key: ConfigKeys, value: unknown) {
        await updateConfig(key, value);
    }
    public static getKey(key: ConfigKeys) {
        return `${EXTENSION_KEY}.${key}`;
    }

    // helper for toggling boolean flags
    private static async toggleBoolean(key: ConfigKeys, value?: boolean) {
        const current = this.read<boolean>(key) ?? false;
        const next = value === undefined ? !current : value;
        await this.write(key, next);
        return next;
    }

    public static get<T>(key: ConfigKeys, defaultValue?: T) {
        return this.read<T>(key, defaultValue);
    }
    public static async set(key: ConfigKeys, value: unknown) {
        await this.write(key, value);
    }
    public static toggle(key: ConfigKeys, value?: boolean) {
        return this.toggleBoolean(key, value);
    }

    public static encodeDeviceKey(name: string, devtype: string) {
        DeviceMetadata.generateId(name, devtype);
    }
    public static decodeDeviceKey(value: string) {
        const [devtype, name] = value ? value.split(/:(.+)/).slice(0, 2) : [];
        return { name, devtype };
    }

    static FeatureFlag = {
        get: (flag: FeatureFlags) => {
            const flags = this.read<{ [key: string]: boolean }>(
                ConfigKeys.FeatureFlags,
            );
            return flags ? !!flags[flag] : false;
        },
        toggle: async (flag: FeatureFlags, value?: boolean) => {
            const flags =
                this.read<{ [key: string]: boolean }>(ConfigKeys.FeatureFlags) || {};
            const current = !!flags[flag];
            const next = value === undefined ? !current : value;
            flags[flag] = next;
            await this.write(ConfigKeys.FeatureFlags, flags);
            return next;
        },
    };
}

export type ConfigMetaDataEntry = {
    type: 'boolean' | 'number' | 'string' | 'object';
    description?: string;
    properties?: Record<string, ConfigMetaDataEntry>;
};

export const configDescriptionsFromPackage = new Map<string, string>();
export function registerConfig(context: vscode.ExtensionContext) {
    try {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        const packageConfig = context.extension.packageJSON.contributes.configuration
            .properties as Record<string, ConfigMetaDataEntry>;
        for (let [key, descriptor] of Object.entries(packageConfig)) {
            if (['boolean', 'number', 'string'].includes(descriptor.type)) {
                if (key.startsWith(EXTENSION_KEY + '.'))
                    key = key.slice(EXTENSION_KEY.length + 1);
                configDescriptionsFromPackage.set(key, descriptor.description || '');
            } else if (descriptor.type === 'object' && descriptor.properties) {
                Object.entries(descriptor.properties).forEach(
                    ([key, value]: [string, ConfigMetaDataEntry]) => {
                        configDescriptionsFromPackage.set(key, value.description || '');
                    },
                );
            }
        }
    } catch {
        // NOOP
    }

    vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(EXTENSION_KEY)) {
            Config.handleUpdate(e);
            TreeDP.refresh();
        }
    });
}

export default Config;
