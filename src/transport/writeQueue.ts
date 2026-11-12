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
  // A pending STOP followed by another command (e.g. the STOP that zeroes the velocity before an
  // action) must reach the robot before it. Only a STOP that is the last pending item may be
  // replaced by a newer move.
  const last = pending.length - 1;
  const replaceableStop = (p: RobotCommand, i: number) => isStop(p) && i === last;
  let keep: (p: RobotCommand, i: number) => boolean;
  if (cmd.kind === 'move') {
    // STOP also drops pending poses; a non-STOP move drops only older moves.
    const dropPoses = isStop(cmd);
    keep = (p, i) =>
      p.kind === 'move' ? isStop(p) && !replaceableStop(p, i) : !(dropPoses && p.kind === 'pose');
  } else if (isModeOff(cmd)) {
    // A pending STOP stays: it is what confirms the robot stopped.
    keep = (p) => (p.kind !== 'move' || isStop(p)) && p.kind !== 'pose';
  } else if (cmd.kind === 'pose') {
    keep = (p) => p.kind !== 'pose';
  } else {
    keep = () => true;
  }
  return [...pending.filter(keep), cmd];
}
