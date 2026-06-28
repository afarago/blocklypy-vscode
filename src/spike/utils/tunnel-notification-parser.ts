import { TunnelNotificationMessage } from '../messages/tunnel-notification-message';
import { TunnelRequestMessage } from '../messages/tunnel-request-message';
import { DataViewExtended } from './dataview-extended';

const TunnelMessageLittleEndian = false; // big-endian

// TunnelMessageId enum
export enum TunnelMessageType {
    MusicPlayDrumForBeats = 1,
    MusicPlayNoteForBeats = 2,
    MusicTempoUpdate = 3,
    MusicStopAllNotes = 4,
    MusicStopAllDrums = 5,
    SoundPlay = 22,
    SoundPlayUntilDone = 23,
    SoundDone = 24,
    SoundStopAll = 25,
    SoundSetAttributes = 26,
    SoundStop = 27,
    WeatherAtOffsetRequest = 31,
    WeatherForecast = 33,
    DisplayImage = 41,
    DisplayImageForTime = 42,
    DisplayNextImage = 43,
    DisplayText = 44,
    DisplayTextForTime = 45,
    DisplayShow = 46,
    DisplayHide = 47,
    GraphShow = 50,
    GraphHide = 51,
    GraphClear = 52,
    GraphValue = 53,
    LineGraphClearColor = 54,
    LineGraphPlot = 55,
    LineGraphRequestValue = 56,
    BarGraphSetValue = 57,
    BarGraphChange = 58,
    BarGraphRequestValue = 59,
    Assertion = 91,
    ProgramAttributes = 92,
    LatestTunnelValueRequest = 93,
    LatestTunnelValueResponse = 94,
    VariableUpdate = 96,
    ListAddItem = 97,
    ListRemoveItem = 98,
    ListInsertItem = 99,
    ListReplaceItem = 100,
    ListClear = 101,
    Unknown = -1,
}

export enum TunnelWeatherForecastCondition {
    Cloudy = 0,
    Foggy = 1,
    PartlyCloudy = 2,
    Raining = 3,
    Snowing = 4,
    Sunny = 5,
}

