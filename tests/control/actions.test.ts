import { describe, expect, it } from 'vitest';
import { BUILTIN_ACTIONS, STORED_ACTION_LOCK_MS, actionDurationMs } from '../../src/control/actions';

describe('actionDurationMs', () => {
  // Brief listed 4600 for twist, but the firmware (hiwonder_robot.cpp 747-778) holds the
  // first of the 36 circle points for 500ms, not 100ms: 500 + 35*100 + 500 = 4500.
  it('twist (ids 1, 2) matches firmware delays', () => {
    expect(actionDurationMs(1)).toBe(4500);
    expect(actionDurationMs(2)).toBe(4500);
  });
  it('_wake_up (3) is 2200', () => expect(actionDurationMs(3)).toBe(2200));
  it('wake_up (4) is 8700', () => expect(actionDurationMs(4)).toBe(8700));
  it('acting_cute (5) is 2500', () => expect(actionDurationMs(5)).toBe(2500));
  it('stored actions (6..50) use the fixed lock', () => {
    expect(STORED_ACTION_LOCK_MS).toBe(10000);
    expect(actionDurationMs(7)).toBe(10000);
    expect(actionDurationMs(50)).toBe(10000);
  });
});

describe('BUILTIN_ACTIONS', () => {
  it('has ids 1..5 in order', () => {
    expect(BUILTIN_ACTIONS.map((a) => a.id)).toEqual([1, 2, 3, 4, 5]);
  });
  it('twist traces a radius-8 roll/pitch circle, 3 turns x 12 steps, then returns to 0', () => {
    for (const id of [1, 2] as const) {
      const steps = BUILTIN_ACTIONS.find((a) => a.id === id)!.steps;
      expect(steps).toHaveLength(37);
      expect(steps[0]!.att.roll).toBeCloseTo(8);
      expect(steps[0]!.att.pitch).toBeCloseTo(0);
      expect(steps[0]!.holdMs).toBe(500);
      for (const s of steps.slice(0, 36)) {
        expect(Math.hypot(s.att.roll, s.att.pitch)).toBeCloseTo(8);
        expect(s.att.yaw).toBe(0);
        expect(s.pos).toBe('keep');
      }
      expect(steps.slice(1, 36).every((s) => s.holdMs === 100 && s.moveMs === 100)).toBe(true);
      expect(steps[36]).toMatchObject({ att: { pitch: 0, roll: 0, yaw: 0 }, moveMs: 500, holdMs: 500 });
    }
    // id 1 is COUNTER_CLOCKWISE (dir -1): step 3 is angle -90deg -> pitch -8
    expect(BUILTIN_ACTIONS[0]!.steps[3]!.att.pitch).toBeCloseTo(-8);
    expect(BUILTIN_ACTIONS[1]!.steps[3]!.att.pitch).toBeCloseTo(8);
  });
  it('wake_up ends with a 10-step forward walk', () => {
    const last = BUILTIN_ACTIONS[3]!.steps.at(-1)!;
    expect(last.vel).toEqual({ vx: 0, vy: 1.5, omega: 0, steps: 10 });
    expect(last.holdMs).toBe(6000);
  });
});
