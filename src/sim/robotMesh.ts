/**
 * Primitive-only model of the Hiwonder miniHexa (see visual-reference.md): black anodised plates,
 * dual-axis servo femurs whose knees stand above the top plate, flat tapered tibia brackets and
 * the glowing two-eyed ultrasonic sensor at the front (+y).
 *
 * The group is z-up and uses the kinematics frames directly (+x right, +y forward, cm).
 */
import * as THREE from 'three';
import { LEG_MOUNT_ANGLE, LEG_ORIGINS, LINK } from './kinematics';
import type { SimFrame } from './robotModel';

const DEG = Math.PI / 180;

/** Top plate outline: 8.7 wide, 14.1 long, narrowing to 7.7 at the front, chamfered corners. */
const PLATE = { w: 8.7, wFront: 7.7, l: 14.1, chamfer: 1.1, t: 0.2 };
const TOP_Z = 1.35;
const BOTTOM_Z = -1.55;

const COLORS = {
  plate: 0x24272b,
  edge: 0x6b737c,
  servo: 0x1b1d20,
  horn: 0x34383e,
  bracket: 0x2a2d31,
  foot: 0x4a4e54,
  sensor: 0x1e2023,
  ring: 0x3a3e44,
};

export interface RobotMesh {
  /** z-up robot root: odometry transform, then the body pose. */
  group: THREE.Group;
  update(frame: SimFrame): void;
  /** Foot tip and knee anchors per leg (for tests and debugging). */
  feet: THREE.Object3D[];
  knees: THREE.Object3D[];
}

function plateShape(withHoles: boolean): THREE.Shape {
  const { w, wFront, l, chamfer: c } = PLATE;
  const hb = w / 2;
  const hf = wFront / 2;
  const y0 = -l / 2;
  const y1 = l / 2;
  const s = new THREE.Shape();
  s.moveTo(-hb + c, y0);
  s.lineTo(hb - c, y0);
  s.lineTo(hb, y0 + c);
  s.lineTo(hb, y1 - 3);
  s.lineTo(hf, y1 - 2);
  s.lineTo(hf, y1 - c);
  s.lineTo(hf - c, y1);
  s.lineTo(-hf + c, y1);
  s.lineTo(-hf, y1 - c);
  s.lineTo(-hf, y1 - 2);
  s.lineTo(-hb, y1 - 3);
  s.lineTo(-hb, y0 + c);
  s.closePath();
  if (!withHoles) return s;
  const hole = (x: number, y: number, r: number) => {
    const p = new THREE.Path();
    p.absarc(x, y, r, 0, Math.PI * 2, true);
    s.holes.push(p);
  };
  const slot = (x: number, y: number, len: number, h: number) => {
    const p = new THREE.Path();
    p.moveTo(x - len / 2, y - h / 2);
    p.lineTo(x - len / 2, y + h / 2);
    p.lineTo(x + len / 2, y + h / 2);
    p.lineTo(x + len / 2, y - h / 2);
    p.closePath();
    s.holes.push(p);
  };
  for (const x of [-2.4, -0.8, 0.8, 2.4]) for (const y of [-2.4, 0, 2.4]) hole(x, y, 0.22);
  for (const y of [-5.2, -4.4, 4.4, 5.2]) {
    slot(-2.1, y, 1.8, 0.28);
    slot(2.1, y, 1.8, 0.28);
  }
  slot(0, -3.6, 1.4, 0.45);
  slot(0, 3.6, 1.4, 0.45);
  return s;
}

