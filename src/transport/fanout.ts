import type { RobotCommand } from '../protocol/commands';
import type { Transport } from './types';

/** Always sends to the simulator; also to the robot when one is attached. */
export class Fanout implements Transport {
  private robot: Transport | null = null;

  constructor(private readonly sim: Transport) {}

  setRobot(t: Transport | null): void {
    this.robot = t;
  }

  send(cmd: RobotCommand): void {
    this.sim.send(cmd);
    try {
      this.robot?.send(cmd);
    } catch {
      // Intentionally swallowed: BleTransport reports its own failures via
      // onError, and a robot fault must never break the simulator path.
    }
  }

  /** Whether a robot is attached and connected. */
  get connected(): boolean {
    return this.robot?.connected ?? false;
  }
}
