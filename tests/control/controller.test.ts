import { describe, expect, it } from 'vitest';
import {
  ACTION_MARGIN_MS,
  Controller,
  DEFAULT_Z,
  LED_PALETTE,
  SEND_INTERVAL_MS,
} from '../../src/control/controller';
import { actionDurationMs } from '../../src/control/actions';
import { STOP, type RobotCommand } from '../../src/protocol/commands';
import {
  AXIS_FUNCTIONS,
  BUTTON_FUNCTIONS,
  DEFAULT_ACTION_IDS,
  type AxisFunction,
  type ButtonFunction,
  type ControlInput,
} from '../../src/input/mapping';

type Partial_ = Partial<Record<AxisFunction | ButtonFunction, number>>;
function inp(v: Partial_ = {}): ControlInput {
  const axes = {} as ControlInput['axes'];
  const buttons = {} as ControlInput['buttons'];
  for (const f of AXIS_FUNCTIONS) axes[f] = v[f] ?? 0;
  for (const f of BUTTON_FUNCTIONS) buttons[f] = v[f] ?? 0;
  return { axes, buttons };
}
const N = inp();
const mk = () => new Controller({ ...DEFAULT_ACTION_IDS });
const move = (vx: number, vy: number, turn: 0 | 1 | 2 = 0): RobotCommand => ({ kind: 'move', vx, vy, turn });
const pose = (pitch: number, roll: number, z = DEFAULT_Z): RobotCommand => ({
  kind: 'pose', yaw: 0, pitch, roll, x: 0, y: 0, z,
});

describe('Controller: sending rules', () => {
  it('sends only on change', () => {
    const c = mk();
    expect(c.update(0, inp({ moveY: 1 }))).toEqual([move(0, 50)]);
    for (let t = 16; t < 500; t += 16) expect(c.update(t, inp({ moveY: 1 }))).toEqual([]);
  });

  it('rate limits non-stop commands to one per 50ms, then sends the latest value', () => {
    const c = mk();
    expect(c.update(0, inp({ moveY: 1 }))).toEqual([move(0, 50)]);
    expect(c.update(20, inp({ moveY: 0.5 }))).toEqual([]);
    expect(c.update(40, inp({ moveY: 0.6 }))).toEqual([]);
    expect(c.update(SEND_INTERVAL_MS, inp({ moveY: 0.8 }))).toEqual([move(0, 40)]);
  });

  it('stops immediately when the stick returns to neutral, ignoring the rate limit', () => {
    const c = mk();
    c.update(0, inp({ moveY: 1 }));
    expect(c.update(5, N)).toEqual([STOP]);
    expect(c.update(10, N)).toEqual([]);
  });

  it('returns at most one command per update, by priority', () => {
    const c = mk();
    // reset + move + pose all wanted at once: reset wins
    expect(c.update(0, inp({ reset: 1, moveY: 1, tiltPitch: 1 }))).toEqual([{ kind: 'reset' }]);
    expect(c.update(50, inp({ reset: 1, moveY: 1, tiltPitch: 1 }))).toEqual([move(0, 50)]);
    expect(c.update(100, inp({ reset: 1, moveY: 1, tiltPitch: 1 }))).toEqual([pose(50, 0)]);
    // STOP beats a pending button command even inside the rate-limit window
    c.update(150, inp({ moveY: 0.5 }));
    expect(c.update(160, inp({ ledNext: 1 }))).toEqual([STOP]);
    expect(c.update(200, N)).toEqual([{ kind: 'led', r: LED_PALETTE[1]![0], g: LED_PALETTE[1]![1], b: LED_PALETTE[1]![2] }]);
  });

  it('move not starved by pose', () => {
    const c = mk();
    const sent: RobotCommand['kind'][] = [];
    for (let i = 0; i < 20; i++) {
      const v = 0.1 + 0.04 * i; // both move and tilt change every slot
      const out = c.update(i * SEND_INTERVAL_MS, inp({ moveY: v, tiltPitch: v }));
      expect(out).toHaveLength(1);
      sent.push(out[0]!.kind);
    }
    for (let i = 0; i + 1 < sent.length; i++) {
      expect(sent[i] === 'move' || sent[i + 1] === 'move').toBe(true);
    }
    expect(sent.filter((k) => k === 'pose').length).toBeGreaterThan(0);
  });
});

