/**
 * Coalescing rules for commands waiting behind the one BLE write in flight.
 *
 * The firmware keeps only the last command it received per loop, so a stale move or pose
 * is worth nothing; only the newest one is kept. Stopping commands drop any pending move or
 * pose so nothing queued before them can restart walking after them. Everything else
 * (action, avoid/balance on, reset, LED) keeps its order.
 */
import { STOP, commandsEqual, type RobotCommand } from '../protocol/commands';

export function isStop(c: RobotCommand): boolean {
  return c.kind === 'move' && commandsEqual(c, STOP);
}

function isModeOff(c: RobotCommand): boolean {
  return (c.kind === 'avoid' || c.kind === 'balance') && !c.on;
}

/** Return the pending queue after adding `cmd`. */
export function enqueue(pending: readonly RobotCommand[], cmd: RobotCommand): RobotCommand[] {
  let keep: (p: RobotCommand) => boolean;
  if (isStop(cmd)) {
    keep = (p) => p.kind !== 'move' && p.kind !== 'pose';
  } else if (isModeOff(cmd)) {
    // A pending STOP stays: it is what confirms the robot stopped.
    keep = (p) => (p.kind !== 'move' || isStop(p)) && p.kind !== 'pose';
  } else if (cmd.kind === 'move' || cmd.kind === 'pose') {
    keep = (p) => p.kind !== cmd.kind;
  } else {
    keep = () => true;
  }
  return [...pending.filter(keep), cmd];
}
