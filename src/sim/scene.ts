/**
 * three.js view of the simulated miniHexa.
 *
 * Everything robot-related lives in a z-up group (`world`) that uses the kinematics frames
 * directly (+x right, +y forward, +z up, cm); the group is rotated so z-up maps to three's y-up.
 */
import * as THREE from 'three';
import { LEG_MOUNT_ANGLE, LEG_ORIGINS, LINK, STANCE, type JointAngles } from './kinematics';
import type { SimFrame } from './robotModel';

const BODY = { w: 7.6, l: 14, h: 2.4 };
const GROUND_Z = STANCE[0]!.z;
const GRID_CELL = 10;
const GRID_SIZE = 400;
const DEG = Math.PI / 180;
const CAMERA_OFFSET = new THREE.Vector3(22, 30, 40); // three's frame: behind, above and right of the start heading
const UP = new THREE.Vector3(0, 1, 0);

/** Leg chain points (hip, coxa end, knee, foot) in the leg frame. */
function legPoints(j: JointAngles): THREE.Vector3[] {
  const { l1, l2, l3 } = LINK;
  const ca = Math.cos(j.a);
  const sa = Math.sin(j.a);
  const at = (r: number, z: number) => new THREE.Vector3(r * ca, r * sa, z);
  const r2 = l1 + l2 * Math.cos(j.b);
  const z2 = l2 * Math.sin(j.b);
  return [at(0, 0), at(l1, 0), at(r2, z2), at(r2 + l3 * Math.cos(j.b - j.c), z2 + l3 * Math.sin(j.b - j.c))];
}

function placeSegment(mesh: THREE.Mesh, a: THREE.Vector3, b: THREE.Vector3): void {
  const d = b.clone().sub(a);
  const len = d.length();
  mesh.position.copy(a).addScaledVector(d, 0.5);
  mesh.scale.set(1, Math.max(len, 1e-3), 1);
  if (len > 1e-6) mesh.quaternion.setFromUnitVectors(UP, d.divideScalar(len));
}

export function createScene(canvas: HTMLCanvasElement): { render(f: SimFrame): void; resize(): void } {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1d2228);
  const camera = new THREE.PerspectiveCamera(45, 1, 0.5, 2000);

  scene.add(new THREE.HemisphereLight(0xffffff, 0x334455, 1.6));
  const sun = new THREE.DirectionalLight(0xffffff, 1.8);
  sun.position.set(30, 60, 20);
  scene.add(sun);

  const world = new THREE.Group();
  world.rotation.x = -Math.PI / 2; // z-up -> y-up
  scene.add(world);

  const grid = new THREE.GridHelper(GRID_SIZE, GRID_SIZE / GRID_CELL, 0x5a6672, 0x39424c);
  grid.rotation.x = Math.PI / 2; // GridHelper lies in its xz plane; ours is xy
  grid.position.z = GROUND_Z;
  world.add(grid);

  /** Odometry: world position and heading. */
  const odomGroup = new THREE.Group();
  world.add(odomGroup);
  /** Body pose relative to the neutral stance. */
  const bodyGroup = new THREE.Group();
  odomGroup.add(bodyGroup);

  const bodyMesh = new THREE.Mesh(
    new THREE.BoxGeometry(BODY.w, BODY.l, BODY.h),
    new THREE.MeshStandardMaterial({ color: 0x3b82c4, roughness: 0.6 }),
  );
  bodyGroup.add(bodyMesh);
  const nose = new THREE.Mesh(
    new THREE.BoxGeometry(3, 1, 0.6),
    new THREE.MeshStandardMaterial({ color: 0xe8edf2 }),
  );
  nose.position.set(0, BODY.l / 2 - 0.6, BODY.h / 2 + 0.3);
  bodyGroup.add(nose);

  const ledMat = new THREE.MeshStandardMaterial({ color: 0x00edb2, emissive: 0x00edb2, emissiveIntensity: 0.8 });
  const led = new THREE.Mesh(new THREE.SphereGeometry(0.9, 20, 14), ledMat);
  led.position.set(0, -BODY.l / 2 + 2, BODY.h / 2 + 0.6);
  bodyGroup.add(led);

  const legMat = new THREE.MeshStandardMaterial({ color: 0xc9d1d9, roughness: 0.5 });
  const radii = [0.55, 0.45, 0.35];
  const legs = LEG_ORIGINS.map((o, i) => {
    const g = new THREE.Group();
    g.position.set(o.x, o.y, o.z);
    g.rotation.z = LEG_MOUNT_ANGLE[i]!;
    bodyGroup.add(g);
    const segs = radii.map((r) => {
      const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 1, 12), legMat);
      g.add(m);
      return m;
    });
    return segs;
  });

  const robotPos = new THREE.Vector3();

  function resize(): void {
    const w = canvas.clientWidth || 1;
    const h = canvas.clientHeight || 1;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  function render(f: SimFrame): void {
    odomGroup.position.set(f.odom.x, f.odom.y, 0);
    odomGroup.rotation.z = f.odom.heading;
    bodyGroup.position.set(f.body.x, f.body.y, f.body.z);
    // kinematics rotation(): R = Rz(yaw) * Rx(pitch) * Ry(roll) -> three Euler order 'ZXY'
    bodyGroup.rotation.set(f.body.pitch * DEG, f.body.roll * DEG, f.body.yaw * DEG, 'ZXY');

    f.joints.forEach((j, i) => {
      const segs = legs[i];
      if (!segs) return;
      const p = legPoints(j);
      segs.forEach((m, k) => placeSegment(m, p[k]!, p[k + 1]!));
    });

    const [r, g, b] = f.led;
    ledMat.color.setRGB(r / 255, g / 255, b / 255, THREE.SRGBColorSpace);
    ledMat.emissive.copy(ledMat.color);

    // Keep the finite grid under the robot.
    grid.position.x = Math.round(f.odom.x / GRID_CELL) * GRID_CELL;
    grid.position.y = Math.round(f.odom.y / GRID_CELL) * GRID_CELL;

    world.updateMatrixWorld();
    odomGroup.getWorldPosition(robotPos);
    camera.position.copy(robotPos).add(CAMERA_OFFSET);
    camera.lookAt(robotPos);
    renderer.render(scene, camera);
  }

  resize();
  return { render, resize };
}