describe('Controller: input mapping', () => {
  it('maps turn buttons', () => {
    const c = mk();
    expect(c.update(0, inp({ turnLeft: 1 }))).toEqual([move(0, 0, 1)]);
    expect(c.update(50, inp({ turnRight: 1 }))).toEqual([move(0, 0, 2)]);
    expect(c.update(100, inp({ turnLeft: 1, turnRight: 1 }))).toEqual([STOP]);
    expect(c.update(150, inp({ turnLeft: 1 }))).toEqual([move(0, 0, 1)]);
    expect(c.update(200, N)).toEqual([STOP]);
  });

  it('maps move axes with rounding', () => {
    const c = mk();
    expect(c.update(0, inp({ moveX: -0.38, moveY: 0.51 }))).toEqual([move(-19, 26)]);
  });

  it('maps tilt to pose and integrates height with clamping', () => {
    const c = mk();
    expect(c.update(0, inp({ tiltPitch: 1, tiltRoll: -1 }))).toEqual([pose(50, -50)]);
    const c2 = mk();
    c2.update(0, N);
    for (let t = 50; t <= 1000; t += 50) c2.update(t, inp({ heightUp: 1 }));
    expect(c2.status().z).toBeCloseTo(25);
    for (let t = 1050; t <= 3000; t += 50) c2.update(t, inp({ heightUp: 1 }));
    expect(c2.status().z).toBe(30);
    const out = c2.update(3050, N);
    // last sent pose already carries z 30
    expect(out).toEqual([]);
    for (let t = 3100; t <= 10000; t += 50) c2.update(t, inp({ heightDown: 1 }));
    expect(c2.status().z).toBe(0);
  });

  it('clamps dt between updates to 100ms', () => {
    const c = mk();
    c.update(0, inp({ heightUp: 1 }));
    c.update(5000, inp({ heightUp: 1 }));
    expect(c.status().z).toBeCloseTo(DEFAULT_Z + 1.5);
  });

  it('treats buttons >= 0.5 as pressed and reacts only on the press edge', () => {
    const c = mk();
    expect(c.update(0, inp({ ledNext: 0.49 }))).toEqual([]);
    expect(c.update(50, inp({ ledNext: 0.5 }))).toHaveLength(1);
    expect(c.update(100, inp({ ledNext: 1 }))).toEqual([]);
    expect(c.update(150, N)).toEqual([]);
    expect(c.update(200, inp({ ledNext: 1 }))).toHaveLength(1);
  });
});

describe('Controller: actions', () => {
  it('starts an action and locks input', () => {
    const c = mk();
    expect(c.update(1000, inp({ action1: 1 }))).toEqual([{ kind: 'action', id: 1 }]);
    const st = c.status();
    expect(st.mode).toBe('action');
    expect(st.actionEndsAt).toBe(1000 + actionDurationMs(1) + ACTION_MARGIN_MS);
    for (let t = 1050; t < st.actionEndsAt!; t += 50) {
      expect(c.update(t, inp({ moveY: 1, ledNext: t % 100 === 0 ? 1 : 0, reset: 1 }))).toEqual([]);
    }
  });

  it('maps action buttons through the constructor actionIds', () => {
    const c = new Controller({ action1: 1, action2: 2, action3: 4, action4: 33 });
    expect(c.update(0, inp({ action4: 1 }))).toEqual([{ kind: 'action', id: 33 }]);
    expect(c.status().actionEndsAt).toBe(10000 + ACTION_MARGIN_MS);
  });

  it('repeated action press during lock is ignored', () => {
    const c = mk();
    c.update(0, inp({ action1: 1 }));
    const ends = c.status().actionEndsAt;
    c.update(100, N);
    expect(c.update(200, inp({ action1: 1 }))).toEqual([]);
    expect(c.status().actionEndsAt).toBe(ends);
  });

  it('estop during lock is deferred to the first update after the lock', () => {
    const c = mk();
    c.update(0, inp({ action1: 1 }));
    const ends = c.status().actionEndsAt!;
    expect(c.estop(100)).toEqual([]);
    expect(c.status().estopPending).toBe(true);
    expect(c.update(ends - 1, N)).toEqual([]);
    expect(c.update(ends, N)).toEqual([STOP]);
    expect(c.status()).toMatchObject({ mode: 'manual', estopPending: false, actionEndsAt: null });
  });

  it('after a lock ends without estop, nothing special is sent and a held stick re-sends', () => {
    const c = mk();
    c.update(0, inp({ moveY: 1 }));
    c.update(50, inp({ action1: 1, moveY: 1 }));
    const ends = c.status().actionEndsAt!;
    expect(c.update(ends, inp({ moveY: 1 }))).toEqual([move(0, 50)]);
    const c2 = mk();
    c2.update(0, inp({ action1: 1 }));
    expect(c2.update(c2.status().actionEndsAt!, N)).toEqual([]);
    expect(c2.status().mode).toBe('manual');
  });
});

