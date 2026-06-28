import * as path from 'path';

export type NativeModuleName = '@stoprocent/noble' | 'noble' | 'usb';
export type LinuxLibc = 'glibc' | 'musl';
export type LinuxArmVariant = 'armv6' | 'armv7';

export type PrebuildResolveOptions = {
    platform?: NodeJS.Platform;
    arch?: string;
    libc?: LinuxLibc;
    armVariant?: LinuxArmVariant;
    rootDir?: string;
};

function normalizeModuleName(moduleName: NativeModuleName): 'noble' | 'usb' {
    return moduleName === 'usb' ? 'usb' : 'noble';
}

function detectLinuxLibc(): LinuxLibc {
    const report = process.report?.getReport?.() as
        | { header?: { glibcVersionRuntime?: string } }
        | undefined;
    return report?.header?.glibcVersionRuntime ? 'glibc' : 'musl';
}

export function getNativePrebuildRelativePath(
    moduleName: NativeModuleName,
    options: Omit<PrebuildResolveOptions, 'rootDir'> = {},
): string {
    const normalized = normalizeModuleName(moduleName);
    const platform = options.platform ?? process.platform;
    const arch = options.arch ?? process.arch;

    let folder: string;
    let filename: string;

    if (platform === 'darwin') {
        if (arch !== 'x64' && arch !== 'arm64') {
            throw new Error(`Unsupported darwin architecture: ${arch}`);
        }
        folder = 'darwin-x64+arm64';
        filename = normalized === 'noble' ? '@stoprocent+noble.node' : 'node.napi.node';
    } else if (platform === 'win32') {
        if (arch !== 'x64' && arch !== 'ia32') {
            throw new Error(`Unsupported win32 architecture: ${arch}`);
        }
        folder = `win32-${arch}`;
        if (normalized === 'usb' && arch === 'ia32') {
            throw new Error('USB prebuild is not bundled for win32-ia32');
        }
        filename = normalized === 'noble' ? '@stoprocent+noble.node' : 'node.napi.node';
    } else if (platform === 'linux') {
        if (arch === 'x64') {
            const libc = options.libc ?? detectLinuxLibc();
            folder = 'linux-x64';
            filename =
                normalized === 'noble'
                    ? `@stoprocent+noble.${libc}.node`
                    : `node.napi.${libc}.node`;
        } else if (arch === 'arm64') {
            folder = 'linux-arm64';
            filename =
                normalized === 'noble'
                    ? '@stoprocent+noble.armv8.node'
                    : 'node.napi.armv8.node';
        } else if (arch === 'arm') {
            const armVariant = options.armVariant ?? 'armv7';
            folder = 'linux-arm';
            filename =
                normalized === 'noble'
                    ? `@stoprocent+noble.${armVariant}.node`
                    : `node.napi.${armVariant}.node`;
        } else {
            throw new Error(`Unsupported linux architecture: ${arch}`);
        }
    } else {
        throw new Error(`Unsupported platform: ${platform}`);
    }

    // usb prebuilds live in a dedicated subdirectory to avoid collision with serialport
    const usbPrefix = normalized === 'usb' ? 'usb/' : '';
    return path.posix.join('prebuilds', usbPrefix + folder, filename);
}

export function getNativePrebuildPath(
    moduleName: NativeModuleName,
    options: PrebuildResolveOptions = {},
): string {
    const rootDir = options.rootDir ?? path.resolve(__dirname, '..', '..');
    const relativePath = getNativePrebuildRelativePath(moduleName, options);
    return path.resolve(rootDir, relativePath);
}