export type TunnelPayload =
    | {
          readonly type: TunnelMessageType.MusicPlayDrumForBeats;
          readonly drum: number;
      }
    | {
          readonly type: TunnelMessageType.MusicPlayNoteForBeats;
          readonly instrument: number;
          readonly note: number;
          readonly duration: number;
      }
    | {
          readonly type: TunnelMessageType.MusicTempoUpdate;
          readonly tempo: number;
      }
    | { readonly type: TunnelMessageType.MusicStopAllNotes }
    | { readonly type: TunnelMessageType.MusicStopAllDrums }
    | {
          readonly type: TunnelMessageType.SoundPlay;
          readonly crc: number;
          readonly volume: number;
          readonly pitch: number;
          readonly pan: number;
      }
    | {
          readonly type: TunnelMessageType.SoundPlayUntilDone;
          readonly correlationId: number;
          readonly crc: number;
          readonly volume: number;
          readonly pitch: number;
          readonly pan: number;
          //-- HubOS to Master: SoundDone
      }
    | {
          //-- Master to HubOS: SoundPlayUntilDone
          readonly type: TunnelMessageType.SoundDone;
          readonly correlationId: number;
      }
    | { readonly type: TunnelMessageType.SoundStopAll }
    | {
          readonly type: TunnelMessageType.SoundSetAttributes;
          readonly volume: number;
          readonly pitch: number;
          readonly pan: number;
      }
    | {
          // ???? // TODO: Confirm
          readonly type: TunnelMessageType.SoundStop;
          readonly correlationId: number;
      }
    | {
          //-- HubOS to Master: WeatherForecast
          readonly type: TunnelMessageType.WeatherAtOffsetRequest;
          readonly correlationId: number;
          readonly days: number;
          readonly hours: number;
          readonly location: string;
      }
    | {
          //-- Master to HubOS: WeatherAtOffsetRequest
          readonly type: TunnelMessageType.WeatherForecast;
          readonly correlationId: number;
          readonly temperature: number;
          readonly precipitation: number;
          readonly condition: TunnelWeatherForecastCondition;
          readonly windDirection: string;
          readonly windSpeed: number;
          readonly pressure: number;
          readonly offset: number;
          readonly location: string;
      }
    | {
          readonly type: TunnelMessageType.DisplayImage;
          readonly image: number;
      }
    | {
          readonly type: TunnelMessageType.DisplayImageForTime;
          readonly image: number;
      }
    | { readonly type: TunnelMessageType.DisplayNextImage }
    | {
          readonly type: TunnelMessageType.DisplayText;
          readonly text: string;
      }
    | {
          readonly type: TunnelMessageType.DisplayTextForTime;
          readonly text: string;
      }
    | {
          readonly type: TunnelMessageType.DisplayShow;
          readonly fullscreen: boolean;
      }
    | { readonly type: TunnelMessageType.DisplayHide }
    | {
          readonly type: TunnelMessageType.GraphShow;
          readonly graphType: number;
          readonly fullscreen: boolean;
      }
    | {
          readonly type: TunnelMessageType.GraphHide;
          readonly graphType: number;
      }
    | {
          readonly type: TunnelMessageType.GraphClear;
          readonly graphType: number;
      }
    | {
          //-- Master to HubOS: LineGraphRequestValue, BarGraphRequestValue
          readonly type: TunnelMessageType.GraphValue;
          readonly correlationId: number;
          readonly value: number;
      }
    | {
          readonly type: TunnelMessageType.LineGraphClearColor;
          readonly color: number;
      }
    | {
          readonly type: TunnelMessageType.LineGraphPlot;
          readonly color: number;
          readonly x: number;
          readonly y: number;
      }
    | {
          //-- HubOS to Master: GraphValue
          readonly type: TunnelMessageType.LineGraphRequestValue;
          readonly correlationId: number;
          readonly color: number;
          readonly option: number; // tbc: (min/max/avg/last) 0=current, 1=min, 2=max, 3=average
      }
    | {
          readonly type: TunnelMessageType.BarGraphSetValue;
          readonly color: number;
          readonly value: number;
      }
    | {
          readonly type: TunnelMessageType.BarGraphChange;
          readonly color: number;
          readonly delta: number;
      }
    | {
          //-- HubOS to Master: GraphValue
          readonly type: TunnelMessageType.BarGraphRequestValue;
          readonly correlationId: number;
          readonly color: number;
      }
    | {
          readonly type: TunnelMessageType.Assertion;
          readonly success: boolean;
          readonly message: string;
      }
    | {
          readonly type: TunnelMessageType.ProgramAttributes;
          readonly project: string;
      }
    | {
          readonly type: TunnelMessageType.LatestTunnelValueRequest;
          readonly correlationId: number;
          readonly type2: number;
          readonly field: string;
      }
    | {
          readonly type: TunnelMessageType.LatestTunnelValueResponse;
          readonly correlationId: number;
          readonly success: boolean;
          readonly age: number;
          readonly value: string;
      }
    | {
          readonly type: TunnelMessageType.VariableUpdate;
          readonly name: string;
          readonly value: string;
      }
    | {
          readonly type: TunnelMessageType.ListAddItem;
          readonly name: string;
          readonly item: string;
      }
    | {
          readonly type: TunnelMessageType.ListRemoveItem;
          readonly name: string;
          readonly index: number;
      }
    | {
          readonly type: TunnelMessageType.ListInsertItem;
          readonly name: string;
          readonly item: string;
          readonly index: number;
      }
    | {
          readonly type: TunnelMessageType.ListReplaceItem;
          readonly name: string;
          readonly item: string;
          readonly index: number;
      }
    | { readonly type: TunnelMessageType.ListClear; readonly name: string }
    | { readonly type: TunnelMessageType.Unknown; readonly type2: number };