describe('Controller: avoid and balance', () => {
  for (const kind of ['avoid', 'balance'] as const) {
    const toggle = kind === 'avoid' ? 'avoidToggle' : 'balanceToggle';
    const enter = (c: Controller) => {
      expect(c.update(0, inp({ [toggle]: 1 }))).toEqual([{ kind, on: true }]);
      expect(c.status().mode).toBe(kind);
      c.update(10, N);
    };

    it(`${kind}: stick exits the mode, then the move goes out in a later slot`, () => {
      const c = mk();
      enter(c);
      expect(c.update(20, inp({ moveY: 1 }))).toEqual([{ kind, on: false }]);
      expect(c.status().mode).toBe('manual');
      expect(c.update(70, inp({ moveY: 1 }))).toEqual([move(0, 50)]);
    });

    it(`${kind}: toggling again exits`, () => {
      const c = mk();
      enter(c);
      expect(c.update(100, inp({ [toggle]: 1 }))).toEqual([{ kind, on: false }]);
      expect(c.status().mode).toBe('manual');
      expect(c.update(200, N)).toEqual([]);
    });

    it(`${kind}: another button only exits; its own effect is not performed`, () => {
      const c = mk();
      enter(c);
      expect(c.update(100, inp({ action1: 1 }))).toEqual([{ kind, on: false }]);
      expect(c.status().mode).toBe('manual');
      for (let t = 150; t < 400; t += 50) expect(c.update(t, inp({ action1: 1 }))).toEqual([]);
      const c2 = mk();
      enter(c2);
      expect(c2.update(100, inp({ ledNext: 1 }))).toEqual([{ kind, on: false }]);
      expect(c2.update(200, N)).toEqual([]);
    });

    it(`${kind}: off bypasses the rate limit`, () => {
      const c = mk();
      expect(c.update(0, inp({ [toggle]: 1 }))).toEqual([{ kind, on: true }]);
      c.update(1, N);
      expect(c.update(2, inp({ moveX: 1 }))).toEqual([{ kind, on: false }]);
    });

    it(`${kind}: after exit, the believed motion is stopped so a held stick re-sends`, () => {
      const c = mk();
      c.update(0, inp({ moveY: 1 }));
      c.update(50, inp({ moveY: 1, [toggle]: 1 }));
      expect(c.status().mode).toBe(kind);
      // the still-held stick exits the mode
      expect(c.update(100, inp({ moveY: 1 }))).toEqual([{ kind, on: false }]);
      // last sent move was move(0,50), but the robot is stopped now: re-send it
      expect(c.update(150, inp({ moveY: 1 }))).toEqual([move(0, 50)]);
    });
  }
});

