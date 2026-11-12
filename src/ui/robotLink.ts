/** BLE connection to the real robot, attached to the Fanout, plus the "may still be walking" warning. */
import { STOP, commandsEqual, type RobotCommand, type Telemetry } from '../protocol/commands';
import { BleTransport } from '../transport/ble';
import type { Fanout } from '../transport/fanout';

export type LinkState = 'disconnected' | 'connecting' | 'connected';

export const WALKING_WARNING = '로봇이 계속 걷고 있을 수 있습니다. 전원을 끄거나 다시 연결하세요';

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export class RobotLink {
  state: LinkState = 'disconnected';
  telemetry: Telemetry | null = null;
  warning: string | null = null;
  notice: string | null = null;
  private ble: BleTransport | null = null;
  /** Whether the last walking-related command actually sent to the robot left it walking. */
  private mayWalk = false;

  /** `onConnected` must bring the robot to a known state through the controller (e.g. resync). */
  constructor(
    private readonly fanout: Fanout,
    private readonly onConnected: () => void,
  ) {}

  async connect(): Promise<void> {
    if (this.state !== 'disconnected') return;
    if (!('bluetooth' in navigator)) {
      this.notice = '이 브라우저는 Web Bluetooth를 지원하지 않습니다. Chrome을 쓰세요.';
      return;
    }
    this.state = 'connecting';
    this.notice = null;
    let t: BleTransport | null = null;
    try {
      t = await BleTransport.connect({
        onTelemetry: (tel) => {
          this.telemetry = tel;
        },
        // A disconnect during connect() (before t is assigned) surfaces as a rejected connect.
        onDisconnect: () => {
          if (t) this.handleDisconnect(t);
        },
        onError: (e) => {
          this.notice = `전송 오류: ${errorText(e)}`;
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
    this.warning = null;
    this.mayWalk = false;

    // Unknown robot state after (re)connecting: the controller puts it in a known one.
    try {
      this.onConnected();
    } catch (e) {
      // The robot is not in a known state: do not stay connected to it. disconnect() rolls the
      // state back through handleDisconnect (ble, fanout, state, telemetry).
      console.error('robot resync failed', e);
      t.disconnect();
      this.notice = `연결 후 초기화에 실패해 연결을 끊었습니다: ${errorText(e)}`;
    }
  }

  disconnect(): void {
    this.ble?.disconnect();
  }

  /** Call for every command passed to the Fanout. */
  noteSent(c: RobotCommand): void {
    if (!this.ble || !this.ble.connected) return;
    if (c.kind === 'move') this.mayWalk = !commandsEqual(c, STOP);
    else if (c.kind === 'avoid') this.mayWalk = c.on;
    else if (c.kind === 'reset') this.mayWalk = false;
  }

  private handleDisconnect(t: BleTransport): void {
    if (this.ble !== t) return;
    this.ble = null;
    this.fanout.setRobot(null);
    this.state = 'disconnected';
    this.telemetry = null;
    if (this.mayWalk) this.warning = WALKING_WARNING;
    this.mayWalk = false;
  }
}
