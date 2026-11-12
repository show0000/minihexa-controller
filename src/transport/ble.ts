import {
  STOP,
  BLE_NAME,
  BLE_UUIDS,
  encodeCommand,
  parseTelemetry,
  type RobotCommand,
  type Telemetry,
} from '../protocol/commands';
import type { Transport } from './types';
import { enqueue, isStop } from './writeQueue';

export type { Transport } from './types';

export interface BleEvents {
  onTelemetry(t: Telemetry): void;
  onDisconnect(): void;
  onError(e: unknown): void;
  /**
   * Outcome of one command write. ok=false: the write failed, or the link dropped while it
   * was in flight (reported before onDisconnect), so the robot may or may not have it.
   * Commands still pending at a disconnect, or replaced while pending, are never written
   * and never reported.
   */
  onWritten(cmd: RobotCommand, ok: boolean): void;
  /** A STOP was queued but no STOP write succeeded within STOP_CONFIRM_MS. */
  onStopTimeout(): void;
}

/** How long a queued STOP may stay unconfirmed before it is reported. */
export const STOP_CONFIRM_MS = 300;

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
  /** One write in flight at a time; later commands wait (coalesced) in `pending`. */
  private inFlight: RobotCommand | null = null;
  private pending: RobotCommand[] = [];
  private stopTimer: ReturnType<typeof setTimeout> | null = null;
  /** True while the pump loop runs; a nested pump() (e.g. send() from a handler) must not start. */
  private pumping = false;
  /** Set by finalStop(): only that STOP may still be written. */
  private final: { cmd: RobotCommand; resolve: (ok: boolean) => void } | null = null;
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

  /** Commands waiting behind the write in flight (for tests and diagnostics). */
  get pendingCount(): number {
    return this.pending.length;
  }

  send(cmd: RobotCommand): void {
    if (!this._connected || this.final) return;
    this.pending = enqueue(this.pending, cmd);
    if (isStop(cmd)) this.armStopTimer();
    else if (!this.stopOutstanding()) this.clearStopTimer(); // a newer move replaced the STOP
    void this.pump();
  }

  /**
   * Closing: drop every pending command, refuse new ones, and queue one last STOP behind the
   * write already in flight (if any). Resolves true only when that STOP's own write succeeds;
   * false if it fails or the link drops first. Nothing else is started after this call.
   */
  finalStop(): Promise<boolean> {
    if (!this._connected) return Promise.resolve(false);
    if (this.final) return Promise.resolve(false);
    const cmd: RobotCommand = { ...STOP }; // its own identity: an earlier STOP does not count
    const done = new Promise<boolean>((resolve) => {
      this.final = { cmd, resolve };
    });
    this.pending = [cmd];
    void this.pump();
    return done;
  }

  private settleFinal(cmd: RobotCommand | null, ok: boolean): void {
    const f = this.final;
    if (f && (cmd === null || cmd === f.cmd)) {
      f.resolve(ok);
      this.final = { cmd: f.cmd, resolve: () => {} }; // stay closed
    }
  }

  private stopOutstanding(): boolean {
    return (this.inFlight !== null && isStop(this.inFlight)) || this.pending.some(isStop);
  }

  private armStopTimer(): void {
    if (this.stopTimer !== null) return; // measured from the first unconfirmed STOP
    this.stopTimer = setTimeout(() => {
      this.stopTimer = null;
      if (this._connected) this.call(() => this.events.onStopTimeout());
    }, STOP_CONFIRM_MS);
  }

  private clearStopTimer(): void {
    if (this.stopTimer === null) return;
    clearTimeout(this.stopTimer);
    this.stopTimer = null;
  }

  private async pump(): Promise<void> {
    if (this.pumping) return; // the running loop picks up whatever was queued
    this.pumping = true;
    try {
      while (this._connected) {
        const cmd = this.pending.shift();
        if (!cmd) return;
        this.inFlight = cmd;
        let ok = false;
        let error: unknown = null;
        try {
          await this.write(cmd);
          ok = true;
        } catch (e) {
          error = e;
        }
        // A disconnect while in flight has already reported this command.
        if (this.inFlight !== cmd) return;
        this.inFlight = null;
        if (!ok) this.call(() => this.events.onError(error));
        if (ok && isStop(cmd)) this.clearStopTimer();
        this.settleFinal(cmd, ok); // before handlers: one of them may close the link
        this.call(() => this.events.onWritten(cmd, ok));
      }
    } finally {
      this.pumping = false;
    }
  }

  /** Write one command; throws if any chunk fails or the link drops. */
  private async write(cmd: RobotCommand): Promise<void> {
    if (this.dirty) {
      // A previous command failed mid-way; the firmware still holds its
      // fragment until it sees '&'. Terminate it so it cannot merge with
      // this command (the garbage fragment is then parsed and discarded).
      await this.writeChar.writeValueWithResponse(this.encoder.encode('&'));
      this.dirty = false;
    }
    const chunks = chunkAscii(encodeCommand(cmd), MAX_CHUNK);
    for (let i = 0; i < chunks.length; i++) {
      if (!this._connected) throw new Error('disconnected');
      try {
        await this.writeChar.writeValueWithResponse(this.encoder.encode(chunks[i]!));
      } catch (e) {
        // If an earlier chunk of this command was written, the firmware
        // holds an unterminated fragment: flush it before the next command.
        if (i > 0) this.dirty = true;
        throw e;
      }
    }
  }

  /** Event handlers must never break the write loop or produce an unhandled rejection. */
  private call(f: () => void): void {
    try {
      f();
    } catch (e) {
      console.error('BLE event handler failed', e);
    }
  }

  handleNotification(value: DataView): void {
    const t = parseTelemetry(this.decoder.decode(value));
    if (t) this.events.onTelemetry(t);
  }

  handleDisconnected(): void {
    if (!this._connected) return;
    this._connected = false;
    this.clearStopTimer();
    this.pending = [];
    const lost = this.inFlight;
    this.inFlight = null;
    if (lost) this.call(() => this.events.onWritten(lost, false));
    this.settleFinal(null, false);
    this.events.onDisconnect();
  }

  disconnect(): void {
    const g = this.gatt;
    this.handleDisconnected();
    if (g?.connected) g.disconnect();
  }
}