/** Tibia bracket outline along +x (knee at 0, foot at l3), tapering, with holes. */
function tibiaShape(): THREE.Shape {
  const l = LINK.l3;
  const s = new THREE.Shape();
  s.moveTo(-0.7, -0.75);
  s.lineTo(l * 0.55, -0.7);
  s.lineTo(l - 0.2, -0.3);
  s.lineTo(l - 0.2, 0.3);
  s.lineTo(l * 0.55, 0.7);
  s.lineTo(-0.7, 0.75);
  s.closePath();
  for (const x of [l * 0.35, l * 0.55, l * 0.72]) {
    const p = new THREE.Path();
    p.absarc(x, 0, 0.2, 0, Math.PI * 2, true);
    s.holes.push(p);
  }
  return s;
}

function mesh(geo: THREE.BufferGeometry, mat: THREE.Material): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = true;
  return m;
}

export function createRobotMesh(): RobotMesh {
  const mat = (color: number, roughness = 0.55, metalness = 0.35) =>
    new THREE.MeshStandardMaterial({ color, roughness, metalness });
  const plateMat = mat(COLORS.plate, 0.5, 0.45);
  const servoMat = mat(COLORS.servo, 0.6, 0.15);
  const hornMat = mat(COLORS.horn, 0.35, 0.7);
  const bracketMat = mat(COLORS.bracket, 0.45, 0.5);
  const footMat = mat(COLORS.foot, 0.9, 0);
  const sensorMat = mat(COLORS.sensor, 0.6, 0.2);
  const ringMat = mat(COLORS.ring, 0.3, 0.8);
  const eyeMat = new THREE.MeshStandardMaterial({ color: 0x00edb2, emissive: 0x00edb2, emissiveIntensity: 1.2 });
  const edgeMat = new THREE.LineBasicMaterial({ color: COLORS.edge });

  const group = new THREE.Group();
  const body = new THREE.Group();
  group.add(body);

  // Plates.
  const topGeo = new THREE.ExtrudeGeometry(plateShape(true), { depth: PLATE.t, bevelEnabled: false });
  const top = mesh(topGeo, plateMat);
  top.position.z = TOP_Z;
  top.add(new THREE.LineSegments(new THREE.EdgesGeometry(topGeo, 30), edgeMat));
  body.add(top);
  const bottomGeo = new THREE.ExtrudeGeometry(plateShape(false), { depth: PLATE.t, bevelEnabled: false });
  const bottom = mesh(bottomGeo, plateMat);
  bottom.position.z = BOTTOM_Z;
  bottom.add(new THREE.LineSegments(new THREE.EdgesGeometry(bottomGeo, 30), edgeMat));
  body.add(bottom);

  // ESP32 board + 18650 pack between the plates.
  const core = mesh(new THREE.BoxGeometry(4.6, 8.4, 2.5), servoMat);
  core.position.z = (TOP_Z + BOTTOM_Z + PLATE.t) / 2;
  body.add(core);
  for (const x of [-1.1, 1.1]) {
    const cell = mesh(new THREE.CylinderGeometry(0.9, 0.9, 6.5, 16), mat(0x2c3036, 0.4, 0.4));
    cell.position.set(x, -0.6, core.position.z - 0.2);
    body.add(cell);
  }

  // Ultrasonic sensor hanging under the front edge, two glowing eyes facing +y.
  const sensor = new THREE.Group();
  sensor.position.set(0, PLATE.l / 2 - 0.6, BOTTOM_Z - 0.9);
  body.add(sensor);
  sensor.add(mesh(new THREE.BoxGeometry(4.6, 1.8, 2.1), sensorMat));
  for (const x of [-1.1, 1.1]) {
    const ring = mesh(new THREE.CylinderGeometry(0.9, 0.9, 0.35, 24), ringMat);
    ring.position.set(x, 1.0, 0);
    sensor.add(ring);
    const eye = new THREE.Mesh(new THREE.CylinderGeometry(0.72, 0.72, 0.4, 24), eyeMat);
    eye.position.set(x, 1.05, 0);
    sensor.add(eye);
  }

  // Legs: hip -> coxa yaw (a) -> femur pitch (b) -> knee (c). Cylinders' default axis is y,
  // which is the leg frame's joint axis for b and c.
  const coxaGeo = new THREE.BoxGeometry(2.4, 1.3, 2.4);
  const femurGeo = new THREE.BoxGeometry(LINK.l2 + 1.4, 1.3, 2.2);
  const hornGeo = new THREE.CylinderGeometry(0.75, 0.75, 1.9, 24);
  const coxaHornGeo = new THREE.CylinderGeometry(0.6, 0.6, 2.8, 20);
  const linkGeo = new THREE.BoxGeometry(LINK.l1, 1.0, 0.25);
  const tibiaGeo = new THREE.ExtrudeGeometry(tibiaShape(), { depth: 0.25, bevelEnabled: false });
  tibiaGeo.translate(0, 0, -0.125);
  tibiaGeo.rotateX(Math.PI / 2); // shape plane (x, y) -> leg plane (x, z); thickness along y
  const footGeo = new THREE.SphereGeometry(0.38, 16, 12);

  const legs = LEG_ORIGINS.map((o, i) => {
    const root = new THREE.Group();
    root.position.set(o.x, o.y, o.z);
    root.rotation.z = LEG_MOUNT_ANGLE[i]!;
    body.add(root);

    const coxa = new THREE.Group();
    root.add(coxa);
    const coxaHorn = mesh(coxaHornGeo, hornMat);
    coxaHorn.rotation.x = Math.PI / 2; // vertical axis
    coxa.add(coxaHorn);
    const coxaServo = mesh(coxaGeo, servoMat);
    coxaServo.position.x = LINK.l1 * 0.55;
    coxa.add(coxaServo);
    for (const z of [-1.3, 1.3]) {
      const link = mesh(linkGeo, bracketMat);
      link.position.set(LINK.l1 / 2, 0, z);
      coxa.add(link);
    }

    const femur = new THREE.Group();
    femur.position.x = LINK.l1;
    coxa.add(femur);
    const femurServo = mesh(femurGeo, servoMat);
    femurServo.position.x = LINK.l2 / 2;
    femur.add(femurServo);
    for (const x of [0, LINK.l2]) {
      const horn = mesh(hornGeo, hornMat);
      horn.position.x = x;
      femur.add(horn);
    }

    const tibia = new THREE.Group();
    tibia.position.x = LINK.l2;
    femur.add(tibia);
    for (const y of [-0.5, 0.5]) {
      const plate = mesh(tibiaGeo, bracketMat);
      plate.position.y = y;
      tibia.add(plate);
    }
    const foot = mesh(footGeo, footMat);
    foot.position.x = LINK.l3;
    foot.scale.set(1.25, 0.9, 0.9);
    tibia.add(foot);

    return { coxa, femur, tibia, foot, knee: tibia };
  });

  function update(f: SimFrame): void {
    group.position.set(f.odom.x, f.odom.y, 0);
    group.rotation.z = f.odom.heading;
    body.position.set(f.body.x, f.body.y, f.body.z);
    // kinematics rotation(): R = Rz(yaw) * Rx(pitch) * Ry(roll) -> three Euler order 'ZXY'
    body.rotation.set(f.body.pitch * DEG, f.body.roll * DEG, f.body.yaw * DEG, 'ZXY');

    f.joints.forEach((j, i) => {
      const leg = legs[i];
      if (!leg) return;
      leg.coxa.rotation.z = j.a;
      // Rotation about +y by -b lifts +x towards +z (fkLeg: z = l2 sin b); the tibia sits at b - c.
      leg.femur.rotation.y = -j.b;
      leg.tibia.rotation.y = j.c;
    });

    const [r, g, b] = f.led;
    eyeMat.color.setRGB(r / 255, g / 255, b / 255, THREE.SRGBColorSpace);
    eyeMat.emissive.copy(eyeMat.color);
  }

  return { group, update, feet: legs.map((l) => l.foot), knees: legs.map((l) => l.knee) };
}
