import { describe, expect, it } from 'vitest';
import { DEFAULT_BODY_Z, GAIT, gaitPeriodMs, initGait, stepGait, type GaitState } from '../../src/sim/gait';
import { LINK, STANCE, applyBodyPose, bodyToLeg, fkLeg, ikLeg } from '../../src/sim/kinematics';

type Vel = { vx: number; vy: number; omega: number };
const ZERO: Vel = { vx: 0, vy: 0, omega: 0 };
const GROUP_A = [0, 2, 4];
const GROUP_B = [1, 3, 5];

function run(
  s: GaitState,
  ms: number,
  vel: Vel,
  dt = 10,
  each?: (s: GaitState) => void,
  bodyZ = DEFAULT_BODY_Z,
): GaitState {
  for (let t = 0; t < ms; t += dt) {
    s = stepGait(s, dt, vel, bodyZ);
    each?.(s);
  }
  return s;
}
const lifted = (s: GaitState) =>
  s.feet.flatMap((f, i) => (f.z >= STANCE[i]!.z + 0.01 ? [i] : []));

describe('GAIT constants', () => {
  it('match the brief', () => {
    expect(GAIT).toEqual({ minPeriodMs: 400, lift: 3, maxHalfStep: 3, cmPerSecAtMax: 20 });
  });
  it('period is the firmware move_time: 600ms up to a 3cm half step, shorter above, never < 400', () => {
    expect(gaitPeriodMs({ vx: 0, vy: 3, omega: 0 })).toBe(600);
    expect(gaitPeriodMs({ vx: 0, vy: 1, omega: 0 })).toBe(600);
    expect(gaitPeriodMs({ vx: 3, vy: 3, omega: 0 })).toBeLessThan(600);
    expect(gaitPeriodMs({ vx: 3, vy: 3, omega: 0 })).toBeGreaterThanOrEqual(GAIT.minPeriodMs);
  });
});

