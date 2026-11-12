import { describe, expect, it } from 'vitest';
import { STOP, type RobotCommand } from '../../src/protocol/commands';
import { STORED_ACTION_LOCK_MS } from '../../src/control/actions';
import { SimRobot, commandToVelocity, poseCommandToBodyPose, type SimFrame } from '../../src/sim/robotModel';

const move = (vx: number, vy: number, turn: 0 | 1 | 2 = 0): Extract<RobotCommand, { kind: 'move' }> => ({
  kind: 'move',
  vx,
  vy,
  turn,
});
const pose = (p: Partial<Omit<Extract<RobotCommand, { kind: 'pose' }>, 'kind'>>): RobotCommand => ({
  kind: 'pose',
  yaw: 0,
  pitch: 0,
  roll: 0,
  x: 0,
  y: 0,
  z: 10,
  ...p,
});

/** Tick the robot every 16ms from `from` to `to`, returning the last frame. */
function runTo(r: SimRobot, from: number, to: number): SimFrame {
  let f = r.tick(from);
  for (let t = from + 16; t < to; t += 16) f = r.tick(t);
  return r.tick(to);
}

describe('commandToVelocity (remote.ino C mapping)', () => {
  it('maps vx, vy ±50 to ±3', () => {
    expect(commandToVelocity(move(50, 0))).toEqual({ vx: 3, vy: 0, omega: 0 });
    expect(commandToVelocity(move(0, -50))).toEqual({ vx: 0, vy: -3, omega: 0 });
  });
  it('turns at ±2.5 standing still', () => {
    expect(commandToVelocity(move(0, 0, 1))).toEqual({ vx: 0, vy: 0, omega: 2.5 });
    expect(commandToVelocity(move(0, 0, 2))).toEqual({ vx: 0, vy: 0, omega: -2.5 });
  });
  it('turns at ±0.2 while moving', () => {
    expect(commandToVelocity(move(0, 25, 2))).toEqual({ vx: 0, vy: 1.5, omega: -0.2 });
    expect(commandToVelocity(move(10, 0, 1)).omega).toBe(0.2);
  });
});

describe('poseCommandToBodyPose (remote.ino F mapping)', () => {
  it('maps z 0..30 to 0..3cm and x/y ±50 to ±3cm', () => {
    const p = poseCommandToBodyPose({ kind: 'pose', yaw: 0, pitch: 0, roll: 0, x: 50, y: -25, z: 30 });
    expect(p.z).toBeCloseTo(3);
    expect(p.x).toBeCloseTo(3);
    expect(p.y).toBeCloseTo(-1.5);
  });
  it('scales pitch/roll limits by the z band', () => {
    const at = (z: number) => poseCommandToBodyPose({ kind: 'pose', yaw: 0, pitch: 50, roll: 50, x: 0, y: 0, z });
    expect(at(5)).toMatchObject({ pitch: 5, roll: 10 });
    expect(at(15).pitch).toBeCloseTo(8.3);
    expect(at(15).roll).toBeCloseTo(15);
    expect(at(30)).toMatchObject({ pitch: 12.5, roll: 20 });
  });
  it('maps yaw ±50 to ∓60° (firmware negates) and clamps to ±20 (Robot::move)', () => {
    const at = (yaw: number) => poseCommandToBodyPose({ kind: 'pose', yaw, pitch: 0, roll: 0, x: 0, y: 0, z: 10 }).yaw;
    expect(at(50)).toBe(-20);
    expect(at(-50)).toBe(20);
    expect(at(-5)).toBeCloseTo(6);
  });
});

