/**
 * Simulated miniHexa: consumes the same RobotCommand stream as the real robot and mirrors the
 * firmware's command semantics (vendor/app_firmware/remote/remote.ino, hiwonder_robot.cpp).
 * Kinematic visualisation only, no physics.
 *
 * Two layers of state, as in the firmware:
 * - "latched": remote.ino's global vel/pos/att, re-sent to Robot::move by every C and F.
 * - "robot": what Robot is currently doing (actions and avoid drive it without touching the latch).
 */
import { BUILTIN_ACTIONS, STORED_ACTION_LOCK_MS, actionDurationMs, type ActionStep } from '../control/actions';
import type { RobotCommand } from '../protocol/commands';
import { initGait, stepGait, type GaitState, type Velocity } from './gait';
import { STANCE, applyBodyPose, bodyToLeg, ikLeg, type BodyPose, type JointAngles } from './kinematics';

export interface SimFrame {
  joints: JointAngles[];
  body: BodyPose;
  odom: GaitState['odom'];
  led: [number, number, number];
  busyUntil: number | null;
}

type MoveCommand = Extract<RobotCommand, { kind: 'move' }>;
type PoseCommand = Extract<RobotCommand, { kind: 'pose' }>;

const ZERO_VEL: Velocity = { vx: 0, vy: 0, omega: 0 };
const NEUTRAL: BodyPose = { x: 0, y: 0, z: 0, pitch: 0, roll: 0, yaw: 0 };
/** Robot::reset: pos {0, 0, 1}, att 0, over 600ms. */
const RESET_POSE: BodyPose = { ...NEUTRAL, z: 1 };
/** Robot::begin LED colour. */
const DEFAULT_LED: [number, number, number] = [0, 237, 178];
/** Robot::move default time; F while standing uses 200. */
const MOVE_MS = 600;
const POSE_STILL_MS = 200;
const AVOID_VEL: Velocity = { vx: 0, vy: 2, omega: 0 };
const SUBSTEP_MS = 10;
const STORED_ACTION: ActionStep[] = [
  { att: { pitch: 0, roll: 0, yaw: 0 }, pos: 'keep', moveMs: MOVE_MS, holdMs: STORED_ACTION_LOCK_MS },
];

const fmap = (v: number, inMin: number, inMax: number, outMin: number, outMax: number) =>
  ((v - inMin) * (outMax - outMin)) / (inMax - inMin) + outMin;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const isMoving = (v: Velocity) => v.vx !== 0 || v.vy !== 0 || v.omega !== 0;

/** remote.ino MINIHEXA_MOVING_CONTROL. */
export function commandToVelocity(cmd: MoveCommand): Velocity {
  const vx = fmap(cmd.vx, -50, 50, -3, 3);
  const vy = fmap(cmd.vy, -50, 50, -3, 3);
  const still = vx === 0 && vy === 0;
  const omega = cmd.turn === 1 ? (still ? 2.5 : 0.2) : cmd.turn === 2 ? (still ? -2.5 : -0.2) : 0;
  return { vx: vx + 0, vy: vy + 0, omega };
}

/** remote.ino MINIHEXA_POSE_CONTROL, with Robot::move's yaw limit of ±20°. */
export function poseCommandToBodyPose(cmd: PoseCommand): BodyPose {
  const z = fmap(cmd.z, 0, 30, 0, 3);
  const [rollMax, pitchMax] = z < 1 ? [10, 5] : z < 2 ? [15, 8.3] : [20, 12.5];
  return {
    x: fmap(cmd.x, -50, 50, -3, 3),
    y: fmap(cmd.y, -50, 50, -3, 3),
    z,
    pitch: fmap(cmd.pitch, -50, 50, -pitchMax, pitchMax),
    roll: fmap(cmd.roll, -50, 50, -rollMax, rollMax),
    yaw: clamp(fmap(-cmd.yaw, -50, 50, -60, 60), -20, 20) + 0,
  };
}

interface Tween {
  from: BodyPose;
  to: BodyPose;
  start: number;
  dur: number;
}

interface RunningAction {
  steps: ActionStep[];
  /** Start time of each step: the firmware calls move() then delay(holdMs). */
  starts: number[];
  index: number;
  walkUntil: number;
}

export class SimRobot {
  private time: number | null = null;
  private gait: GaitState = initGait();
  private led: [number, number, number] = [...DEFAULT_LED];
  private latchedVel: Velocity = ZERO_VEL;
  private latchedPose: BodyPose = NEUTRAL;
  private vel: Velocity = ZERO_VEL;
  private tween: Tween = { from: NEUTRAL, to: NEUTRAL, start: 0, dur: 0 };
  private action: RunningAction | null = null;
  private busyUntil: number | null = null;
  private pending: RobotCommand | null = null;
  private joints: JointAngles[] = STANCE.map((f, i) => ikLeg(bodyToLeg(i, f))!);

  apply(cmd: RobotCommand, now: number): void {
    this.advanceTo(now);
    if (this.busyUntil !== null) {
      this.pending = cmd; // the firmware keeps only the latest message while an action blocks
      return;
    }
    this.handle(cmd, now);
  }

  tick(now: number): SimFrame {
    this.advanceTo(now);
    const body = this.poseAt(now);
    const feet = applyBodyPose(this.gait.feet, body);
    this.joints = feet.map((f, i) => ikLeg(bodyToLeg(i, f)) ?? this.joints[i]!);
    return {
      joints: this.joints.map((j) => ({ ...j })),
      body,
      odom: { ...this.gait.odom },
      led: [...this.led],
      busyUntil: this.busyUntil,
    };
  }

