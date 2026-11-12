import type { RobotCommand } from '../protocol/commands';

export interface Transport {
  send(cmd: RobotCommand): void;
  readonly connected: boolean;
}
