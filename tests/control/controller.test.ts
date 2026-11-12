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
    expect(c.update(200, N)).toEqual([]); // the STOP at 160 holds the slot until 210
    expect(c.update(210, N)).toEqual([{ kind: 'led', r: LED_PALETTE[1]![0], g: LED_PALETTE[1]![1], b: LED_PALETTE[1]![2] }]);
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
    expect(c.update(50, inp({ action1: 1, moveY: 1 }))).toEqual([STOP]);
    expect(c.update(100, inp({ action1: 1, moveY: 1 }))).toEqual([{ kind: 'action', id: 1 }]);
    const ends = c.status().actionEndsAt!;
    // pose belief is unknown after an action, so the pose is re-sent too (alternating)
    expect(c.update(ends, inp({ moveY: 1 }))).toEqual([pose(0, 0)]);
    expect(c.update(ends + 50, inp({ moveY: 1 }))).toEqual([move(0, 50)]);
    const c2 = mk();
    c2.update(0, inp({ action1: 1 }));
    const ends2 = c2.status().actionEndsAt!;
    expect(c2.update(ends2, N)).toEqual([pose(0, 0)]);
    expect(c2.status().mode).toBe('manual');
    for (let t = ends2 + 50; t < ends2 + 500; t += 50) expect(c2.update(t, N)).toEqual([]);
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
      expect(c.update(50, inp({ moveY: 1, [toggle]: 1 }))).toEqual([STOP]);
      expect(c.update(100, inp({ moveY: 1, [toggle]: 1 }))).toEqual([{ kind, on: true }]);
      expect(c.status().mode).toBe(kind);
      // the still-held stick exits the mode
      expect(c.update(150, inp({ moveY: 1 }))).toEqual([{ kind, on: false }]);
      // the robot is stopped now: the held stick re-sends its move
      expect(c.update(200, inp({ moveY: 1 }))).toEqual([move(0, 50)]);
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
    for (let t = 50; t <= 300; t += 50) {
      // only the two STOP repeats go out while the latched stick is held
      expect(c.update(t, inp({ moveY: 1 }))).toEqual(t === 100 || t === 150 ? [STOP] : []);
    }
    expect(c.update(350, N)).toEqual([]);
    expect(c.update(400, inp({ moveY: 1 }))).toEqual([move(0, 50)]);
  });
});

describe('Controller: zero the firmware velocity before mode/action intents', () => {
  // remote.ino: global `vel` changes only on C commands; actions and balance(true) leave it,
  // and pose / balance-off call move(&vel, ...) with it, which restarts walking.
  it('(a) walking + action1: STOP first (bypassing the rate limit), then the action in the next slot', () => {
    const c = mk();
    expect(c.update(0, inp({ moveY: 1 }))).toEqual([move(0, 50)]);
    expect(c.update(10, inp({ moveY: 1, action1: 1 }))).toEqual([STOP]);
    expect(c.update(30, inp({ moveY: 1, action1: 1 }))).toEqual([]);
    expect(c.update(59, inp({ moveY: 1, action1: 1 }))).toEqual([]); // STOP holds its slot
    expect(c.update(60, inp({ moveY: 1, action1: 1 }))).toEqual([{ kind: 'action', id: 1 }]);
    expect(c.status().mode).toBe('action');
  });

  it('(b) walking + balanceToggle: STOP, then balance on', () => {
    const c = mk();
    c.update(0, inp({ moveY: 1 }));
    expect(c.update(10, inp({ moveY: 1, balanceToggle: 1 }))).toEqual([STOP]);
    expect(c.update(59, inp({ moveY: 1, balanceToggle: 1 }))).toEqual([]);
    expect(c.update(60, inp({ moveY: 1, balanceToggle: 1 }))).toEqual([{ kind: 'balance', on: true }]);
  });

  it('(c) balance entered from walking, then estop: STOP preceded balance on', () => {
    const c = mk();
    const sent: RobotCommand[] = [];
    sent.push(...c.update(0, inp({ moveY: 1 })));
    sent.push(...c.update(10, inp({ moveY: 1, balanceToggle: 1 })));
    sent.push(...c.update(50, inp({ moveY: 1, balanceToggle: 1 })));
    sent.push(...c.update(100, N));
    expect(c.status().mode).toBe('balance');
    sent.push(...c.estop(150));
    expect(sent).toEqual([move(0, 50), STOP, { kind: 'balance', on: true }, { kind: 'balance', on: false }]);
  });

  it('(d) walking + avoidToggle: STOP, then avoid on', () => {
    const c = mk();
    c.update(0, inp({ moveY: 1 }));
    expect(c.update(10, inp({ moveY: 1, avoidToggle: 1 }))).toEqual([STOP]);
    expect(c.update(59, inp({ moveY: 1, avoidToggle: 1 }))).toEqual([]);
    expect(c.update(60, inp({ moveY: 1, avoidToggle: 1 }))).toEqual([{ kind: 'avoid', on: true }]);
  });

  it('no extra STOP when already stopped, nor before reset or led', () => {
    const c = mk();
    expect(c.update(0, inp({ action1: 1 }))).toEqual([{ kind: 'action', id: 1 }]);
    const d = mk();
    d.update(0, inp({ moveY: 1 }));
    expect(d.update(50, inp({ moveY: 1, ledNext: 1 }))[0]!.kind).toBe('led');
  });
});

