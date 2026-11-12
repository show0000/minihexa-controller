/**
 * three.js scene for the simulator: renderer, camera, lights and ground. The robot model is in
 * robotMesh.ts. Robot and ground live in a z-up group (`world`, kinematics frames, cm) that is
 * rotated so z-up maps to three's y-up.
 */
import * as THREE from 'three';
import { STANCE } from './kinematics';
import { createRobotMesh } from './robotMesh';
import type { SimFrame } from './robotModel';

/** Foot-tip spheres have a 0.38cm radius; drop the ground so they rest on it. */
const GROUND_Z = STANCE[0]!.z - 0.38;
const GRID_CELL = 10;
const GROUND_SIZE = 600;
/** Three's frame (y up, robot starts facing -z): 3/4 front view from slightly above. */
const CAMERA_OFFSET = new THREE.Vector3(27, 23, -41);
const LOOK_OFFSET = new THREE.Vector3(0, -1, 0);

export function createScene(canvas: HTMLCanvasElement): { render(f: SimFrame): void; resize(): void } {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xc9cdd2);
  scene.fog = new THREE.Fog(0xc9cdd2, 120, 320);
  const camera = new THREE.PerspectiveCamera(40, 1, 0.5, 2000);

  // Key (casts the only shadow), fill and rim light so the black robot reads on screen.
  scene.add(new THREE.HemisphereLight(0xf2f4f7, 0x6b7076, 1.1));
  const key = new THREE.DirectionalLight(0xfff6ea, 2.4);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  Object.assign(key.shadow.camera, { left: -25, right: 25, top: 25, bottom: -25, near: 1, far: 120 });
  key.shadow.radius = 4;
  scene.add(key, key.target);
  const fill = new THREE.DirectionalLight(0xdbe6ff, 0.9);
  scene.add(fill, fill.target);
  const rim = new THREE.DirectionalLight(0xffffff, 2.2);
  scene.add(rim, rim.target);

  const world = new THREE.Group();
  world.rotation.x = -Math.PI / 2; // z-up -> y-up
  scene.add(world);

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(GROUND_SIZE, GROUND_SIZE),
    new THREE.MeshStandardMaterial({ color: 0xa3a8ae, roughness: 0.95 }),
  );
  ground.receiveShadow = true;
  ground.position.z = GROUND_Z;
  world.add(ground);

  const grid = new THREE.GridHelper(GROUND_SIZE, GROUND_SIZE / GRID_CELL, 0x80868d, 0x8f959b);
  grid.rotation.x = Math.PI / 2; // GridHelper lies in its xz plane; ours is xy
  grid.position.z = GROUND_Z + 0.02;
  world.add(grid);

  const robot = createRobotMesh();
  world.add(robot.group);

  const robotPos = new THREE.Vector3();

  function resize(): void {
    const w = canvas.clientWidth || 1;
    const h = canvas.clientHeight || 1;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  function render(f: SimFrame): void {
    robot.update(f);

    // Keep the finite ground under the robot.
    const gx = Math.round(f.odom.x / GRID_CELL) * GRID_CELL;
    const gy = Math.round(f.odom.y / GRID_CELL) * GRID_CELL;
    ground.position.set(gx, gy, GROUND_Z);
    grid.position.set(gx, gy, GROUND_Z + 0.02);

    world.updateMatrixWorld();
    robot.group.getWorldPosition(robotPos);
    camera.position.copy(robotPos).add(CAMERA_OFFSET);
    camera.lookAt(robotPos.clone().add(LOOK_OFFSET));

    // Lights travel with the robot so the shadow map stays small and sharp.
    key.position.copy(robotPos).add(new THREE.Vector3(18, 40, -12));
    fill.position.copy(robotPos).add(new THREE.Vector3(-30, 15, -20));
    rim.position.copy(robotPos).add(new THREE.Vector3(-10, 25, 35));
    for (const l of [key, fill, rim]) l.target.position.copy(robotPos);

    renderer.render(scene, camera);
  }

  resize();
  return { render, resize };
}
