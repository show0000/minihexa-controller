/**
 * miniHexa leg kinematics for the simulator (units: cm, radians unless noted).
 *
 * Body frame: +x right, +y forward, +z up, origin at the body centre on the hip plane.
 * Leg frame: origin at the hip (LEG_ORIGINS[i]), +x straight out along LEG_MOUNT_ANGLE[i],
 * +z up, +y completing a right-handed frame.
 *
 * The firmware IK (vendor/kinematics) is a binary blob, so this is an independent analytic
 * 3DOF solution using the published link lengths.
 */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** a: coxa yaw about the hip, b: femur lift above horizontal, c: knee bend (tibia below femur). */
export interface JointAngles {
  a: number;
  b: number;
  c: number;
}

/** Body pose relative to the neutral stance: x, y, z in cm, pitch/roll/yaw in degrees. */
export interface BodyPose {
  x: number;
  y: number;
  z: number;
  pitch: number;
  roll: number;
  yaw: number;
}

/** kinematics.h: BODY_TOP_LEN, TOP_MIDDLE_LEN, MIDDLE_BASE_LEN. */
export const LINK = { l1: 2.85, l2: 3.7, l3: 7.2 };

/** hiwonder_robot.h LEG1..LEG6_START_X/Y. */
export const LEG_ORIGINS: Vec3[] = [
  { x: 3.15, y: -5.65, z: 0 },
  { x: 4.34, y: 0, z: 0 },
  { x: 3.15, y: 5.65, z: 0 },
  { x: -3.15, y: 5.65, z: 0 },
  { x: -4.34, y: 0, z: 0 },
  { x: -3.15, y: -5.65, z: 0 },
];

/**
 * Leg frame x-axis direction per leg (radians): the firmware rotates L1..L6 by -45, 0, 45, 135,
 * 180, -135 degrees (hiwonder_robot.cpp 215-227; inverse rotations in cal_omni_move_end_point
 * 580-585). Note this is not atan2 of the hip position (about ±61° / ±119° for the corner legs).
 */
export const LEG_MOUNT_ANGLE: number[] = [-45, 0, 45, 135, 180, -135].map((d) => (d * Math.PI) / 180);

/**
 * Neutral foot positions in the body frame (body z offset 0). Each foot lies straight out along
 * its leg frame x-axis (joint a = 0, as the firmware's r_leg_end; hiwonder_robot.cpp 222-234), but sits a
 * little further out and lower than the firmware default (Leg::start_point = {6.5, 0, -4}):
 * with this IK the firmware stance folds the knee past its limit when a lifted swing foot passes
 * under the hip at body z 0. 7cm / -4.5cm keeps every foot between ~34% and ~95% of the femur +
 * tibia span over body z 0..3cm and full 3cm half steps (see tests/sim/gait.test.ts).
 */
const STANCE_REACH = 7;
const STANCE_HEIGHT = -4.5;
export const STANCE: Vec3[] = LEG_ORIGINS.map((o, i) => {
  const d = LEG_MOUNT_ANGLE[i]!;
  return { x: o.x + STANCE_REACH * Math.cos(d), y: o.y + STANCE_REACH * Math.sin(d), z: STANCE_HEIGHT };
});

/** Foot position in the leg frame for the given joint angles. */
export function fkLeg(j: JointAngles): Vec3 {
  const r = LINK.l1 + LINK.l2 * Math.cos(j.b) + LINK.l3 * Math.cos(j.b - j.c);
  const z = LINK.l2 * Math.sin(j.b) + LINK.l3 * Math.sin(j.b - j.c);
  return { x: r * Math.cos(j.a), y: r * Math.sin(j.a), z };
}

/** Analytic IK, knee bent so the tibia points below the femur (c in [0, pi]). Null if unreachable. */
export function ikLeg(foot: Vec3): JointAngles | null {
  const { l1, l2, l3 } = LINK;
  const a = Math.atan2(foot.y, foot.x);
  const r = Math.hypot(foot.x, foot.y) - l1;
  const d2 = r * r + foot.z * foot.z;
  const d = Math.sqrt(d2);
  if (d > l2 + l3 || d < Math.abs(l3 - l2)) return null;
  const cosC = (d2 - l2 * l2 - l3 * l3) / (2 * l2 * l3);
  const c = Math.acos(Math.min(1, Math.max(-1, cosC)));
  const b = Math.atan2(foot.z, r) + Math.atan2(l3 * Math.sin(c), l2 + l3 * Math.cos(c));
  return { a, b, c };
}

/** Body-frame point to leg i's frame. */
export function bodyToLeg(i: number, footBody: Vec3): Vec3 {
  const o = LEG_ORIGINS[i]!;
  const m = LEG_MOUNT_ANGLE[i]!;
  const dx = footBody.x - o.x;
  const dy = footBody.y - o.y;
  const cos = Math.cos(m);
  const sin = Math.sin(m);
  return { x: dx * cos + dy * sin, y: -dx * sin + dy * cos, z: footBody.z - o.z };
}

const DEG = Math.PI / 180;

/** Rotation matrix R = Rz(yaw) * Rx(pitch) * Ry(roll), row-major. */
function rotation(pose: BodyPose): number[] {
  const [cy, sy] = [Math.cos(pose.yaw * DEG), Math.sin(pose.yaw * DEG)];
  const [cp, sp] = [Math.cos(pose.pitch * DEG), Math.sin(pose.pitch * DEG)];
  const [cr, sr] = [Math.cos(pose.roll * DEG), Math.sin(pose.roll * DEG)];
  // Rx(p) * Ry(r)
  const m = [cr, 0, sr, sp * sr, cp, -sp * cr, -cp * sr, sp, cp * cr];
  // Rz(y) * m
  return [
    cy * m[0]! - sy * m[3]!, cy * m[1]! - sy * m[4]!, cy * m[2]! - sy * m[5]!,
    sy * m[0]! + cy * m[3]!, sy * m[1]! + cy * m[4]!, sy * m[2]! + cy * m[5]!,
    m[6]!, m[7]!, m[8]!,
  ];
}

/**
 * Feet stay planted at `feetWorld` (the neutral body frame) while the body translates by
 * (x, y, z) and rotates by (pitch about x: nose up, roll about y: right side down, yaw about z:
 * counter-clockwise). Returns the feet in the moved body's frame: R^T (foot - t).
 */
export function applyBodyPose(feetWorld: Vec3[], pose: BodyPose): Vec3[] {
  const R = rotation(pose);
  return feetWorld.map((f) => {
    const dx = f.x - pose.x;
    const dy = f.y - pose.y;
    const dz = f.z - pose.z;
    return {
      x: R[0]! * dx + R[3]! * dy + R[6]! * dz,
      y: R[1]! * dx + R[4]! * dy + R[7]! * dz,
      z: R[2]! * dx + R[5]! * dy + R[8]! * dz,
    };
  });
}
