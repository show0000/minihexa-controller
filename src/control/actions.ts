/**
 * Built-in action scripts (ids 1..5), ported from the firmware
 * (vendor/app_firmware/remote/hiwonder_robot.cpp 720-862, dispatch in remote.ino).
 * Each step is one firmware `move(&vel, &pos, &att, moveMs[, steps])` followed by `delay(holdMs)`.
 * Euler order matches the firmware's Euler_t {pitch, roll, yaw}.
 */
export interface ActionStep {
  att: { pitch: number; roll: number; yaw: number };
  /** 'keep' = the firmware reuses the current body position. */
  pos: { x: number; y: number } | 'keep';
  vel?: { vx: number; vy: number; omega: number; steps: number };
  moveMs: number;
  holdMs: number;
}

export interface BuiltinAction {
  id: 1 | 2 | 3 | 4 | 5;
  name: string;
  steps: ActionStep[];
}

/** Stored action groups (ids 6..50) have unknown length; lock input for this long. */
export const STORED_ACTION_LOCK_MS = 10000;

const att = (pitch: number, roll: number, yaw: number) => ({ pitch, roll, yaw });

/** Robot::twist + next_circular_point: (x, y) of the circle drive (roll, pitch). */
function twist(radius: number, circles: number, stepsPerCircle: number, dir: 1 | -1): ActionStep[] {
  const steps: ActionStep[] = [];
  const total = circles * stepsPerCircle;
  for (let i = 0; i < total; i++) {
    const angle = 2 * Math.PI * (i / stepsPerCircle) * dir;
    const first = i === 0;
    steps.push({
      att: att(radius * Math.sin(angle), radius * Math.cos(angle), 0),
      pos: 'keep',
      moveMs: first ? 500 : 100,
      holdMs: first ? 500 : 100,
    });
  }
  steps.push({ att: att(0, 0, 0), pos: 'keep', moveMs: 500, holdMs: 500 });
  return steps;
}

const CLOCKWISE = 1;
const COUNTER_CLOCKWISE = -1;

export const BUILTIN_ACTIONS: BuiltinAction[] = [
  { id: 1, name: 'twist (counter-clockwise)', steps: twist(8, 3, 12, COUNTER_CLOCKWISE) },
  { id: 2, name: 'twist (clockwise)', steps: twist(8, 3, 12, CLOCKWISE) },
  {
    id: 3,
    name: 'short wake up',
    steps: [
      { att: att(-8, 0, -15), pos: 'keep', moveMs: 200, holdMs: 1000 },
      { att: att(-8, 0, 15), pos: 'keep', moveMs: 600, holdMs: 1000 },
      { att: att(0, 0, 0), pos: 'keep', moveMs: 200, holdMs: 200 },
    ],
  },
  {
    id: 4,
    name: 'wake up',
    steps: [
      { att: att(0, 0, 0), pos: 'keep', moveMs: 200, holdMs: 100 },
      { att: att(-8, 0, -15), pos: 'keep', moveMs: 200, holdMs: 1000 },
      { att: att(-8, 0, 15), pos: 'keep', moveMs: 200, holdMs: 1000 },
      { att: att(0, 0, 0), pos: 'keep', moveMs: 200, holdMs: 600 },
      { att: att(0, 0, 0), pos: 'keep', vel: { vx: 0, vy: 1.5, omega: 0, steps: 10 }, moveMs: 500, holdMs: 6000 },
    ],
  },
  {
    id: 5,
    name: 'acting cute',
    steps: [
      { att: att(0, 10, 0), pos: 'keep', moveMs: 300, holdMs: 300 },
      { att: att(0, -10, 0), pos: 'keep', moveMs: 300, holdMs: 300 },
      { att: att(0, 10, 0), pos: 'keep', moveMs: 300, holdMs: 300 },
      { att: att(0, -10, 0), pos: 'keep', moveMs: 300, holdMs: 300 },
      { att: att(0, 0, 0), pos: 'keep', moveMs: 300, holdMs: 300 },
      { att: att(0, 0, 0), pos: { x: 2, y: 0 }, moveMs: 200, holdMs: 200 },
      { att: att(0, 0, 0), pos: { x: -2, y: 0 }, moveMs: 200, holdMs: 200 },
      { att: att(0, 0, 0), pos: { x: 2, y: 0 }, moveMs: 200, holdMs: 200 },
      { att: att(0, 0, 0), pos: { x: -2, y: 0 }, moveMs: 200, holdMs: 200 },
      { att: att(0, 0, 0), pos: { x: 0, y: 0 }, moveMs: 200, holdMs: 200 },
    ],
  },
];

/** How long the firmware is busy with an action: sum of the script's holds. */
export function actionDurationMs(id: number): number {
  const a = BUILTIN_ACTIONS.find((b) => b.id === id);
  if (!a) return STORED_ACTION_LOCK_MS;
  return a.steps.reduce((sum, s) => sum + s.holdMs, 0);
}