type TunnelPayloadFieldDef =
    | [string, 'fixed', number, boolean, number?] // name, type, size, signed, scale
    | [string, 'float', number] // name, type, size
    | [string, 'string', 'utf8'] // name, type, encoding
    | [string, 'bool', number]; // name, type, size

const TunnelPayloadDefinitions: {
    [key in TunnelMessageType]?: TunnelPayloadFieldDef[];
} = {
    [TunnelMessageType.MusicPlayDrumForBeats]: [['drum', 'fixed', 1, false, 1]],
    [TunnelMessageType.MusicPlayNoteForBeats]: [
        ['instrument', 'fixed', 1, false, 1],
        ['note', 'fixed', 1, false, 1],
        ['duration', 'fixed', 4, false, 1],
    ],
    [TunnelMessageType.MusicTempoUpdate]: [['tempo', 'fixed', 2, false, 1]],
    [TunnelMessageType.MusicStopAllNotes]: [],
    [TunnelMessageType.MusicStopAllDrums]: [],
    [TunnelMessageType.SoundPlay]: [
        ['crc', 'fixed', 4, false, 1],
        ['volume', 'fixed', 1, false, 1],
        ['pitch', 'fixed', 2, true, 1],
        ['pan', 'fixed', 1, true, 1],
    ],
    [TunnelMessageType.SoundPlayUntilDone]: [
        ['correlationId', 'fixed', 1, false, 1],
        ['crc', 'fixed', 4, false, 1],
        ['volume', 'fixed', 1, false, 1],
        ['pitch', 'fixed', 2, true, 1],
        ['pan', 'fixed', 1, true, 1],
    ],
    [TunnelMessageType.SoundDone]: [['correlationId', 'fixed', 1, false, 1]],
    [TunnelMessageType.SoundStopAll]: [],
    [TunnelMessageType.SoundSetAttributes]: [
        ['volume', 'fixed', 1, false, 1],
        ['pitch', 'fixed', 2, true, 1],
        ['pan', 'fixed', 1, true, 1],
    ],
    [TunnelMessageType.SoundStop]: [['correlationId', 'fixed', 1, false, 1]],
    [TunnelMessageType.WeatherAtOffsetRequest]: [
        ['correlationId', 'fixed', 1, false, 1],
        ['days', 'fixed', 1, false, 1],
        ['hours', 'fixed', 1, false, 1],
        ['location', 'string', 'utf8'],
    ],
    [TunnelMessageType.WeatherForecast]: [
        ['correlationId', 'fixed', 1, false, 1],
        ['temperature', 'fixed', 2, true, 10],
        ['precipitation', 'fixed', 2, false, 10],
        ['condition', 'fixed', 1, false, 1],
        ['windDirection', 'string', 'utf8'],
        ['windSpeed', 'fixed', 2, false, 10],
        ['pressure', 'fixed', 2, false, 10],
        ['offset', 'fixed', 1, false, 1],
        ['location', 'string', 'utf8'],
    ],
    [TunnelMessageType.DisplayImage]: [['image', 'fixed', 1, false, 1]],
    [TunnelMessageType.DisplayImageForTime]: [['image', 'fixed', 1, false, 1]],
    [TunnelMessageType.DisplayNextImage]: [],
    [TunnelMessageType.DisplayText]: [['text', 'string', 'utf8']],
    [TunnelMessageType.DisplayTextForTime]: [['text', 'string', 'utf8']],
    [TunnelMessageType.DisplayShow]: [['fullscreen', 'bool', 1]],
    [TunnelMessageType.DisplayHide]: [],
    [TunnelMessageType.GraphShow]: [
        ['graphType', 'fixed', 1, false, 1],
        ['fullscreen', 'bool', 1],
    ],
    [TunnelMessageType.GraphHide]: [['graphType', 'fixed', 1, false, 1]],
    [TunnelMessageType.GraphClear]: [['graphType', 'fixed', 1, false, 1]],
    [TunnelMessageType.GraphValue]: [
        ['correlationId', 'fixed', 1, false, 1],
        ['value', 'float', 4],
    ],
    [TunnelMessageType.LineGraphClearColor]: [['color', 'fixed', 1, false, 1]],
    [TunnelMessageType.LineGraphPlot]: [
        ['color', 'fixed', 1, false, 1],
        ['x', 'float', 4],
        ['y', 'float', 4],
    ],
    [TunnelMessageType.LineGraphRequestValue]: [
        ['correlationId', 'fixed', 1, false, 1],
        ['color', 'fixed', 1, false, 1],
        ['option', 'fixed', 1, false, 1],
    ],
    [TunnelMessageType.BarGraphSetValue]: [
        ['color', 'fixed', 1, false, 1],
        ['value', 'float', 4],
    ],
    [TunnelMessageType.BarGraphChange]: [
        ['color', 'fixed', 1, false, 1],
        ['delta', 'float', 4],
    ],
    [TunnelMessageType.BarGraphRequestValue]: [
        ['correlationId', 'fixed', 1, false, 1],
        ['color', 'fixed', 1, false, 1],
    ],
    [TunnelMessageType.Assertion]: [
        ['success', 'bool', 1],
        ['message', 'string', 'utf8'],
    ],
    [TunnelMessageType.ProgramAttributes]: [['project', 'string', 'utf8']],
    [TunnelMessageType.LatestTunnelValueRequest]: [
        ['correlationId', 'fixed', 1, false, 1],
        ['type2', 'fixed', 1, false, 1],
        ['field', 'string', 'utf8'],
    ],
    [TunnelMessageType.LatestTunnelValueResponse]: [
        ['correlationId', 'fixed', 1, false, 1],
        ['success', 'bool', 1],
        ['age', 'fixed', 2, false, 1],
        ['value', 'string', 'utf8'],
    ],
    [TunnelMessageType.VariableUpdate]: [
        ['name', 'string', 'utf8'],
        ['value', 'string', 'utf8'],
    ],
    [TunnelMessageType.ListAddItem]: [
        ['name', 'string', 'utf8'],
        ['item', 'string', 'utf8'],
    ],
    [TunnelMessageType.ListRemoveItem]: [
        ['name', 'string', 'utf8'],
        ['index', 'fixed', 1, false, 1],
    ],
    [TunnelMessageType.ListInsertItem]: [
        ['name', 'string', 'utf8'],
        ['item', 'string', 'utf8'],
        ['index', 'fixed', 1, false, 1],
    ],
    [TunnelMessageType.ListReplaceItem]: [
        ['name', 'string', 'utf8'],
        ['item', 'string', 'utf8'],
        ['index', 'fixed', 1, false, 1],
    ],
    [TunnelMessageType.ListClear]: [['name', 'string', 'utf8']],
};