describe('Controller: review fixes', () => {
  for (const kind of ['avoid', 'balance'] as const) {
    it(`${kind}: tilt stick beyond the deadzone exits the mode`, () => {
      const c = mk();
      c.update(0, inp({ [kind === 'avoid' ? 'avoidToggle' : 'balanceToggle']: 1 }));
      c.update(10, N);
      expect(c.update(20, inp({ tiltRoll: 0.3 }))).toEqual([{ kind, on: false }]);
      expect(c.status().mode).toBe('manual');
      expect(c.update(70, inp({ tiltRoll: 0.3 }))).toEqual([pose(0, 15)]);
    });
  }

  it('a tilt held through an action is re-sent when the lock ends', () => {
    const c = mk();
    expect(c.update(0, inp({ tiltPitch: 1 }))).toEqual([pose(50, 0)]);
    c.update(50, inp({ tiltPitch: 1, action1: 1 }));
    expect(c.status().mode).toBe('action');
    expect(c.update(c.status().actionEndsAt!, inp({ tiltPitch: 1 }))).toEqual([pose(50, 0)]);
  });
});

describe('Controller: STOP slot occupancy and redundancy', () => {
  const run = (c: Controller, from: number, to: number, input: ControlInput) => {
    const out: [number, RobotCommand][] = [];
    for (let t = from; t <= to; t += 10) for (const cmd of c.update(t, input)) out.push([t, cmd]);
    return out;
  };

  it('a STOP occupies the send slot: the next command waits SEND_INTERVAL_MS', () => {
    const c = mk();
    c.update(0, inp({ moveY: 1 }));
    expect(c.update(100, N)).toEqual([STOP]);
    expect(c.update(110, inp({ reset: 1 }))).toEqual([]);
    expect(c.update(149, inp({ reset: 1 }))).toEqual([]);
    expect(c.update(150, inp({ reset: 1 }))).toEqual([{ kind: 'reset' }]);
  });

  it('estop / gamepadLost / hidden STOPs occupy the slot too', () => {
    for (const fn of ['estop', 'gamepadLost', 'hidden'] as const) {
      const c = mk();
      c.update(0, N);
      expect(c[fn](100)).toEqual([STOP]);
      c.update(105, N); // gamepadLost/hidden ignore edges on the first update after
      expect(c.update(110, inp({ ledNext: 1 }))).toEqual([]);
      expect(c.update(150, inp({ ledNext: 1 }))[0]?.kind).toBe('led');
    }
  });

  it('stop -> STOP at t, again at >= t+50 and >= t+100, then nothing more', () => {
    const c = mk();
    c.update(0, inp({ moveY: 1 }));
    const out = run(c, 10, 600, N);
    expect(out).toEqual([[10, STOP], [60, STOP], [110, STOP]]);
  });

  it('stop then immediate re-push: no STOP repeats, the move goes out in the next slot', () => {
    const c = mk();
    c.update(0, inp({ moveY: 1 }));
    expect(c.update(10, N)).toEqual([STOP]);
    const out = run(c, 20, 600, inp({ moveY: 1 }));
    expect(out).toEqual([[60, move(0, 50)]]);
  });

  it('a stick flick that is never sent does not cancel the STOP repeats', () => {
    const c = mk();
    c.update(-100, inp({ moveY: 1 }));
    expect(c.update(0, N)).toEqual([STOP]);
    expect(c.update(16, inp({ moveY: 1 }))).toEqual([]); // inside the STOP's slot: not sent
    expect(c.update(33, N)).toEqual([]);
    const out = run(c, 40, 600, N);
    expect(out).toEqual([[50, STOP], [100, STOP]]);
  });

  it('a queued intent takes priority over repeats and cancels them', () => {
    const c = mk();
    c.update(0, inp({ moveY: 1 }));
    expect(c.update(10, inp({ ledNext: 1 }))).toEqual([STOP]);
    const out = run(c, 20, 600, inp({ ledNext: 1 }));
    expect(out.map(([t, cmd]) => [t, cmd.kind])).toEqual([[60, 'led']]);
  });

  it('the pre-intent STOP is the only STOP once the intent is sent', () => {
    const c = mk();
    c.update(0, inp({ moveY: 1 }));
    expect(c.update(10, inp({ moveY: 1, balanceToggle: 1 }))).toEqual([STOP]);
    expect(c.update(60, inp({ balanceToggle: 1 }))).toEqual([{ kind: 'balance', on: true }]);
    expect(run(c, 70, 600, N)).toEqual([]);
  });

  it('estop that becomes pending during a lock: STOP after the lock, then two repeats', () => {
    const c = mk();
    c.update(0, inp({ action1: 1 }));
    c.estop(100);
    const ends = c.status().actionEndsAt!;
    const out = run(c, ends, ends + 500, N);
    expect(out).toEqual([[ends, STOP], [ends + 50, STOP], [ends + 100, STOP], [ends + 150, pose(0, 0)]]);
  });

  it('pose is re-sent after an action even if neutral: tilt released during the lock', () => {
    const c = mk();
    expect(c.update(0, inp({ tiltPitch: 1, tiltRoll: 1 }))).toEqual([pose(50, 50)]);
    expect(c.update(50, inp({ tiltPitch: 1, tiltRoll: 1, action1: 1 }))).toEqual([{ kind: 'action', id: 1 }]);
    const ends = c.status().actionEndsAt!;
    expect(c.update(ends - 100, N)).toEqual([]);
    expect(c.update(ends, N)).toEqual([pose(0, 0)]);
  });
});

