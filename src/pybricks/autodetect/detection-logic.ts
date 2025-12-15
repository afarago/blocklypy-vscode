import { DeviceOSType, StartMode } from '../../communication/clients/base-client';
import { PybricksBleClient } from '../../communication/clients/pybricks-ble-client';
import { ConnectionManager } from '../../communication/connection-manager';
import { extensionContext } from '../../extension';
import { loadPythonAssetModule } from '../../logic/compile';
import { StateProp, waitForStateWithTimeout } from '../../logic/state';
import { AutodetectPanel } from '../../views/autodetect-panel';
import { DEVICE_NAMES, HubTypeDescriptorType, MOTOR_SIZES } from './const';
import { ROBOT_VAR } from './template-creation';

const AUTODETECT_PREFIX = 'AUTODETECT';
const AUTODETECT_TIMEOUT_MS = 10 * 1000;
const AUTODETECT_SCRIPT_NAME = 'hub-autodetect.py';
// const AUTODETECT_MOVE_SCRIPT_NAME = 'hub-autodetect-move.py';
const AUTODETECT_DEFAULT_WHEEL_DIAMETER = 56; // mm
const AUTODETECT_DEFAULT_AXLE_TRACK = 104; // mm

export type DeviceObjectType = {
    port?: string;
    variable?: string;
    init?: string;
    description?: string;
    portType?: number;
    isMotor?: boolean;
};

