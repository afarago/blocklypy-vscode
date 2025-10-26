export const CONNECTION_TIMEOUT_DEFAULT = 15000;
export const RSSI_REFRESH_WHILE_CONNECTED_INTERVAL = 5000;
export const DEVICE_VISIBILITY_WAIT_TIMEOUT = 15000;

export enum ConnectionState {
    Initializing = 'initializing',
    Disconnected = 'disconnected',
    Connecting = 'connecting',
    Connected = 'connected',
    Disconnecting = 'disconnecting',
}
