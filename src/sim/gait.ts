/**
 * Tripod gait, approximating the firmware's sinusoidal crawl
 * (vendor/app_firmware/remote/hiwonder_robot.cpp Robot::update 258-395,
 * cal_omni_move_end_point 467-587, move 588-636).
 *
 * Feet are in the neutral body frame (cm). Legs {0,2,4} (L1, L3, L5) and {1,3,5} alternate.
 * Phase `t` is in gait cycles [0, 1). This phase is the firmware's tick_count shifted by a
 * quarter cycle so that a cycle starts with both tripods down and tripod A lifts first.
 *
 * Planted feet never slide: each foot sits at exp(h * xi) applied to its STANCE point, where xi
 * is the body twist per half step and h runs +1 -> -1 through stance, and odometry advances by
 * the same exp(dh * xi) as the planted tripod's h falls. Body speed therefore follows the
 * sinusoidal foot speed; its mean at a full stride is GAIT.cmPerSecAtMax.
 */
import { STANCE, type Vec3 } from './kinematics';

export interface GaitState {
  /** Gait phase in cycles, [0, 1). */
  t: number;
  feet: Vec3[];
  /** World odometry: x, y in cm, heading in radians (counter-clockwise, 0 = start facing +y). */
  odom: { x: number; y: number; heading: number };
}

export interface Velocity {
  vx: number;
  vy: number;
  omega: number;
}

export const GAIT = { minPeriodMs: 400 /* firmware move_time >= 400 */, lift: 3, maxHalfStep: 3, cmPerSecAtMax: 20 };

/** Robot::move default `time` (move_time) for C commands. */
const BASE_PERIOD_MS = 600;
/** Firmware STOP state moves the feet back over 300ms; ~4.3cm worst case. */
const RETURN_CM_PER_MS = 0.02;
const EPS = 1e-6;
const TRIPOD_A = new Set([0, 2, 4]);

/** Robot::reset body height (cm), the height the brief's GAIT.lift refers to. */
export const DEFAULT_BODY_Z = 1;
/**
 * cal_omni_move_end_point leg lift (level body) per body-z band [0,1), [1,2), [2,3]:
 * linear in step length from the first value (no step) to the second (maxHalfStep).
 * At the default height and a full stride this is GAIT.lift.
 */
const LIFT_BANDS: [number, number][] = [
  [1.3, 2.0],
  [2.5, GAIT.lift],
  [3.0, 3.5],
];

// TODO: the firmware switches to a lower lift table when the attitude is non-zero (pitch != 0
// while walking): bands [1.3, 1.7], [1.7, 2.3], [2.0, 3.0] (hiwonder_robot.cpp 528-538).
function liftCm(step: number, bodyZ: number): number {
  const [lo, hi] = LIFT_BANDS[bodyZ < 1 ? 0 : bodyZ < 2 ? 1 : 2]!;
  return lo + ((hi - lo) * step) / GAIT.maxHalfStep;
}

const isMoving = (v: Velocity) => Math.abs(v.vx) > EPS || Math.abs(v.vy) > EPS || Math.abs(v.omega) > EPS;

/** Firmware step_length: |(vx, vy)|, or |omega| when turning in place. */
function rawStep(v: Velocity): number {
  const lin = Math.hypot(v.vx, v.vy);
  return lin > EPS ? lin : Math.abs(v.omega);
}

/** Firmware move_time: 600ms, shortened when the step exceeds maxHalfStep, never below 400ms. */
export function gaitPeriodMs(v: Velocity): number {
  const raw = rawStep(v);
  if (raw <= GAIT.maxHalfStep) return BASE_PERIOD_MS;
  return Math.max(GAIT.minPeriodMs, BASE_PERIOD_MS / (raw / GAIT.maxHalfStep));
}

type Twist = { x: number; y: number; theta: number };

/**
 * Body twist per half step (cm, cm, rad): the body velocity (v, omega) scaled so the farthest
 * moving foot (|v + omega x p| over STANCE) steps exactly step_length, as
 * cal_omni_move_end_point does.
 */
function halfStep(v: Velocity): { xi: Twist; step: number } {
  const step = Math.min(rawStep(v), GAIT.maxHalfStep);
  const longest = Math.max(...STANCE.map((p) => Math.hypot(v.vx - v.omega * p.y, v.vy + v.omega * p.x)));
  const k = step / longest;
  return { xi: { x: k * v.vx, y: k * v.vy, theta: k * v.omega }, step };
}

/** SE(2) exponential of s * xi: the rigid motion after moving along twist xi for s units. */
function expTwist(xi: Twist, s: number): Twist {
  const th = xi.theta * s;
  const [vx, vy] = [xi.x * s, xi.y * s];
  if (Math.abs(th) < 1e-9) return { x: vx, y: vy, theta: th };
  const a = Math.sin(th) / th;
  const b = (1 - Math.cos(th)) / th;
  return { x: a * vx - b * vy, y: b * vx + a * vy, theta: th };
}

const rotate = (x: number, y: number, th: number) => ({
  x: x * Math.cos(th) - y * Math.sin(th),
  y: x * Math.sin(th) + y * Math.cos(th),
});

/** Monotone stance progress: the planted tripod's h falls by 2 per half cycle (4 per cycle). */
function progress(cycles: number): number {
  const halves = Math.floor(cycles * 2);
  return 2 * halves + 1 - Math.cos(2 * Math.PI * cycles - Math.PI * halves);
}

export function initGait(): GaitState {
  return { t: 0, feet: STANCE.map((f) => ({ ...f })), odom: { x: 0, y: 0, heading: 0 } };
}

function returnToStance(feet: Vec3[], dtMs: number): Vec3[] {
  const maxMove = RETURN_CM_PER_MS * dtMs;
  return feet.map((f, i) => {
    const home = STANCE[i]!;
    const d = Math.hypot(home.x - f.x, home.y - f.y, home.z - f.z);
    if (d <= maxMove) return { ...home };
    const k = maxMove / d;
    return { x: f.x + (home.x - f.x) * k, y: f.y + (home.y - f.y) * k, z: f.z + (home.z - f.z) * k };
  });
}

/**
 * Advance the gait by dtMs at velocity `vel` (firmware units: vx, vy in -3..3, omega as from C).
 * `bodyZ` (cm above the neutral stance) picks the firmware's leg-lift band.
 */
export function stepGait(s: GaitState, dtMs: number, vel: Velocity, bodyZ = DEFAULT_BODY_Z): GaitState {
  if (!isMoving(vel)) return { t: 0, feet: returnToStance(s.feet, dtMs), odom: s.odom };

  const period = gaitPeriodMs(vel);
  const cycles = s.t + dtMs / period;
  const t = cycles % 1;
  const phi = 2 * Math.PI * t;
  const { xi, step } = halfStep(vel);
  const liftH = liftCm(step, bodyZ);
  const feet = STANCE.map((home, i) => {
    const a = TRIPOD_A.has(i);
    const h = a ? -Math.cos(phi) : Math.cos(phi);
    const lift = Math.max(0, a ? Math.sin(phi) : -Math.sin(phi));
    const g = expTwist(xi, h);
    const p = rotate(home.x, home.y, g.theta);
    return { x: p.x + g.x, y: p.y + g.y, z: home.z + liftH * lift };
  });

  const g = expTwist(xi, progress(cycles) - progress(s.t));
  const d = rotate(g.x, g.y, s.odom.heading);
  const odom = { x: s.odom.x + d.x, y: s.odom.y + d.y, heading: s.odom.heading + g.theta };
  return { t, feet, odom };
}
