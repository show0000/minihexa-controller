import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { LEG_MOUNT_ANGLE, LEG_ORIGINS, STANCE, bodyToLeg, fkLeg, ikLeg } from '../../src/sim/kinematics';
import { createRobotMesh } from '../../src/sim/robotMesh';
import type { SimFrame } from '../../src/sim/robotModel';

function frame(over: Partial<SimFrame> = {}): SimFrame {
  return {
    joints: STANCE.map((f, i) => ikLeg(bodyToLeg(i, f))!),
    body: { x: 0, y: 0, z: 0, pitch: 0, roll: 0, yaw: 0 },
    odom: { x: 0, y: 0, heading: 0 },
    led: [0, 237, 178],
    busyUntil: null,
    ...over,
  };
}

/** Foot in the body frame from the joint angles (leg frame -> body frame). */
function expectedFoot(i: number, f: SimFrame): THREE.Vector3 {
  const p = fkLeg(f.joints[i]!);
  const m = LEG_MOUNT_ANGLE[i]!;
  const o = LEG_ORIGINS[i]!;
  return new THREE.Vector3(o.x + p.x * Math.cos(m) - p.y * Math.sin(m), o.y + p.x * Math.sin(m) + p.y * Math.cos(m), o.z + p.z);
}

describe('createRobotMesh', () => {
  it('places every foot where fkLeg puts it', () => {
    const r = createRobotMesh();
    const f = frame();
    r.update(f);
    r.group.updateMatrixWorld(true);
    r.feet.forEach((foot, i) => {
      const got = foot.getWorldPosition(new THREE.Vector3());
      const want = expectedFoot(i, f);
      expect(got.distanceTo(want)).toBeLessThan(1e-6);
      // Neutral stance: the foot is on STANCE.
      expect(got.distanceTo(new THREE.Vector3(STANCE[i]!.x, STANCE[i]!.y, STANCE[i]!.z))).toBeLessThan(1e-3);
    });
  });

  it('puts the knees above the top plate in the standing pose', () => {
    const r = createRobotMesh();
    r.update(frame());
    r.group.updateMatrixWorld(true);
    for (const knee of r.knees) expect(knee.getWorldPosition(new THREE.Vector3()).z).toBeGreaterThan(1.5);
  });

  it('applies odometry to the whole robot', () => {
    const r = createRobotMesh();
    const f = frame({ odom: { x: 10, y: 20, heading: Math.PI / 2 } });
    r.update(f);
    r.group.updateMatrixWorld(true);
    const got = r.feet[1]!.getWorldPosition(new THREE.Vector3());
    const local = expectedFoot(1, f);
    // heading rotates counter-clockwise: (x, y) -> (-y, x)
    expect(got.x).toBeCloseTo(10 - local.y, 6);
    expect(got.y).toBeCloseTo(20 + local.x, 6);
  });
});