describe('Controller: Task 6 UI hooks', () => {
  it('setActionIds changes the action sent and keeps height belief and mode', () => {
    const c = mk();
    // raise the body for 1s (heightUp at 15/s from DEFAULT_Z)
    for (let t = 0; t <= 1000; t += 16) c.update(t, inp({ heightUp: 1 }));
    const z = c.status().z;
    expect(z).toBeGreaterThan(DEFAULT_Z + 10);
    c.update(1100, N);
    c.setActionIds({ action1: 9, action2: 2, action3: 4, action4: 5 });
    expect(c.status()).toMatchObject({ mode: 'manual', z });
    const sent = [...c.update(1200, inp({ action1: 1 })), ...c.update(1300, N)];
    expect(sent).toContainEqual({ kind: 'action', id: 9 });
    expect(c.status().mode).toBe('action');
    expect(c.status().z).toBe(z);
  });

  it('setActionIds during avoid mode keeps the mode', () => {
    const c = mk();
    c.update(0, inp({ avoidToggle: 1 }));
    expect(c.status().mode).toBe('avoid');
    c.setActionIds({ action1: 3, action2: 3, action3: 3, action4: 3 });
    expect(c.status().mode).toBe('avoid');
  });

  it('setActionIds copies the ids (later mutation of the argument has no effect)', () => {
    const c = mk();
    const ids = { action1: 7, action2: 2, action3: 4, action4: 5 };
    c.setActionIds(ids);
    ids.action1 = 1;
    const sent = [...c.update(0, inp({ action1: 1 })), ...c.update(100, N)];
    expect(sent).toContainEqual({ kind: 'action', id: 7 });
  });

  it('stickLatched is true after estop until the stick returns to neutral', () => {
    const c = mk();
    expect(c.status().stickLatched).toBe(false);
    c.update(0, inp({ moveY: 1 }));
    c.estop(10);
    expect(c.status().stickLatched).toBe(true);
    c.update(100, inp({ moveY: 1 }));
    expect(c.status().stickLatched).toBe(true);
    c.update(200, N);
    expect(c.status().stickLatched).toBe(false);
  });

  it('resync stops and re-sends the believed pose on the next free slot', () => {
    const c = mk();
    c.update(0, N);
    expect(c.resync(100)).toEqual([STOP]);
    const later: RobotCommand[] = [];
    for (let t = 116; t < 400; t += 16) later.push(...c.update(t, N));
    expect(later).toContainEqual(pose(0, 0));
  });
});

