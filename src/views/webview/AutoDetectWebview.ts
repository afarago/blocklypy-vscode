/**
 * Webview script for Robot Sizing UI
 * This runs in the webview context
 */

interface RobotSizingMessage {
    command: 'initialize';
    hubType: string;
    wheelDiameter: number;
    axleTrack: number;
    wheelPorts: string;
    devices?: Array<{ port: string; description: string }>;
}

import { sanitizeHtml } from './webviewUtils';

interface RobotSizingResponse {
    command: 'submit' | 'cancel';
    wheelDiameter?: number;
    axleTrack?: number;
}

declare function acquireVsCodeApi(): {
    postMessage: (message: unknown) => void;
};

const vscode = acquireVsCodeApi();

let wheelDiameterInput: HTMLInputElement;
let axleTrackInput: HTMLInputElement;
let wheelDiameterDisplay: HTMLElement;
let axleTrackDisplay: HTMLElement;
let submitButton: HTMLButtonElement;
let cancelButton: HTMLButtonElement;

window.addEventListener('DOMContentLoaded', () => {
    wheelDiameterInput = document.getElementById('wheel-diameter') as HTMLInputElement;
    axleTrackInput = document.getElementById('axle-track') as HTMLInputElement;
    wheelDiameterDisplay = document.getElementById('wheel-diameter-display')!;
    axleTrackDisplay = document.getElementById('axle-track-display')!;
    submitButton = document.getElementById('submit-btn') as HTMLButtonElement;
    cancelButton = document.getElementById('cancel-btn') as HTMLButtonElement;

    // Set up event listeners
    wheelDiameterInput.addEventListener('input', () => updateDisplay('wheel'));
    axleTrackInput.addEventListener('input', () => updateDisplay('axle'));

    submitButton.addEventListener('click', handleSubmit);
    cancelButton.addEventListener('click', handleCancel);

    // Handle keyboard shortcuts
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSubmit();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            handleCancel();
        }
    });
});

window.addEventListener('message', (event: MessageEvent) => {
    const data = event.data as RobotSizingMessage;
    if (data.command === 'initialize') {
        wheelDiameterInput.value = data.wheelDiameter.toString() + ' mm';
        axleTrackInput.value = data.axleTrack.toString() + ' mm';
        updateDisplay('wheel');
        updateDisplay('axle');

        // Update Hub Type
        const hubTypeElement = document.getElementById('hub-type');
        if (hubTypeElement) {
            hubTypeElement.textContent = sanitizeHtml(data.hubType);
        }

        // Update Devices
        const devicesElement = document.getElementById('devices-tbody');
        if (devicesElement && data.devices) {
            const tableRows = data.devices
                .map(
                    (device) =>
                        `<tr>
                            <td>Port.${sanitizeHtml(device.port)}</td>
                            <td>${sanitizeHtml(device.description)}${
                            data.wheelPorts?.includes(device.port)
                                ? ' <strong>(robot wheel)</strong>'
                                : ''
                        }</td>
                        </tr>`,
                )
                .join('');
            devicesElement.innerHTML = tableRows;
        }

        // Focus the first input
        wheelDiameterInput.focus();
        wheelDiameterInput.select();
    }
});

function parseSizeInput(value: string): { value: number; unit: string } | null {
    const match = value.match(/^(\d+(?:\.\d+)?)(?:\s*(cm|mm|s|stud))?$/i);
    if (!match) {
        return null;
    }

    const unit = match[2]?.toLowerCase() || 'mm';
    const uom = unit === 'cm' ? 10 : unit === 's' || unit === 'stud' ? 8 : 1;
    const size_mm = Number(match[1]) * uom;

    return { value: size_mm, unit };
}

function updateDisplay(type: 'wheel' | 'axle') {
    const input = type === 'wheel' ? wheelDiameterInput : axleTrackInput;
    const display = type === 'wheel' ? wheelDiameterDisplay : axleTrackDisplay;

    const parsed = parseSizeInput(input.value);

    if (parsed) {
        const label = type === 'wheel' ? 'Wheel Diameter' : 'Axle Track';
        const studs = (parsed.value / 8).toFixed(1);
        display.innerHTML = `<span class="codicon codicon-info"></span>${label} will be set to ${parsed.value} mm / ${studs} studs`;
        display.className = 'validation-message valid';
        input.classList.remove('invalid');
        submitButton.disabled = false;
    } else if (input.value.trim()) {
        display.innerHTML = `<span class="codicon codicon-warning"></span>Invalid input`;
        display.className = 'validation-message invalid';
        input.classList.add('invalid');
        submitButton.disabled = true;
    } else {
        display.innerHTML = '';
        display.className = 'validation-message';
        input.classList.remove('invalid');
        submitButton.disabled = true;
    }
}

function handleSubmit() {
    const wheelParsed = parseSizeInput(wheelDiameterInput.value);
    const axleParsed = parseSizeInput(axleTrackInput.value);

    if (wheelParsed && axleParsed) {
        const response: RobotSizingResponse = {
            command: 'submit',
            wheelDiameter: wheelParsed.value,
            axleTrack: axleParsed.value,
        };
        vscode.postMessage(response);
    }
}

function handleCancel() {
    const response: RobotSizingResponse = {
        command: 'cancel',
    };
    vscode.postMessage(response);
}