  private handle(cmd: RobotCommand, now: number): void {
    switch (cmd.kind) {
      case 'move':
        this.latchedVel = commandToVelocity(cmd);
        this.drive(this.latchedVel, this.latchedPose, now, MOVE_MS);
        break;
      case 'pose':
        this.latchedPose = poseCommandToBodyPose(cmd);
        this.drive(this.latchedVel, this.latchedPose, now, isMoving(this.latchedVel) ? MOVE_MS : POSE_STILL_MS);
        break;
      case 'action':
        this.startAction(cmd.id, now);
        break;
      case 'led':
        this.led = [cmd.r, cmd.g, cmd.b];
        break;
      case 'avoid':
        if (cmd.on) {
          this.drive(AVOID_VEL, this.tween.to, now, MOVE_MS);
        } else {
          this.latchedVel = ZERO_VEL;
          this.drive(ZERO_VEL, this.latchedPose, now, MOVE_MS);
        }
        break;
      case 'balance':
        // Flat ground: balancing never changes the attitude. Turning it off zeroes the latched att
        // and calls minihexa.move(&vel, &pos, &att) with the latched vel (remote.ino
        // MINIHEXA_BALANCE). Avoid never touches that vel, so J|0 during avoid replaces the avoid
        // walk with the last C velocity (standing still if none).
        if (!cmd.on) {
          this.latchedPose = { ...this.latchedPose, pitch: 0, roll: 0, yaw: 0 };
          this.drive(this.latchedVel, this.latchedPose, now, MOVE_MS);
        }
        break;
      case 'reset':
        this.latchedVel = ZERO_VEL;
        this.latchedPose = RESET_POSE;
        this.drive(ZERO_VEL, RESET_POSE, now, MOVE_MS);
        break;
    }
  }

  /** Robot::move: set the velocity and blend the body to `pose` (roll and yaw are zeroed while walking). */
  private drive(vel: Velocity, pose: BodyPose, now: number, durMs: number): void {
    this.vel = vel;
    const to = isMoving(vel) ? { ...pose, roll: 0, yaw: 0 } : { ...pose, yaw: clamp(pose.yaw, -20, 20) };
    this.tween = { from: this.poseAt(now), to, start: now, dur: durMs };
  }

  private poseAt(t: number): BodyPose {
    const { from, to, start, dur } = this.tween;
    const k = dur <= 0 ? 1 : clamp((t - start) / dur, 0, 1);
    const mix = (key: keyof BodyPose) => from[key] + (to[key] - from[key]) * k;
    return { x: mix('x'), y: mix('y'), z: mix('z'), pitch: mix('pitch'), roll: mix('roll'), yaw: mix('yaw') };
  }

  private startAction(id: number, now: number): void {
    const steps = BUILTIN_ACTIONS.find((a) => a.id === id)?.steps ?? STORED_ACTION;
    const starts: number[] = [];
    let t = now;
    for (const s of steps) {
      starts.push(t);
      t += s.holdMs;
    }
    this.action = { steps, starts, index: -1, walkUntil: now };
    this.busyUntil = now + actionDurationMs(id);
    this.vel = ZERO_VEL;
    this.updateAction(now);
  }

  private updateAction(t: number): void {
    const a = this.action!;
    while (a.index + 1 < a.steps.length && a.starts[a.index + 1]! <= t) {
      a.index++;
      const step = a.steps[a.index]!;
      const t0 = a.starts[a.index]!;
      const cur = this.poseAt(t0);
      const pos = step.pos === 'keep' ? { x: cur.x, y: cur.y } : step.pos;
      const v = step.vel ?? ZERO_VEL;
      // Robot::move counts one step per gait period, move_time = max(400, moveMs): wake_up walks
      // 10 steps at 500ms = 5000ms. The sim gait runs at gaitPeriodMs (600ms at vy 1.5), so it
      // covers ~8.3 cycles in that window rather than 10; the duration matches, the distance not.
      if (step.vel) a.walkUntil = t0 + step.vel.steps * Math.max(400, step.moveMs);
      this.drive({ vx: v.vx, vy: v.vy, omega: v.omega }, { ...cur, ...pos, ...step.att }, t0, step.moveMs);
    }
    if (t >= a.walkUntil) this.vel = ZERO_VEL;
  }

  /** The action has returned: the robot stands still; the latched vel/pose wait for the next C or F. */
  private finishAction(): void {
    this.action = null;
    this.busyUntil = null;
    this.vel = ZERO_VEL;
  }

  private advanceTo(now: number): void {
    if (this.time === null) this.time = now;
    while (this.busyUntil !== null && now >= this.busyUntil) {
      const end = this.busyUntil;
      this.integrate(end);
      this.finishAction();
      const next = this.pending;
      this.pending = null;
      if (next) this.handle(next, end);
    }
    this.integrate(now);
  }

  private integrate(to: number): void {
    while (this.time! < to) {
      const t = this.time!;
      const dt = Math.min(SUBSTEP_MS, to - t);
      if (this.action) this.updateAction(t);
      this.gait = stepGait(this.gait, dt, this.vel, this.poseAt(t).z);
      this.time = t + dt;
    }
  }
}