describe('Controller: resync always stops first', () => {
  const run = (c: Controller, from: number, to: number, input = N) => {
    const out: RobotCommand[] = [];
    for (let t = from; t < to; t += 16) out.push(...c.update(t, input));
    return out;
  };

  for (const mode of ['avoid', 'balance'] as const) {
    it(`${mode}: STOP first, then ${mode} off in a later slot, STOP repeats, then the pose`, () => {
      const c = mk();
      c.update(0, inp({ [`${mode}Toggle`]: 1 }));
      c.update(100, N);
      expect(c.status().mode).toBe(mode);
      const first = c.resync(200);
      expect(first).toEqual([STOP]);
      expect(c.status()).toMatchObject({ mode: 'manual', stickLatched: true });
      const later = run(c, 216, 600);
      const offAt = later.findIndex((x) => x.kind === mode);
      expect(later[offAt]).toEqual({ kind: mode, on: false });
      expect(later.filter((x) => x.kind === 'move')).toEqual([STOP, STOP]);
      expect(later.filter((x) => x.kind !== 'move' && x.kind !== mode)).toEqual([pose(0, 0)]);
      expect(later.indexOf(later.find((x) => x.kind === 'pose')!)).toBeGreaterThan(offAt);
    });
  }

  it('action: STOP first, the lock is cancelled and nothing is deferred', () => {
    const c = mk();
    c.update(0, inp({ action1: 1 }));
    run(c, 16, 200);
    expect(c.status().mode).toBe('action');
    c.estop(210); // pending estop must not fire later
    expect(c.status().estopPending).toBe(true);
    const first = c.resync(300);
    expect(first[0]).toEqual(STOP);
    expect(first).toEqual([STOP]);
    expect(c.status()).toMatchObject({ mode: 'manual', estopPending: false, actionEndsAt: null, stickLatched: true });
    const later = run(c, 316, 800);
    expect(later.filter((x) => x.kind === 'move')).toEqual([STOP, STOP]);
    expect(later).toContainEqual(pose(0, 0));
    // after the lock time, no extra deferred STOP burst
    expect(run(c, 800, actionDurationMs(DEFAULT_ACTION_IDS.action1) + ACTION_MARGIN_MS + 1000)).toEqual([]);
  });

  it('a held stick stays latched after resync until neutral', () => {
    const c = mk();
    c.update(0, inp({ moveY: 1 }));
    expect(c.resync(100)).toEqual([STOP]);
    expect(run(c, 116, 400, inp({ moveY: 1 })).filter((x) => x.kind === 'move' && x.vy !== 0)).toEqual([]);
  });

  it('an estop right after resync in avoid keeps the pending avoid off', () => {
    const c = mk();
    c.update(0, inp({ avoidToggle: 1 }));
    c.update(100, N);
    c.resync(200);
    expect(c.estop(210)).toEqual([STOP]);
    expect(run(c, 226, 600)).toContainEqual({ kind: 'avoid', on: false });
  });
});
