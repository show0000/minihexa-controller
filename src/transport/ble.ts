import {
  BLE_NAME,
  BLE_UUIDS,
  encodeCommand,
  parseTelemetry,
  type RobotCommand,
  type Telemetry,
} from '../protocol/commands';
import type { Transport } from './types';

export type { Transport } from './types';

export interface BleEvents {
  onTelemetry(t: Telemetry): void;
  onDisconnect(): void;
  onError(e: unknown): void;
}

export interface WritableChar {
  writeValueWithResponse(v: BufferSource): Promise<void>;
}

const MAX_CHUNK = 20;

export function chunkAscii(s: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
  return out;
}

export class BleTransport implements Transport {
  private _connected = true;
  private tail: Promise<void> = Promise.resolve();
  private readonly encoder = new TextEncoder();
  private readonly decoder = new TextDecoder();
  private gatt: BluetoothRemoteGATTServer | null = null;

  constructor(
    private readonly writeChar: WritableChar,
    private readonly events: BleEvents,
  ) {}

  static async connect(events: BleEvents): Promise<BleTransport> {
    const device = await navigator.bluetooth.requestDevice({
      filters: [{ name: BLE_NAME }],
      optionalServices: [BLE_UUIDS.service],
    });
    const server = await device.gatt!.connect();
    const service = await server.getPrimaryService(BLE_UUIDS.service);
    const writeChar = await service.getCharacteristic(BLE_UUIDS.write);
    const notifyChar = await service.getCharacteristic(BLE_UUIDS.notify);
    const t = new BleTransport(writeChar, events);
    t.gatt = server;
    device.addEventListener('gattserverdisconnected', () => t.handleDisconnected());
    notifyChar.addEventListener('characteristicvaluechanged', () => {
      if (notifyChar.value) t.handleNotification(notifyChar.value);
    });
    await notifyChar.startNotifications();
    return t;
  }

  get connected(): boolean {
    return this._connected;
  }

  send(cmd: RobotCommand): void {
    if (!this._connected) return;
    this.tail = this.tail.then(() => this.write(cmd));
  }

  private async write(cmd: RobotCommand): Promise<void> {
    if (!this._connected) return;
    try {
      for (const chunk of chunkAscii(encodeCommand(cmd), MAX_CHUNK)) {
        if (!this._connected) return;
        await this.writeChar.writeValueWithResponse(this.encoder.encode(chunk));
      }
    } catch (e) {
      // Remaining chunks of this command are dropped so a partial command
      // never gets glued to the next one in the firmware buffer.
      this.report(e);
    }
  }

  private report(e: unknown): void {
    try {
      this.events.onError(e);
    } catch {
      // onError must never produce an unhandled rejection.
    }
  }

  handleNotification(value: DataView): void {
    const t = parseTelemetry(this.decoder.decode(value));
    if (t) this.events.onTelemetry(t);
  }

  handleDisconnected(): void {
    if (!this._connected) return;
    this._connected = false;
    this.events.onDisconnect();
  }

  disconnect(): void {
    const g = this.gatt;
    this.handleDisconnected();
    if (g?.connected) g.disconnect();
  }
}