export function decodeTunnelMessage(data: Uint8Array): TunnelPayload[] {
    const view = new DataViewExtended(data, 0, TunnelMessageLittleEndian);

    const id = view.readUInt8();
    if (id !== TunnelNotificationMessage.Id) {
        throw new Error(
            `Invalid TunnelMessage id ${id}, expected ${TunnelNotificationMessage.Id}`,
        );
    }

    const length = view.readUInt16();
    const payloadEnd = Math.min(data.length, 3 + length);
    const retval: TunnelPayload[] = [];
    while (view.offset < payloadEnd) {
        const elem = decodeTunnelMessageElem(view);
        retval.push(elem);
    }
    return retval;
}

export function decodeTunnelMessageElem(view: DataViewExtended): TunnelPayload {
    const head1 = view.readUInt8();
    const type: TunnelMessageType = head1 as TunnelMessageType;
    const def = TunnelPayloadDefinitions[type];

    if (!def) {
        // Unknown or unhandled message type
        return { type: TunnelMessageType.Unknown, type2: type };
    }

    const payload: { [key: string]: unknown } = { type };

    for (const fieldDef of def) {
        const [fieldName, fieldType, ...rest] = fieldDef;
        switch (fieldType) {
            case 'fixed': {
                const [size, signed, scale] = rest;
                let value;
                if (size === 1) {
                    value = signed ? view.readInt8() : view.readUInt8();
                } else if (size === 2) {
                    value = signed ? view.readInt16() : view.readUInt16();
                } else if (size === 4) {
                    value = signed ? view.readInt32() : view.readUInt32();
                }
                if (scale && value && scale !== 1) {
                    value = value / scale;
                }
                payload[fieldName] = value;
                break;
            }
            case 'float': {
                // const [size] = rest; assert(size === 4);
                payload[fieldName] = view.readFloat();
                break;
            }
            case 'string': {
                // const [encoding] = rest; assert(encoding === 'utf8');
                payload[fieldName] = view.readString();
                break;
            }
            case 'bool': {
                // const [size] = rest; assert(size === 1);
                payload[fieldName] = view.readBool();
                break;
            }
            default:
                // Unknown field type, skip
                break;
        }
    }

    return payload as TunnelPayload;
}

