/**
 * Tripod gait, approximating the firmware's sinusoidal crawl
 * (vendor/app_firmware/remote/hiwonder_robot.cpp Robot::update 258-395,
 * cal_omni_move_end_point 467-587, move 588-636).
 *
 * Feet are in the neutral body frame (cm). Legs {0,2,4} (L1, L3, L5) and {1,3,5} alternate.
 * Phase `t` is in gait cycles [0, 1). This phase is the firmware's tick_count shifted by a
 * quarter cycle so that a cycle starts with both tripods down and tripod A lifts first.
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

export const GAIT = { minPeriodMs: 400 /* firmware move_time >= 400 */, lift: 3, maxHalfStep: 3, cmPerSecAtMax: 15 };

/** Robot::move default `time` (move_time) for C commands. */
const BASE_PERIOD_MS = 600;
/** Firmware STOP state moves the feet back over 300ms; ~4.3cm worst case. */
const RETURN_CM_PER_MS = 0.02;
const EPS = 1e-6;
const TRIPOD_A = new Set([0, 2, 4]);
/**
 * Kinematically a full stride moves the body 4 * maxHalfStep per period (20 cm/s).
 * GAIT.cmPerSecAtMax is the expected real speed, so odometry is scaled down (foot slip).
 */
const ODOM_SCALE = GAIT.cmPerSecAtMax / ((4 * GAIT.maxHalfStep) / (BASE_PERIOD_MS / 1000));

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

/**
 * Per-foot half-step vectors and the body twist they produce per half step.
 * Each foot moves along the body's instantaneous velocity at that foot (v + omega x p), scaled
 * so the farthest-moving foot steps exactly step_length (as cal_omni_move_end_point does).
 */
function stride(v: Velocity): { amps: { x: number; y: number }[]; scale: number; step: number } {
  const step = Math.min(rawStep(v), GAIT.maxHalfStep);
  const dirs = STANCE.map((p) => ({ x: v.vx - v.omega * p.y, y: v.vy + v.omega * p.x }));
  const longest = Math.max(...dirs.map((d) => Math.hypot(d.x, d.y)));
  const scale = step / longest;
  return { amps: dirs.map((d) => ({ x: d.x * scale, y: d.y * scale })), scale, step };
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
  const t = (s.t + dtMs / period) % 1;
  const phi = 2 * Math.PI * t;
  const { amps, scale, step } = stride(vel);
  const liftH = liftCm(step, bodyZ);
  const feet = STANCE.map((home, i) => {
    const a = TRIPOD_A.has(i);
    const h = a ? -Math.cos(phi) : Math.cos(phi);
    const lift = Math.max(0, a ? Math.sin(phi) : -Math.sin(phi));
    const amp = amps[i]!;
    return { x: home.x + amp.x * h, y: home.y + amp.y * h, z: home.z + liftH * lift };
  });

  // Body moves 2 half-steps per half period: 4 * scale * (v, omega) per period.
  const k = (ODOM_SCALE * 4 * scale * dtMs) / period;
  const dHeading = k * vel.omega;
  const h = s.odom.heading + dHeading / 2;
  const [bx, by] = [k * vel.vx, k * vel.vy];
  const odom = {
    x: s.odom.x + bx * Math.cos(h) - by * Math.sin(h),
    y: s.odom.y + bx * Math.sin(h) + by * Math.cos(h),
    heading: s.odom.heading + dHeading,
  };
  return { t, feet, odom };
}