describe('stepGait', () => {
  it('starts in STANCE at the origin', () => {
    const s = initGait();
    expect(s.feet).toEqual(STANCE);
    expect(s.odom).toEqual({ x: 0, y: 0, heading: 0 });
  });

  it('does not move the feet with zero velocity', () => {
    const s = run(initGait(), 1000, ZERO, 16);
    s.feet.forEach((f, i) => {
      expect(Math.abs(f.x - STANCE[i]!.x)).toBeLessThan(1e-9);
      expect(Math.abs(f.y - STANCE[i]!.y)).toBeLessThan(1e-9);
      expect(Math.abs(f.z - STANCE[i]!.z)).toBeLessThan(1e-9);
    });
    expect(s.odom).toEqual({ x: 0, y: 0, heading: 0 });
  });

  it('only ever lifts feet of one tripod at a time', () => {
    const vel = { vx: 0, vy: 3, omega: 0 };
    run(initGait(), 3000, vel, 7, (s) => {
      const up = lifted(s);
      const inA = up.every((i) => GROUP_A.includes(i));
      const inB = up.every((i) => GROUP_B.includes(i));
      expect(inA || inB, `lifted ${up}`).toBe(true);
    });
  });

  it('lifts lower at a low body and higher at a tall body (firmware lift bands)', () => {
    const vel = { vx: 0, vy: 3, omega: 0 };
    const q = gaitPeriodMs(vel) / 4;
    const peak = (z: number) => {
      const s = run(initGait(), q, vel, q / 10, undefined, z);
      return Math.max(...s.feet.map((f, i) => f.z - STANCE[i]!.z));
    };
    expect(peak(0)).toBeCloseTo(2.0, 6);
    expect(peak(2.5)).toBeCloseTo(3.5, 6);
  });

  it('lifts a whole tripod to about GAIT.lift at a quarter period (default body height)', () => {
    const vel = { vx: 0, vy: 3, omega: 0 };
    const s = run(initGait(), gaitPeriodMs(vel) / 4, vel, gaitPeriodMs(vel) / 40);
    const up = lifted(s);
    expect([GROUP_A, GROUP_B]).toContainEqual(up);
    const maxH = Math.max(...s.feet.map((f, i) => f.z - STANCE[i]!.z));
    expect(Math.abs(maxH - GAIT.lift)).toBeLessThan(0.1);
  });

  it('drives odometry forward (+y) for +vy and backward for -vy', () => {
    expect(run(initGait(), 2000, { vx: 0, vy: 3, omega: 0 }).odom.y).toBeGreaterThan(0);
    expect(run(initGait(), 2000, { vx: 0, vy: -3, omega: 0 }).odom.y).toBeLessThan(0);
  });

  it.each<[string, Vel]>([
    ['forward vy', { vx: 0, vy: 3, omega: 0 }],
    ['sideways vx', { vx: -2, vy: 0, omega: 0 }],
    ['turn in place', { vx: 0, vy: 0, omega: 2.5 }],
    ['combined', { vx: 1, vy: 1.5, omega: -0.2 }],
  ])('keeps planted feet fixed on the ground (%s)', (_, vel) => {
    // world(foot) = odom pose applied to the body-frame foot
    const world = (s: GaitState, i: number) => {
      const f = s.feet[i]!;
      const { x, y, heading: h } = s.odom;
      return { x: x + f.x * Math.cos(h) - f.y * Math.sin(h), y: y + f.x * Math.sin(h) + f.y * Math.cos(h) };
    };
    const planted = (s: GaitState, i: number) => s.feet[i]!.z === STANCE[i]!.z;
    let prev = stepGait(initGait(), 7, vel);
    let checked = 0;
    for (let n = 0; n < 400; n++) {
      const next = stepGait(prev, 7, vel);
      for (let i = 0; i < 6; i++) {
        if (!planted(prev, i) || !planted(next, i)) continue;
        const [a, b] = [world(prev, i), world(next, i)];
        expect(Math.hypot(a.x - b.x, a.y - b.y), `leg ${i} step ${n}`).toBeLessThan(1e-6);
        checked++;
      }
      prev = next;
    }
    expect(checked).toBeGreaterThan(1000);
    expect(Math.hypot(prev.odom.x, prev.odom.y) + Math.abs(prev.odom.heading)).toBeGreaterThan(1);
  });

  it('averages cmPerSecAtMax over whole cycles at a full forward stride', () => {
    const vel = { vx: 0, vy: 3, omega: 0 };
    const s = run(initGait(), 2 * gaitPeriodMs(vel), vel);
    expect(s.odom.y).toBeCloseTo((GAIT.cmPerSecAtMax * 2 * gaitPeriodMs(vel)) / 1000, 6);
    expect(s.odom.x).toBeCloseTo(0, 9);
  });

  it('turns in place for omega with x/y unchanged', () => {
    const s = run(initGait(), 1000, { vx: 0, vy: 0, omega: 2.5 });
    expect(s.odom.heading).toBeGreaterThan(0);
    expect(Math.hypot(s.odom.x, s.odom.y)).toBeLessThan(1e-9);
  });

  it('swing feet move toward the walking direction, stance feet against it', () => {
    const vel = { vx: 0, vy: 3, omega: 0 };
    const q = gaitPeriodMs(vel) / 4;
    const a = run(initGait(), q, vel, q / 10);
    const b = run(a, 10, vel, 10);
    const swing = lifted(a)[0]!;
    const stance = [0, 1, 2, 3, 4, 5].find((i) => !lifted(a).includes(i))!;
    expect(b.feet[swing]!.y).toBeGreaterThan(a.feet[swing]!.y);
    expect(b.feet[stance]!.y).toBeLessThan(a.feet[stance]!.y);
  });

  it('returns the feet to STANCE soon after stopping', () => {
    let s = run(initGait(), 1234, { vx: 2, vy: 3, omega: 0 });
    const odom = { ...s.odom };
    s = run(s, gaitPeriodMs({ vx: 2, vy: 3, omega: 0 }), ZERO);
    expect(s.odom).toEqual(odom);
    s.feet.forEach((f, i) => {
      expect(Math.hypot(f.x - STANCE[i]!.x, f.y - STANCE[i]!.y, f.z - STANCE[i]!.z)).toBeLessThan(1e-9);
    });
  });
});

describe('STANCE reachability', () => {
  // Comfortable = the femur + tibia span stays clear of both full extension and full fold.
  const maxSpan = 0.96 * (LINK.l2 + LINK.l3);
  const minSpan = Math.abs(LINK.l3 - LINK.l2) + 0.15;
  const vels: Vel[] = [
    { vx: 0, vy: 3, omega: 0 },
    { vx: 0, vy: -3, omega: 0 },
    { vx: 3, vy: 0, omega: 0 },
    { vx: -3, vy: 0, omega: 0 },
    { vx: 3, vy: 3, omega: 0 },
    { vx: -3, vy: 3, omega: 0.2 },
    { vx: 0, vy: 0, omega: 2.5 },
    { vx: 0, vy: 0, omega: -2.5 },
    { vx: 0, vy: 1.5, omega: -0.2 },
  ];
  it.each([0, 0.5, 1, 1.5, 2, 2.5, 3])('every foot stays reachable during strides at body z %f', (z) => {
    const pose = { x: 0, y: 0, z, pitch: 0, roll: 0, yaw: 0 };
    for (const vel of vels) {
      const check = (s: GaitState) => {
        applyBodyPose(s.feet, pose).forEach((f, i) => {
          const local = bodyToLeg(i, f);
          const j = ikLeg(local);
          expect(j, `leg ${i} vel ${JSON.stringify(vel)}`).not.toBeNull();
          const r = Math.hypot(local.x, local.y) - LINK.l1;
          const span = Math.hypot(r, local.z);
          expect(span).toBeLessThan(maxSpan);
          expect(span).toBeGreaterThan(minSpan);
          expect(fkLeg(j!).z).toBeCloseTo(local.z, 6);
        });
      };
      run(initGait(), 2 * gaitPeriodMs(vel), vel, 3, check, z);
    }
  });
});