describe('SimRobot', () => {
  it('starts idle with the firmware default LED and six joint sets', () => {
    const f = new SimRobot().tick(0);
    expect(f.joints).toHaveLength(6);
    expect(f.busyUntil).toBeNull();
    expect(f.led).toEqual([0, 237, 178]);
    expect(f.odom).toEqual({ x: 0, y: 0, heading: 0 });
  });

  it('walks after a move command and the walk is latched', () => {
    const r = new SimRobot();
    r.tick(0);
    r.apply(move(0, 50), 0);
    const f = runTo(r, 0, 1000);
    expect(f.odom.y).toBeGreaterThan(5);
  });

  it('freezes odometry within one period after STOP', () => {
    const r = new SimRobot();
    r.tick(0);
    r.apply(move(0, 50), 0);
    runTo(r, 0, 1000);
    r.apply(STOP, 1000);
    const a = runTo(r, 1000, 1600).odom;
    const b = runTo(r, 1600, 2600).odom;
    expect(b).toEqual(a);
  });

  it('keeps walking through a POSE command (vel is latched)', () => {
    const r = new SimRobot();
    r.tick(0);
    r.apply(move(0, 50), 0);
    runTo(r, 0, 500);
    r.apply(pose({ z: 20 }), 500);
    const y0 = r.tick(500).odom.y;
    expect(runTo(r, 500, 1500).odom.y).toBeGreaterThan(y0 + 5);
  });

  it('zeroes roll and yaw while walking but keeps pitch', () => {
    const r = new SimRobot();
    r.tick(0);
    r.apply(pose({ z: 15, pitch: 50, roll: 50, yaw: 50 }), 0);
    const still = runTo(r, 0, 1000).body;
    expect(still.roll).toBeCloseTo(15);
    expect(still.yaw).toBeCloseTo(-20);
    r.apply(move(0, 50), 1000);
    const walking = runTo(r, 1000, 2000).body;
    expect(walking.roll).toBeCloseTo(0);
    expect(walking.yaw).toBeCloseTo(0);
    expect(walking.pitch).toBeCloseTo(8.3);
    r.apply(STOP, 2000);
    expect(runTo(r, 2000, 3000).body.roll).toBeCloseTo(15);
  });

  it('returns body.z to the 1cm default after reset and stops walking', () => {
    const r = new SimRobot();
    r.tick(0);
    r.apply(pose({ z: 30 }), 0);
    expect(runTo(r, 0, 1000).body.z).toBeCloseTo(3);
    r.apply(move(0, 50), 1000);
    r.apply({ kind: 'reset' }, 1100);
    const a = runTo(r, 1100, 1800);
    expect(a.body.z).toBeCloseTo(1);
    expect(runTo(r, 1800, 2500).odom).toEqual(a.odom);
  });

  it('sets the LED', () => {
    const r = new SimRobot();
    r.apply({ kind: 'led', r: 1, g: 2, b: 3 }, 0);
    expect(r.tick(0).led).toEqual([1, 2, 3]);
  });

  it('walks forward in avoid mode and stops when avoid turns off', () => {
    const r = new SimRobot();
    r.tick(0);
    r.apply({ kind: 'avoid', on: true }, 0);
    const a = runTo(r, 0, 1000).odom;
    expect(a.y).toBeGreaterThan(5);
    r.apply({ kind: 'avoid', on: false }, 1000);
    const b = runTo(r, 1000, 1700).odom;
    expect(runTo(r, 1700, 2500).odom).toEqual(b);
  });

  it('balance mode leaves attitude and walking unchanged', () => {
    const r = new SimRobot();
    r.tick(0);
    r.apply(move(0, 50), 0);
    r.apply({ kind: 'balance', on: true }, 0);
    const f = runTo(r, 0, 1000);
    expect(f.odom.y).toBeGreaterThan(5);
    expect(f.body.pitch).toBeCloseTo(0);
    expect(f.body.roll).toBeCloseTo(0);
  });

  describe('actions', () => {
    it('action 4 is busy for 8700ms', () => {
      const r = new SimRobot();
      r.tick(0);
      r.apply({ kind: 'action', id: 4 }, 100);
      expect(r.tick(100).busyUntil).toBe(8800);
      expect(r.tick(8799).busyUntil).toBe(8800);
      expect(r.tick(8800).busyUntil).toBeNull();
    });

    it('animates the script attitude (wake up pitches the body)', () => {
      const r = new SimRobot();
      r.tick(0);
      r.apply({ kind: 'action', id: 4 }, 0);
      // step 2 (att pitch -8, yaw -15) starts at 100ms, moves over 200ms
      expect(runTo(r, 0, 1000).body.pitch).toBeCloseTo(-8);
    });

    it('stored actions (6..50) hold a neutral pose for STORED_ACTION_LOCK_MS', () => {
      const r = new SimRobot();
      r.tick(0);
      r.apply({ kind: 'action', id: 12 }, 0);
      const f = runTo(r, 0, 5000);
      expect(f.busyUntil).toBe(STORED_ACTION_LOCK_MS);
      expect(f.body.pitch).toBeCloseTo(0);
      expect(f.odom).toEqual({ x: 0, y: 0, heading: 0 });
    });

    it('holds commands while busy and applies only the last one when busy ends', () => {
      const r = new SimRobot();
      r.tick(0);
      r.apply({ kind: 'action', id: 3 }, 0); // 2200ms
      r.apply({ kind: 'led', r: 9, g: 9, b: 9 }, 100);
      r.apply(move(0, 50), 200);
      r.apply(move(0, -50), 300);
      const during = runTo(r, 0, 2199);
      expect(during.led).toEqual([0, 237, 178]);
      const y0 = during.odom.y;
      const after = runTo(r, 2199, 3200);
      expect(after.led).toEqual([0, 237, 178]);
      expect(after.odom.y).toBeLessThan(y0 - 5);
    });

    it('a held command is applied at busy end even if apply is called later', () => {
      const r = new SimRobot();
      r.tick(0);
      r.apply({ kind: 'action', id: 3 }, 0);
      r.apply({ kind: 'led', r: 9, g: 9, b: 9 }, 100);
      r.apply({ kind: 'led', r: 5, g: 5, b: 5 }, 5000);
      // led 9 applied at 2200, then led 5 applied immediately at 5000
      expect(r.tick(5000).led).toEqual([5, 5, 5]);
    });

    it('does not walk after an action until a new command arrives, but keeps the latched vel', () => {
      const r = new SimRobot();
      r.tick(0);
      r.apply(move(0, 50), 0);
      runTo(r, 0, 500);
      r.apply({ kind: 'action', id: 5 }, 500); // 2500ms
      const a = runTo(r, 500, 3700).odom;
      expect(runTo(r, 3700, 4500).odom).toEqual(a);
      // F re-sends the latched vel to Robot::move, so walking resumes
      r.apply(pose({}), 4500);
      expect(runTo(r, 4500, 5500).odom.y).toBeGreaterThan(a.y + 5);
    });
  });
});
