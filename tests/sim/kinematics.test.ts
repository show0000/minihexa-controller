import { describe, expect, it } from 'vitest';
import {
  LEG_MOUNT_ANGLE,
  LEG_ORIGINS,
  LINK,
  STANCE,
  applyBodyPose,
  bodyToLeg,
  fkLeg,
  ikLeg,
  type JointAngles,
  type Vec3,
} from '../../src/sim/kinematics';

const close = (a: number, b: number, eps = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(eps);
const closeJ = (a: JointAngles, b: JointAngles) => {
  close(a.a, b.a);
  close(a.b, b.b);
  close(a.c, b.c);
};
const closeV = (a: Vec3, b: Vec3, eps = 1e-6) => {
  close(a.x, b.x, eps);
  close(a.y, b.y, eps);
  close(a.z, b.z, eps);
};

describe('leg geometry', () => {
  it('uses the firmware link lengths and leg origins', () => {
    expect(LINK).toEqual({ l1: 2.85, l2: 3.7, l3: 7.2 });
    expect(LEG_ORIGINS).toEqual([
      { x: 3.15, y: -5.65, z: 0 },
      { x: 4.34, y: 0, z: 0 },
      { x: 3.15, y: 5.65, z: 0 },
      { x: -3.15, y: 5.65, z: 0 },
      { x: -4.34, y: 0, z: 0 },
      { x: -3.15, y: -5.65, z: 0 },
    ]);
    // Firmware leg frames: hiwonder_robot.cpp 215-227 (rotations), 580-585 (inverse).
    [-45, 0, 45, 135, 180, -135].forEach((deg, i) => close(LEG_MOUNT_ANGLE[i]!, (deg * Math.PI) / 180));
  });
});

describe('ikLeg / fkLeg', () => {
  const samples: JointAngles[] = [
    { a: 0, b: 0, c: Math.PI / 2 },
    { a: 0.3, b: 0.4, c: 1.8 },
    { a: -0.5, b: -0.2, c: 1.2 },
    { a: 0.8, b: 0.9, c: 2.5 },
    { a: -0.1, b: 0.1, c: 0.3 },
    { a: 0.2, b: -0.6, c: 0.9 },
  ];
  it.each(samples)('round-trips %o', (j) => {
    const back = ikLeg(fkLeg(j));
    expect(back).not.toBeNull();
    closeJ(back!, j);
  });

  it('round-trips every STANCE foot', () => {
    expect(STANCE).toHaveLength(6);
    STANCE.forEach((foot, i) => {
      const local = bodyToLeg(i, foot);
      const j = ikLeg(local);
      expect(j, `leg ${i}`).not.toBeNull();
      closeV(fkLeg(j!), local);
      closeJ(ikLeg(fkLeg(j!))!, j!);
    });
  });

  it('puts every STANCE foot straight out along its leg frame (joint a = 0)', () => {
    STANCE.forEach((foot, i) => {
      const j = ikLeg(bodyToLeg(i, foot))!;
      expect(Math.abs(j.a), `leg ${i}`).toBeLessThan(1e-9);
    });
  });

  it('bends the knee so the foot is below the femur tip (knee up, foot down)', () => {
    const j = ikLeg(bodyToLeg(1, STANCE[1]!))!;
    expect(j.c).toBeGreaterThan(0);
  });

  it('returns null beyond full reach', () => {
    const r = LINK.l1 + LINK.l2 + LINK.l3 + 0.1;
    expect(ikLeg({ x: r, y: 0, z: 0 })).toBeNull();
    expect(ikLeg({ x: 0, y: r, z: 0 })).toBeNull();
    expect(ikLeg({ x: r * Math.SQRT1_2, y: 0, z: -r * Math.SQRT1_2 })).toBeNull();
  });
});

describe('bodyToLeg', () => {
  it('puts a point straight out from the hip on the leg x axis', () => {
    LEG_ORIGINS.forEach((o, i) => {
      const m = LEG_MOUNT_ANGLE[i]!;
      const p = { x: o.x + 5 * Math.cos(m), y: o.y + 5 * Math.sin(m), z: -2 };
      closeV(bodyToLeg(i, p), { x: 5, y: 0, z: -2 });
    });
  });
});

describe('applyBodyPose', () => {
  const zero = { x: 0, y: 0, z: 0, pitch: 0, roll: 0, yaw: 0 };
  it('is identity at the neutral pose', () => {
    applyBodyPose(STANCE, zero).forEach((f, i) => closeV(f, STANCE[i]!));
  });
  it('raising the body lowers the feet in the body frame', () => {
    applyBodyPose(STANCE, { ...zero, z: 2 }).forEach((f, i) =>
      closeV(f, { ...STANCE[i]!, z: STANCE[i]!.z - 2 }),
    );
  });
  it('shifting the body moves the feet the other way', () => {
    applyBodyPose(STANCE, { ...zero, x: 1, y: -2 }).forEach((f, i) =>
      closeV(f, { x: STANCE[i]!.x - 1, y: STANCE[i]!.y + 2, z: STANCE[i]!.z }),
    );
  });
  it('yawing the body rotates the feet the other way', () => {
    const [f] = applyBodyPose([{ x: 1, y: 0, z: 0 }], { ...zero, yaw: 90 });
    closeV(f!, { x: 0, y: -1, z: 0 });
  });
  it('pitching nose up (+pitch) puts front feet further below the body', () => {
    const feet = applyBodyPose(STANCE, { ...zero, pitch: 10 });
    // nose up: the front of the body rises, so front feet sit further below it
    expect(feet[2]!.z).toBeLessThan(STANCE[2]!.z);
    expect(feet[0]!.z).toBeGreaterThan(STANCE[0]!.z);
  });
  it('rolling (+roll) lowers the right side (x > 0) relative to the feet', () => {
    const feet = applyBodyPose(STANCE, { ...zero, roll: 10 });
    expect(feet[1]!.z).toBeGreaterThan(STANCE[1]!.z);
    expect(feet[4]!.z).toBeLessThan(STANCE[4]!.z);
  });
});
