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
  private dirty = false;
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
    try {
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
    } catch (e) {
      server.disconnect();
      throw e;
    }
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
      if (this.dirty) {
        // A previous command failed mid-way; the firmware still holds its
        // fragment until it sees '&'. Terminate it so it cannot merge with
        // this command (the garbage fragment is then parsed and discarded).
        await this.writeChar.writeValueWithResponse(this.encoder.encode('&'));
        this.dirty = false;
      }
      const chunks = chunkAscii(encodeCommand(cmd), MAX_CHUNK);
      for (let i = 0; i < chunks.length; i++) {
        if (!this._connected) return;
        try {
          await this.writeChar.writeValueWithResponse(this.encoder.encode(chunks[i]!));
        } catch (e) {
          // If an earlier chunk of this command was written, the firmware
          // holds an unterminated fragment: flush it before the next command.
          if (i > 0) this.dirty = true;
          throw e;
        }
      }
    } catch (e) {
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
