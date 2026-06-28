import * as fs from 'fs';
import {
    getNativePrebuildPath,
    getNativePrebuildRelativePath,
} from './prebuild-resolver';

describe('Native prebuild resolution', () => {
    const originalPlatform = process.platform;
    const originalArch = process.arch;

    afterEach(() => {
        Object.defineProperty(process, 'platform', {
            value: originalPlatform,
            configurable: true,
        });
        Object.defineProperty(process, 'arch', {
            value: originalArch,
            configurable: true,
        });
    });

    const testCases: Array<{
        platform: NodeJS.Platform;
        arch: string;
        moduleName: '@stoprocent/noble' | 'usb';
        expectedRelativePath: string;
        libc?: 'glibc' | 'musl';
    }> = [
        {
            platform: 'win32',
            arch: 'x64',
            moduleName: '@stoprocent/noble',
            expectedRelativePath: 'prebuilds/win32-x64/@stoprocent+noble.node',
        },
        {
            platform: 'win32',
            arch: 'ia32',
            moduleName: '@stoprocent/noble',
            expectedRelativePath: 'prebuilds/win32-ia32/@stoprocent+noble.node',
        },
        {
            platform: 'darwin',
            arch: 'x64',
            moduleName: '@stoprocent/noble',
            expectedRelativePath: 'prebuilds/darwin-x64+arm64/@stoprocent+noble.node',
        },
        {
            platform: 'darwin',
            arch: 'arm64',
            moduleName: '@stoprocent/noble',
            expectedRelativePath: 'prebuilds/darwin-x64+arm64/@stoprocent+noble.node',
        },
        {
            platform: 'linux',
            arch: 'x64',
            moduleName: '@stoprocent/noble',
            libc: 'glibc',
            expectedRelativePath: 'prebuilds/linux-x64/@stoprocent+noble.glibc.node',
        },
        {
            platform: 'linux',
            arch: 'x64',
            moduleName: 'usb',
            libc: 'musl',
            expectedRelativePath: 'prebuilds/usb/prebuilds/linux-x64/node.napi.musl.node',
        },
    ];

    it.each(testCases)(
        'resolves $moduleName for $platform-$arch',
        ({ platform, arch, moduleName, expectedRelativePath, libc }) => {
            Object.defineProperty(process, 'platform', {
                value: platform,
                configurable: true,
            });
            Object.defineProperty(process, 'arch', {
                value: arch,
                configurable: true,
            });

            const resolvedPath = getNativePrebuildRelativePath(moduleName, { libc });
            expect(resolvedPath).toBe(expectedRelativePath);
        },
    );

    it('throws for unsupported usb prebuild on win32-ia32', () => {
        expect(() =>
            getNativePrebuildRelativePath('usb', {
                platform: 'win32',
                arch: 'ia32',
            }),
        ).toThrow('USB prebuild is not bundled for win32-ia32');
    });

    it('resolves host-specific noble and usb prebuilds to files that exist', () => {
        const noblePath = getNativePrebuildPath('@stoprocent/noble', {
            rootDir: process.cwd(),
        });
        expect(fs.existsSync(noblePath)).toBe(true);

        const maybeUsbPath = (() => {
            try {
                return getNativePrebuildPath('usb', { rootDir: process.cwd() });
            } catch {
                return undefined;
            }
        })();

        if (maybeUsbPath) {
            expect(fs.existsSync(maybeUsbPath)).toBe(true);
        }
    });
});