export function encodeTunnelMessage(elems: TunnelPayload[]): Uint8Array {
    let totalLength = 0;
    const elemBuffers: Uint8Array[] = [];
    for (const elem of elems) {
        const buf = encodeTunnelMessageElem(elem);
        elemBuffers.push(buf);
        totalLength += buf.length;
    }

    const buf = new Uint8Array(1 + 2 + totalLength);
    const view = new DataViewExtended(buf, 0, TunnelMessageLittleEndian);
    view.writeUInt8(TunnelRequestMessage.Id);
    view.writeUInt16(totalLength);
    elemBuffers.forEach((b) => view.writeBuffer(b));
    return buf;
}

function encodeTunnelMessageElem(elem: TunnelPayload): Uint8Array {
    const def = TunnelPayloadDefinitions[elem.type];
    const elemRecord = elem as Record<string, unknown>;
    if (!def) {
        // Unknown or unhandled message type
        return new Uint8Array();
    }
    const encoder = new TextEncoder();

    // First calculate the total length
    let totalLength = 1; // for the type byte
    for (const fieldDef of def) {
        const [fieldName, fieldType, ...rest] = fieldDef;
        switch (fieldType) {
            case 'fixed':
            case 'float':
            case 'bool': {
                const [size] = rest as [number];
                totalLength += size;
                break;
            }
            case 'string': {
                const value = elemRecord[fieldName] as string;
                const strBuf = encoder.encode(value);
                totalLength += strBuf.length + 1; // string bytes + zero termination
                break;
            }
            default:
                // Unknown field type, skip
                break;
        }
    }

    const buf = new Uint8Array(totalLength);
    const view = new DataViewExtended(buf, 0, TunnelMessageLittleEndian);
    view.writeUInt8(elem.type);

    for (const fieldDef of def) {
        const [fieldName, fieldType, ...rest] = fieldDef;
        const value = elemRecord[fieldName];
        switch (fieldType) {
            case 'fixed': {
                const [size, signed, scale] = rest as [number, boolean, number];
                let fixedValue = value as number;
                if (scale !== 1) {
                    fixedValue = Math.round(fixedValue * scale);
                }
                if (size === 1) {
                    if (signed) view.writeInt8(fixedValue);
                    else view.writeUInt8(fixedValue);
                } else if (size === 2) {
                    if (signed) view.writeInt16(fixedValue);
                    else view.writeUInt16(fixedValue);
                } else if (size === 4) {
                    if (signed) view.writeInt32(fixedValue);
                    else view.writeUInt32(fixedValue);
                }
                break;
            }
            case 'float': {
                // const [size] = rest; assert(size === 4);
                view.writeFloat(value as number);
                break;
            }
            case 'string': {
                // const [encoding] = rest; assert(encoding === 'utf8');
                const strBuf = encoder.encode(value as string);
                view.writeBuffer(strBuf);
                view.writeUInt8(0); // zero termination
                break;
            }
            case 'bool': {
                // const [size] = rest; assert(size === 1);
                view.writeBool(!!value);
                break;
            }
            default:
                // Unknown field type, skip
                break;
        }
    }

    return buf;
}
