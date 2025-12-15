const vscode = acquireVsCodeApi();

interface SlotData {
    index: number;
    hasCode: boolean;
}

interface HubSlotsMessage {
    command: 'initialize' | 'update';
    slots: SlotData[];
}

let currentSlots: SlotData[] = [];
let moveSource: number | null = null;

window.addEventListener('DOMContentLoaded', () => {
    const refreshBtn = document.getElementById('refresh-btn');
    refreshBtn?.addEventListener('click', () => {
        vscode.postMessage({ command: 'refresh' });
    });
});

window.addEventListener('message', (event) => {
    const message = event.data as HubSlotsMessage;
    switch (message.command) {
        case 'update':
            currentSlots = message.slots;
            renderSlots();
            break;
    }
});

function renderSlots() {
    const container = document.getElementById('slot-list');
    if (!container) return;

    container.innerHTML = '';

    currentSlots.forEach((slot) => {
        const div = document.createElement('div');
        div.className = `slot-item ${slot.hasCode ? 'occupied' : 'empty'}`;
        if (moveSource !== null) {
            div.classList.add('target-candidate');
            if (slot.index === moveSource) {
                div.classList.add('source-slot');
                div.style.borderColor = 'var(--vscode-button-background)';
            }
        }

        const infoDiv = document.createElement('div');
        infoDiv.className = 'slot-info';
        infoDiv.innerHTML = `<span class="codicon codicon-file-code"></span> <span>Slot ${slot.index}</span>`;
        if (!slot.hasCode) {
            infoDiv.innerHTML = `<span>Slot ${slot.index}</span>`;
        }

        const actionsDiv = document.createElement('div');
        actionsDiv.className = 'slot-actions';

        if (moveSource === null) {
            if (slot.hasCode) {
                const runBtn = document.createElement('button');
                runBtn.title = 'Run Program';
                runBtn.innerHTML = '<span class="codicon codicon-run"></span> Run';
                runBtn.onclick = (e) => {
                    e.stopPropagation();
                    vscode.postMessage({
                        command: 'run',
                        slot: slot.index,
                    });
                };

                const moveBtn = document.createElement('button');
                moveBtn.title = 'Move Program';
                moveBtn.innerHTML =
                    '<span class="codicon codicon-arrow-right"></span> Move';
                moveBtn.onclick = (e) => {
                    e.stopPropagation();
                    enterMoveMode(slot.index);
                };

                const deleteBtn = document.createElement('button');
                deleteBtn.title = 'Delete Program';
                deleteBtn.innerHTML =
                    '<span class="codicon codicon-trash"></span> Delete';
                deleteBtn.onclick = (e) => {
                    e.stopPropagation();
                    handleDelete(slot.index);
                };

                actionsDiv.appendChild(moveBtn);
                actionsDiv.appendChild(deleteBtn);
            }
        } else {
            // In move mode
            if (slot.index === moveSource) {
                const cancelBtn = document.createElement('button');
                cancelBtn.innerHTML = 'Cancel';
                cancelBtn.onclick = (e) => {
                    e.stopPropagation();
                    exitMoveMode();
                };
                actionsDiv.appendChild(cancelBtn);
            } else {
                // Target
                const selectBtn = document.createElement('button');
                selectBtn.className = 'btn-primary';
                selectBtn.innerHTML = 'Select';
                selectBtn.onclick = (e) => {
                    e.stopPropagation();
                    handleMove(moveSource!, slot.index);
                };
                // Allow clicking the whole row
                div.onclick = () => handleMove(moveSource!, slot.index);
                div.style.cursor = 'pointer';

                actionsDiv.appendChild(selectBtn);
            }
        }

        div.appendChild(infoDiv);
        div.appendChild(actionsDiv);
        container.appendChild(div);
    });

    updateHeader();
}

function updateHeader() {
    const subtitle = document.querySelector('.subtitle');
    if (subtitle) {
        if (moveSource !== null) {
            subtitle.textContent = `Select a destination slot for the program from Slot ${moveSource}.`;
            (subtitle as HTMLElement).style.color = 'var(--vscode-textLink-foreground)';
        } else {
            subtitle.textContent =
                'Manage program slots on your hub. Use move to copy code between slots.';
            (subtitle as HTMLElement).style.color =
                'var(--vscode-descriptionForeground)';
        }
    }

    const refreshBtn = document.getElementById('refresh-btn') as HTMLButtonElement;
    if (refreshBtn) {
        refreshBtn.disabled = moveSource !== null;
    }
}

function handleDelete(index: number) {
    vscode.postMessage({
        command: 'delete',
        slot: index,
    });
}

function handleMove(fromIndex: number, toIndex: number) {
    vscode.postMessage({
        command: 'move',
        from: fromIndex,
        to: toIndex,
    });
    exitMoveMode();
}

function enterMoveMode(fromIndex: number) {
    moveSource = fromIndex;
    document.body.classList.add('move-mode');
    renderSlots();
}

function exitMoveMode() {
    moveSource = null;
    document.body.classList.remove('move-mode');
    renderSlots();
}