describe('Controller: reset and LED', () => {
  it('reset sends reset and restores z, pitch and roll baselines', () => {
    const c = mk();
    c.update(0, N);
    for (let t = 50; t <= 500; t += 50) c.update(t, inp({ heightUp: 1, tiltPitch: 1 }));
    expect(c.status().z).toBeGreaterThan(DEFAULT_Z);
    expect(c.update(550, inp({ reset: 1, tiltPitch: 1 }))).toEqual([{ kind: 'reset' }]);
    expect(c.status().z).toBe(DEFAULT_Z);
    // robot pose was reset to neutral: the still-tilted stick re-sends its pose
    expect(c.update(600, inp({ tiltPitch: 1 }))).toEqual([pose(50, 0)]);
    expect(c.update(650, N)).toEqual([pose(0, 0)]);
  });

  it('reset clears believed motion so a held stick re-sends', () => {
    const c = mk();
    c.update(0, inp({ moveY: 1 }));
    expect(c.update(50, inp({ moveY: 1, reset: 1 }))).toEqual([{ kind: 'reset' }]);
    expect(c.update(100, inp({ moveY: 1 }))).toEqual([move(0, 50)]);
  });

  it('LED cycles the palette and wraps', () => {
    expect(LED_PALETTE[0]).toEqual([0, 237, 178]);
    expect(LED_PALETTE).toHaveLength(6);
    expect(new Set(LED_PALETTE.map((c) => c.join(','))).size).toBe(6);
    const c = mk();
    const seen: number[][] = [];
    for (let i = 0; i < 7; i++) {
      const out = c.update(i * 100, inp({ ledNext: 1 }));
      c.update(i * 100 + 50, N);
      const cmd = out[0] as { kind: 'led'; r: number; g: number; b: number };
      seen.push([cmd.r, cmd.g, cmd.b]);
    }
    expect(seen).toEqual([1, 2, 3, 4, 5, 0, 1].map((i) => LED_PALETTE[i]));
  });
});

describe('Controller: loss, hidden and estop', () => {
  it('gamepad lost then neutral resumes silently', () => {
    const c = mk();
    c.update(0, inp({ moveY: 1 }));
    expect(c.gamepadLost(10)).toEqual([STOP]);
    expect(c.update(20, N)).toEqual([]);
  });

  for (const fn of ['gamepadLost', 'hidden', 'estop'] as const) {
    it(`${fn}: manual always sends STOP`, () => {
      const c = mk();
      expect(c[fn](0)).toEqual([STOP]);
      expect(c[fn](1)).toEqual([STOP]);
    });
    it(`${fn}: avoid/balance send off and return to manual`, () => {
      const a = mk();
      a.update(0, inp({ avoidToggle: 1 }));
      expect(a[fn](10)).toEqual([{ kind: 'avoid', on: false }]);
      expect(a.status().mode).toBe('manual');
      const b = mk();
      b.update(0, inp({ balanceToggle: 1 }));
      expect(b[fn](10)).toEqual([{ kind: 'balance', on: false }]);
      expect(b.status().mode).toBe('manual');
    });
    it(`${fn}: action mode returns [] and sets estopPending`, () => {
      const c = mk();
      c.update(0, inp({ action2: 1 }));
      expect(c[fn](10)).toEqual([]);
      expect(c.status()).toMatchObject({ mode: 'action', estopPending: true });
    });
  }

  it('estop bypasses the rate limit', () => {
    const c = mk();
    c.update(0, inp({ moveY: 1 }));
    expect(c.estop(1)).toEqual([STOP]);
  });

  it('estop button press acts as estop', () => {
    const c = mk();
    c.update(0, inp({ moveY: 1 }));
    expect(c.update(5, inp({ moveY: 1, estop: 1 }))).toEqual([STOP]);
  });

  it('after estop, a held stick does not restart walking until it returns to neutral', () => {
    const c = mk();
    c.update(0, inp({ moveY: 1 }));
    expect(c.estop(10)).toEqual([STOP]);
    for (let t = 50; t <= 300; t += 50) expect(c.update(t, inp({ moveY: 1 }))).toEqual([]);
    expect(c.update(350, N)).toEqual([]);
    expect(c.update(400, inp({ moveY: 1 }))).toEqual([move(0, 50)]);
  });
});
