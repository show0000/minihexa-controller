/**
 * BLE connection to the real robot, attached to the Fanout, plus the "may still be walking" warning.
 *
 * The firmware latches walking until it receives a zero move, and its disconnect handler does
 * not stop the robot. So whether the robot may be walking is tracked from write outcomes
 * reported by the transport, never from what was merely queued:
 * - a non-zero move or avoid-on that was written (or whose write is unconfirmed) sets it;
 * - only a STOP or reset write that succeeded clears it;
 * - a STOP write that failed, or a STOP not confirmed in time, sets it and shows the warning.
 */
import { STOP, commandsEqual, type RobotCommand, type Telemetry } from '../protocol/commands';
import { BleTransport, type BleEvents } from '../transport/ble';
import type { Fanout } from '../transport/fanout';
import type { Transport } from '../transport/types';

export type LinkState = 'disconnected' | 'connecting' | 'connected' | 'disconnecting';

export const WALKING_WARNING = '로봇이 계속 걷고 있을 수 있습니다. 전원을 끄거나 다시 연결하세요';
/** How long a user disconnect waits for a confirmed STOP before giving up and warning. */
export const DISCONNECT_STOP_WAIT_MS = 500;

export interface RobotTransport extends Transport {
  disconnect(): void;
}

export interface RobotLinkOptions {
  connect?: (events: BleEvents) => Promise<RobotTransport>;
  bluetoothAvailable?: () => boolean;
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const isStop = (c: RobotCommand) => c.kind === 'move' && commandsEqual(c, STOP);

export class RobotLink {
  state: LinkState = 'disconnected';
  telemetry: Telemetry | null = null;
  warning: string | null = null;
  notice: string | null = null;
  private ble: RobotTransport | null = null;
  /** Whether the robot may be walking, from write outcomes (see the file comment). */
  private mayWalk = false;
  /** Resolved with true by the next successful STOP write, false on link loss. */
  private stopWaiters: Array<(confirmed: boolean) => void> = [];
  private readonly connectTransport: (events: BleEvents) => Promise<RobotTransport>;
  private readonly bluetoothAvailable: () => boolean;

  /** `onConnected` must bring the robot to a known state through the controller (e.g. resync). */
  constructor(
    private readonly fanout: Fanout,
    private readonly onConnected: () => void,
    options: RobotLinkOptions = {},
  ) {
    this.connectTransport = options.connect ?? ((ev) => BleTransport.connect(ev));
    this.bluetoothAvailable = options.bluetoothAvailable ?? (() => 'bluetooth' in navigator);
  }

  /** True while a robot is attached and may still be walking (or its state is unknown). */
  get robotMayWalk(): boolean {
    return this.ble !== null && this.mayWalk;
  }

  async connect(): Promise<void> {
    if (this.state !== 'disconnected') return;
    if (!this.bluetoothAvailable()) {
      this.notice = '이 브라우저는 Web Bluetooth를 지원하지 않습니다. Chrome을 쓰세요.';
      return;
    }
    this.state = 'connecting';
    this.notice = null;
    let t: RobotTransport | null = null;
    try {
      t = await this.connectTransport({
        onTelemetry: (tel) => {
          if (t && this.ble === t) this.telemetry = tel;
        },
        // A disconnect during connect() (before t is assigned) surfaces as a rejected connect.
        onDisconnect: () => {
          if (t) this.handleDisconnect(t);
        },
        onError: (e) => {
          if (t && this.ble === t) this.notice = `전송 오류: ${errorText(e)}`;
        },
        onWritten: (cmd, ok) => {
          if (t && this.ble === t) this.handleWritten(cmd, ok);
        },
        onStopTimeout: () => {
          if (t && this.ble === t) this.flagWalking();
        },
      });
    } catch (e) {
      this.state = 'disconnected';
      // NotFoundError: the user closed the device chooser.
      if (!(e instanceof DOMException && e.name === 'NotFoundError')) {
        this.notice = `연결 실패: ${errorText(e)}`;
      }
      return;
    }

    // Commit the connected state fully before anything else can run.
    this.ble = t;
    this.fanout.setRobot(t);
    this.state = 'connected';
    // The robot may still be walking from an earlier session: unknown until a STOP is confirmed.
    // An earlier warning stays up until then, too.
    this.mayWalk = true;

    // Unknown robot state after (re)connecting: the controller puts it in a known one.
    try {
      this.onConnected();
    } catch (e) {
      // The robot is not in a known state: do not stay connected to it. disconnect() rolls the
      // state back through handleDisconnect (ble, fanout, state, telemetry, warning).
      console.error('robot resync failed', e);
      t.disconnect();
      this.notice = `연결 후 초기화에 실패해 연결을 끊었습니다: ${errorText(e)}`;
    }
  }

  /**
   * User disconnect. Call after sending the e-stop through the controller. Detaches the robot
   * from the Fanout, sends one more STOP and waits up to DISCONNECT_STOP_WAIT_MS for a STOP write
   * to succeed; if none does, the walking warning is shown after disconnecting.
   */
  async disconnect(): Promise<void> {
    const t = this.ble;
    if (!t || this.state !== 'connected') return;
    this.state = 'disconnecting';
    this.fanout.setRobot(null);
    const confirmed = this.nextStopConfirmed(DISCONNECT_STOP_WAIT_MS);
    t.send(STOP);
    const ok = await confirmed;
    if (this.ble !== t) return; // the link dropped while waiting
    if (!ok) this.mayWalk = true;
    // Settle our state first: once a STOP is confirmed, only STOPs (ours) can still be queued
    // behind it (the robot was detached from the Fanout before ours was sent), so outcomes
    // the transport reports while closing must not raise a false warning.
    this.handleDisconnect(t);
    t.disconnect();
  }

  private nextStopConfirmed(timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => finish(false), timeoutMs);
      const finish = (v: boolean) => {
        clearTimeout(timer);
        this.stopWaiters = this.stopWaiters.filter((w) => w !== finish);
        resolve(v);
      };
      this.stopWaiters.push(finish);
    });
  }

  private resolveStopWaiters(confirmed: boolean): void {
    for (const w of [...this.stopWaiters]) w(confirmed);
  }

  private handleWritten(cmd: RobotCommand, ok: boolean): void {
    switch (cmd.kind) {
      case 'move':
        if (!isStop(cmd)) {
          this.mayWalk = true; // written, or unconfirmed: the robot may have it
        } else if (ok) {
          this.clearWalking();
          this.resolveStopWaiters(true);
        } else {
          this.flagWalking();
        }
        break;
      case 'avoid':
        if (cmd.on) this.mayWalk = true;
        break;
      case 'reset':
        if (ok) this.clearWalking();
        break;
      default:
        break;
    }
  }

  private flagWalking(): void {
    this.mayWalk = true;
    this.warning = WALKING_WARNING;
  }

  private clearWalking(): void {
    this.mayWalk = false;
    this.warning = null;
  }

  private handleDisconnect(t: RobotTransport): void {
    if (this.ble !== t) return;
    this.ble = null;
    this.fanout.setRobot(null);
    this.state = 'disconnected';
    this.telemetry = null;
    if (this.mayWalk) this.warning = WALKING_WARNING;
    this.mayWalk = false;
    this.resolveStopWaiters(false);
  }
}
