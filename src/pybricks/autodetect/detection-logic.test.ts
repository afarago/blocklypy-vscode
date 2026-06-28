import { HubTypeDescriptors } from './const';
import { autodetectPybricksHub } from './detection-logic';

jest.mock('../../communication/clients/base-client', () => ({
    DeviceOSType: { Pybricks: 'pybricks', HubOS: 'hubos' },
    StartMode: { REPL: 'repl' },
}));

jest.mock('../../communication/connection-manager', () => ({
    ConnectionManager: { client: undefined as unknown },
}));

jest.mock('../../logic/compile', () => ({
    loadPythonAssetModule: jest.fn().mockResolvedValue({ content: 'print("detect")' }),
}));

jest.mock('../../logic/state', () => ({
    StateProp: { Running: 'running' },
    waitForStateWithTimeout: jest.fn().mockResolvedValue(true),
}));

jest.mock('../../extension', () => ({
    extensionContext: {},
}));

jest.mock('../../views/autodetect-panel', () => ({
    AutodetectPanel: {
        show: jest.fn().mockResolvedValue({ wheel_diameter: 56, axle_track: 104 }),
    },
}));

jest.mock('../../communication/clients/pybricks-ble-client', () => {
    const DeviceOSType = { Pybricks: 'pybricks' };
    const StartMode = { REPL: 'repl' };

    class MockPybricksBleClient {
        public connected = true;
        public classDescriptor = { os: DeviceOSType.Pybricks };
        public hubType: unknown;
        private onStdoutCb: ((data: string) => void) | undefined;

        constructor(
            hubType: unknown,
            private detectOutput: string,
        ) {
            this.hubType = hubType;
        }

        onStdout(cb: (data: string) => void) {
            this.onStdoutCb = cb;
            return { dispose: jest.fn() };
        }

        action_start(mode?: number | string) {
            if (mode === StartMode.REPL) {
                this.onStdoutCb?.(`AUTODETECT ${this.detectOutput}`);
            }
        }

        async action_stop() {}
    }

    return { PybricksBleClient: MockPybricksBleClient };
});

import { PybricksBleClient } from '../../communication/clients/pybricks-ble-client';
import { ConnectionManager } from '../../communication/connection-manager';

const MockPybricksBleClientCtor =
    PybricksBleClient as unknown as new (...args: unknown[]) => unknown;

describe('autodetectPybricksHub', () => {
    afterEach(() => {
        (ConnectionManager as { client?: unknown }).client = undefined;
    });

    it('identifies a Prime hub and parses detected device signatures', async () => {
        const primeHub = HubTypeDescriptors.find((h) => h.hubType === 'PrimeHub');
        if (!primeHub) throw new Error('Prime hub descriptor missing in test setup');

        (ConnectionManager as { client?: unknown }).client = new MockPybricksBleClientCtor(
            primeHub,
            "[['A', 49], ['B', 63], ['C', 0]]",
        );

        const updateCodeCb = jest.fn().mockResolvedValue('');
        const result = await autodetectPybricksHub(updateCodeCb);

        expect(result.hubType?.hubType).toBe('PrimeHub');
        expect(result.devices.motor_a).toEqual(
            expect.objectContaining({
                port: 'A',
                variable: 'motor_a',
                init: 'Motor(Port.A)',
                portType: 49,
                isMotor: true,
            }),
        );
        expect(result.devices.force_b).toEqual(
            expect.objectContaining({
                port: 'B',
                variable: 'force_b',
                init: 'ForceSensor(Port.B)',
                portType: 63,
            }),
        );
    });

    it('identifies an Essential hub and parses its force sensor signature', async () => {
        const essentialHub = HubTypeDescriptors.find(
            (h) => h.hubType === 'EssentialHub',
        );
        if (!essentialHub)
            throw new Error('Essential hub descriptor missing in test setup');

        (ConnectionManager as { client?: unknown }).client = new MockPybricksBleClientCtor(
            essentialHub,
            "[['A', 63]]",
        );

        const result = await autodetectPybricksHub(jest.fn().mockResolvedValue(''));

        expect(result.hubType?.hubType).toBe('EssentialHub');
        expect(result.devices.force_a).toEqual(
            expect.objectContaining({
                port: 'A',
                variable: 'force_a',
                init: 'ForceSensor(Port.A)',
                portType: 63,
            }),
        );
    });

    it('returns undefined hub for non-pybricks/unsupported client states', async () => {
        (ConnectionManager as { client?: unknown }).client = {
            connected: true,
            classDescriptor: { os: 'hubos' },
        };

        const result = await autodetectPybricksHub(jest.fn().mockResolvedValue(''));

        expect(result.hubType).toBeUndefined();
        expect(result.devices).toEqual({});
    });
});