export async function autodetectPybricksHub(
    updateCodeCb: (
        hubType: HubTypeDescriptorType | undefined,
        devices: Record<string, DeviceObjectType>,
        inProgress: boolean,
    ) => Promise<string>,
): Promise<{
    hubType: HubTypeDescriptorType | undefined;
    devices: Record<string, DeviceObjectType>;
}> {
    const devices: Record<string, DeviceObjectType> = {};

    const client0 = ConnectionManager.client;
    if (
        !client0 ||
        !client0.connected ||
        client0.classDescriptor.os !== DeviceOSType.Pybricks ||
        !(client0 instanceof PybricksBleClient)
    ) {
        return { hubType: undefined, devices };
    }
    const client: PybricksBleClient = client0;

    let hubType: HubTypeDescriptorType | undefined = undefined;
    // let portTypes: Record<string, number | string> = {};

    // Try to autodetect the hub type
    hubType = client.hubType;
    await updateCodeCb(hubType, devices, true);

    try {
        if (!hubType?.capabilities.repl) throw new Error('Autodetection not supported');

        const { content } = await loadPythonAssetModule(AUTODETECT_SCRIPT_NAME);
        if (content) {
            // Start listening for output before sending the code
            const outputPromise = client.readReplOutputLine(
                AUTODETECT_PREFIX,
                AUTODETECT_TIMEOUT_MS,
            );
            await client.action_start(StartMode.REPL, content);

            // Wait for the detection result (max 10 seconds)
            const output = await outputPromise;
            await client.action_stop(); // stop the REPL

            if (output) {
                try {
                    // Parse the detection result
                    const detectionResult = JSON.parse(
                        output.replace(/'/g, '"'),
                    ) as Array<[string, number]>;
                    console.debug('Device detection result:', output);

                    // returns an array of [port, puptype:number] or later [port, deviceclass:str]
                    for (const [port, puptype] of detectionResult) {
                        // code += `\nport_${port} = PUPDevice(Port.${port})`
                        const pcl = port.toLowerCase();
                        let deviceName =
                            typeof puptype === 'number'
                                ? DEVICE_NAMES[puptype] || `Unknown device ${puptype}`
                                : puptype;

                        const addDevice = (
                            varName: string,
                            init: string,
                            portType: number,
                        ): DeviceObjectType => {
                            return (devices[varName] = {
                                port,
                                variable: varName,
                                init: init,
                                description: deviceName,
                                portType,
                            } satisfies DeviceObjectType);
                        };
                        switch (puptype) {
                            case 0:
                                continue;
                                break; // Empty port
                            case 63:
                                // case 'ForceSensor':
                                addDevice(
                                    `force_${pcl}`,
                                    `ForceSensor(Port.${port})`,
                                    puptype,
                                );
                                break;
                            case 62:
                                // case 'UltrasonicSensor':
                                addDevice(
                                    `usensor_${pcl}`,
                                    `UltrasonicSensor(Port.${port})`,
                                    puptype,
                                );
                                break;
                            case 61:
                                // case 'ColorSensor':
                                addDevice(
                                    `color_${pcl}`,
                                    `ColorSensor(Port.${port})`,
                                    puptype,
                                );
                                break;
                            case 37:
                                // case 'ColorDistanceSensor':
                                addDevice(
                                    `colordistance_${pcl}`,
                                    `ColorDistanceSensor(Port.${port})`,
                                    puptype,
                                );
                                break;
                            default:
                                if (isMotor(puptype)) {
                                    const device = addDevice(
                                        `motor_${pcl}`,
                                        `Motor(Port.${port})`,
                                        puptype,
                                    );
                                    device.isMotor = true;
                                } else {
                                    addDevice(
                                        `device_${pcl}`,
                                        `PUPDevice(Port.${port})`,
                                        puptype,
                                    );
                                }
                                break;
                        }
                    }
                } catch {
                    console.error('Failed to parse detection result:', output);
                }
            }

            // need for REPL to finish as we want to add a quick pick to select the hub type
            // quick pick will be cancelled on state change / tree refresh
            await waitForStateWithTimeout(
                StateProp.Running,
                false,
                AUTODETECT_TIMEOUT_MS,
            );
        }
    } catch (error) {
        // Silently fail - device detection is optional
        console.error('Device auto-detection failed:', error);
    }

    return { hubType, devices };
}

export async function detectMotorPair(
    devices: Record<string, DeviceObjectType>,
    hubType: HubTypeDescriptorType,
): Promise<void> {
    // Add port types to template ordered by port alphabetically
    const motor_objects = Object.values(devices).filter((d) => d.isMotor);

    // Add DriveBase if two motors are detected
    let motorpair: [DeviceObjectType, DeviceObjectType] | undefined = undefined;
    if (motor_objects.length < 2) return;

    // const isDeviceByNumericIds = Object.entries(portTypes).every(
    //     ([_, id]) => typeof id === 'number',
    // );

    // Try to find a suitable motor pair - only for numeric IDs, when we can use MOTOR_SIZES
    // if (isDeviceByNumericIds) {
    // Helper to sort pairs by descending motor size
    const sortBySizeDesc = (a: { size: number }, b: { size: number }) =>
        (b.size ?? 0) - (a.size ?? 0);

    // 1) Find any matching motors with identical puptype, prefer larger motors first
    const sameTypePairs = [] as Array<{
        devs: [DeviceObjectType, DeviceObjectType];
        size: number;
    }>;
    for (let i = 0; i < motor_objects.length; i++) {
        const m1 = motor_objects[i];
        const pt1 = m1.portType;
        for (let j = i + 1; j < motor_objects.length; j++) {
            const m2 = motor_objects[j];
            const pt2 = m2.portType;
            if (pt1 === pt2) {
                const size = MOTOR_SIZES[pt1 ?? 0] ?? 0;
                sameTypePairs.push({ devs: [m1, m2], size });
            }
        }
    }
    sameTypePairs.sort(sortBySizeDesc);

    motorpair = sameTypePairs[0]?.devs;

    // 2) If none, find pairs with the same motor size (via MOTOR_SIZES), prefer larger size
    if (!motorpair) {
        const sameSizePairs = [] as Array<{
            devices: [DeviceObjectType, DeviceObjectType];
            size: number;
        }>;
        for (let i = 0; i < motor_objects.length; i++) {
            const m1 = motor_objects[i];
            const size1 = MOTOR_SIZES[m1.portType ?? 0];
            if (size1 === undefined) continue;
            for (let j = i + 1; j < motor_objects.length; j++) {
                const m2 = motor_objects[j];
                const size2 = MOTOR_SIZES[m2.portType ?? 0];
                if (size2 === undefined) continue;
                if (size1 === size2) {
                    sameSizePairs.push({ devices: [m1, m2], size: size1 });
                }
            }
        }
        sameSizePairs.sort(sortBySizeDesc);
        if (sameSizePairs.length) {
            motorpair = sameSizePairs[0].devices;
        }
    }

    // 3) Fallback: match first two motors
    if (!motorpair) {
        motorpair = [motor_objects[0], motor_objects[1]];
    }

    if (motorpair) {
        // Set direction of first motor to counter-clockwise
        motorpair[0].init = motorpair[0].init?.replace(
            /\)$/,
            ', positive_direction=Direction.COUNTERCLOCKWISE)',
        );
    }

    // Add code for Devices and DriveBase
    let motorpairCode: DeviceObjectType | undefined = undefined;
    if (motorpair) {
        const { wheel_diameter, axle_track } = await promptRobotSizing(
            motorpair,
            Object.values(devices),
            hubType,
        );

        motorpairCode = {
            variable: ROBOT_VAR,
            init: `DriveBase(${motorpair[0].variable}, ${motorpair[1].variable}, wheel_diameter=${wheel_diameter}, axle_track=${axle_track})`,
            description: 'DriveBase based on detected motors',
        } satisfies DeviceObjectType;
        devices[ROBOT_VAR] = motorpairCode;
    }
}

export async function promptRobotSizing(
    motorpair: [DeviceObjectType, DeviceObjectType],
    devices: DeviceObjectType[],
    hubType: HubTypeDescriptorType,
): Promise<{ wheel_diameter: number; axle_track: number }> {
    // Use the new webview panel for a floating UI experience
    const result = await AutodetectPanel.show(extensionContext, {
        hubType: hubType.label,
        wheelDiameter: AUTODETECT_DEFAULT_WHEEL_DIAMETER,
        axleTrack: AUTODETECT_DEFAULT_AXLE_TRACK,
        wheelPorts: motorpair.map((m) => m.port).join(''),
        devices,
    });

    // If user cancelled, return defaults
    if (!result) {
        return {
            wheel_diameter: AUTODETECT_DEFAULT_WHEEL_DIAMETER,
            axle_track: AUTODETECT_DEFAULT_AXLE_TRACK,
        };
    }

    return result;
}

function isMotor(puptype: number | string): boolean {
    if (typeof puptype === 'number') {
        return MOTOR_SIZES[puptype] !== undefined;
    } else {
        return puptype === 'Motor';
    }
}
