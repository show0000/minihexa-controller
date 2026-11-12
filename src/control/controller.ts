import { STOP, commandsEqual, type RobotCommand, type Turn } from '../protocol/commands';
import { BUTTON_FUNCTIONS, type ButtonFunction, type ControlInput } from '../input/mapping';
import { actionDurationMs } from './actions';

export type ControllerMode = 'manual' | 'avoid' | 'balance' | 'action';

export interface ControllerStatus {
  mode: ControllerMode;
  actionEndsAt: number | null;
  estopPending: boolean;
  z: number;
  /** After an e-stop, moves stay suppressed until the move input returns to neutral. */
  stickLatched: boolean;
}

export const SEND_INTERVAL_MS = 50;
export const ACTION_MARGIN_MS = 500;
export const HEIGHT_RATE_PER_S = 15;
export const DEFAULT_Z = 10;
/** Max time step used for height integration (a stalled frame must not jump the height). */
const MAX_DT_MS = 100;
const Z_MIN = 0;
const Z_MAX = 30;
const AXIS_SCALE = 50;
const PRESSED = 0.5;
/** How many extra STOPs follow each STOP (one per free send slot). */
const STOP_REPEATS = 2;

/** Scale an axis to an integer command value; non-finite input counts as neutral. */
function scaled(v: number): number {
  return Number.isFinite(v) ? Math.round(v * AXIS_SCALE) + 0 : 0; // +0 normalizes -0
}

export const LED_PALETTE: [number, number, number][] = [
  [0, 237, 178], // firmware default
  [255, 0, 0],
  [255, 160, 0],
  [255, 255, 255],
  [0, 80, 255],
  [200, 0, 255],
];

type ActionKey = 'action1' | 'action2' | 'action3' | 'action4';
const ACTION_KEYS: readonly ActionKey[] = ['action1', 'action2', 'action3', 'action4'];

/** A button-triggered command waiting for a send slot. */
type Intent =
  | { kind: 'avoid' }
  | { kind: 'balance' }
  | { kind: 'reset' }
  | { kind: 'led' }
  | { kind: 'action'; id: number }
  /** Turn a firmware mode off after a resync STOP (the STOP keeps its own slot). */
  | { kind: 'off'; mode: 'avoid' | 'balance' };

const NEUTRAL_POSE = (z: number): RobotCommand => ({
  kind: 'pose', yaw: 0, pitch: 0, roll: 0, x: 0, y: 0, z: Math.round(z),
});

/**
 * Turns per-frame gamepad input into robot commands (at most one per update).
 *
 * Safety model: the firmware keeps only the last command and latches walking, so
 * STOP, avoid-off and balance-off bypass the 50ms rate limit; everything else
 * takes one send slot per SEND_INTERVAL_MS. `lastMove` tracks what we believe the
 * robot is doing, so a change of the robot's own state (action end, reset, mode
 * exit) makes a held stick re-send.
 */
export class Controller {
  private mode: ControllerMode = 'manual';
  private actionEndsAt: number | null = null;
  private estopPending = false;
  private z = DEFAULT_Z;

  private lastMove: RobotCommand = STOP;
  /** null = unknown (after an action the firmware keeps its own att/pos): always re-send. */
  private lastPose: RobotCommand | null = NEUTRAL_POSE(DEFAULT_Z);
  private lastSlotAt = -Infinity;
  private lastSlotKind: 'move' | 'pose' | null = null;
  private lastUpdateAt: number | null = null;
  /** null = do not detect edges on the next update (state of buttons unknown). */
  private prevPressed: Set<ButtonFunction> | null = new Set();
  private queue: Intent[] = [];
  private ledIndex = 0;
  /** After an e-stop, moves stay suppressed until the move input returns to neutral. */
  private moveLatched = false;
  /** Extra STOPs still to send, one per free slot, in case the firmware dropped one. */
  private stopRepeats = 0;

  private actionIds: Record<ActionKey, number>;

  constructor(actionIds: Record<ActionKey, number>) {
    this.actionIds = { ...actionIds };
  }

  /** Change the action ids bound to action1..4. Mode, height and send state are kept. */
  setActionIds(ids: Record<ActionKey, number>): void {
    this.actionIds = { ...ids };
  }

  status(): ControllerStatus {
    return {
      mode: this.mode,
      actionEndsAt: this.actionEndsAt,
      estopPending: this.estopPending,
      z: this.z,
      stickLatched: this.moveLatched,
    };
  }

  update(now: number, input: ControlInput): RobotCommand[] {
    const dtMs = this.lastUpdateAt === null ? 0 : Math.min(MAX_DT_MS, Math.max(0, now - this.lastUpdateAt));
    this.lastUpdateAt = now;
    const edges = this.edges(input);

    if (edges.has('estop')) return this.estop(now);

    if (this.mode === 'action') {
      if (this.actionEndsAt !== null && now < this.actionEndsAt) return [];
      // Lock over. The firmware's global velocity is 0 because a STOP always goes out
      // before an action (see update). Its global att/pos are left as they were before
      // the action, not what the script ended with, so the pose belief is unknown.
      this.mode = 'manual';
      this.actionEndsAt = null;
      this.lastMove = STOP;
      this.lastPose = null;
      if (this.estopPending) {
        this.estopPending = false;
        this.moveLatched = true;
        return [this.emitStop(now)];
      }
    }

    const desiredMove = this.moveFrom(input);

    if (this.mode === 'avoid' || this.mode === 'balance') {
      const tilted = !commandsEqual(this.poseFrom(input), NEUTRAL_POSE(this.z));
      if (edges.size > 0 || !commandsEqual(desiredMove, STOP) || tilted) return [this.exitMode(now)];
      return [];
    }

    // manual
    this.integrateHeight(input, dtMs);
    for (const f of BUTTON_FUNCTIONS) {
      if (!edges.has(f)) continue;
      const intent = this.intentFor(f);
      if (intent) this.queue.push(intent);
    }

    if (this.moveLatched && commandsEqual(desiredMove, STOP)) this.moveLatched = false;
    const wantMove = this.moveLatched ? STOP : desiredMove;
    const wantStop = commandsEqual(wantMove, STOP);

    // Safety: stop immediately, regardless of the rate limit.
    if (wantStop && !commandsEqual(this.lastMove, STOP)) return [this.emitStop(now)];

    // Firmware actions and balance-on run with the stale global velocity, and pose or
    // balance-off would restart walking with it. Zero it first; the intent waits for
    // the next slot.
    const next = this.queue[0];
    if (next && next.kind !== 'reset' && next.kind !== 'led' && !commandsEqual(this.lastMove, STOP)) {
      return [this.emitStop(now)];
    }

    if (now - this.lastSlotAt < SEND_INTERVAL_MS) return [];

    const intent = this.queue.shift();
    if (intent) {
      this.lastSlotAt = now;
      if (intent.kind !== 'off') this.stopRepeats = 0; // a mode-off keeps the STOP repeats coming
      return [this.apply(intent, now)];
    }

    // Repeats are cancelled only by a non-STOP move actually going out (below), not by input
    // that never got a slot; while the stick is pushed, the move takes the slot instead.
    if (this.stopRepeats > 0 && wantStop) {
      this.stopRepeats--;
      this.lastSlotAt = now;
      return [STOP];
    }

    const desiredPose = this.poseFrom(input);
    const movePending = !commandsEqual(wantMove, this.lastMove);
    const posePending = this.lastPose === null || !commandsEqual(desiredPose, this.lastPose);
    if (!movePending && !posePending) return [];

    const sendMove = movePending && (!posePending || this.lastSlotKind !== 'move');
    this.lastSlotAt = now;
    if (sendMove) {
      if (!wantStop) this.stopRepeats = 0;
      this.lastMove = wantMove;
      this.lastSlotKind = 'move';
      return [wantMove];
    }
    this.lastPose = desiredPose;
    this.lastSlotKind = 'pose';
    return [desiredPose];
  }

  gamepadLost(now: number): RobotCommand[] {
    const out = this.halt(now);
    this.prevPressed = null; // a reconnected pad may come back with buttons held
    return out;
  }

  hidden(now: number): RobotCommand[] {
    const out = this.halt(now);
    this.prevPressed = null;
    return out;
  }

  /**
   * After (re)connecting a robot whose state is unknown (it may still be walking from an
   * earlier session): STOP immediately in every mode, with repeats and the stick latch as for
   * an e-stop. Avoid/balance are turned off in a later slot; an action lock is dropped (the new
   * robot is not running it). The pose is treated as unknown so it is re-sent after the STOP.
   */
  resync(now: number): RobotCommand[] {
    const was = this.mode;
    this.queue = [];
    this.mode = 'manual';
    this.actionEndsAt = null;
    this.estopPending = false;
    if (was === 'avoid' || was === 'balance') this.queue.push({ kind: 'off', mode: was });
    this.moveLatched = true;
    this.lastPose = null;
    return [this.emitStop(now)];
  }

  estop(now: number): RobotCommand[] {
    const out = this.halt(now);
    this.moveLatched = true;
    return out;
  }

  /**
   * Send STOP now (bypassing the rate limit), but let it occupy the slot: the firmware
   * keeps one receive buffer per loop, so a command right behind it could overwrite it.
   * Then repeat it in the next free slots while nothing else needs sending.
   */
  private emitStop(now: number): RobotCommand {
    this.lastMove = STOP;
    this.lastSlotAt = now;
    this.stopRepeats = STOP_REPEATS;
    return STOP;
  }

  /** Shared stop path for e-stop, gamepad loss and page hide. */
  private halt(now: number): RobotCommand[] {
    // Keep a pending mode-off from resync: it is part of stopping.
    this.queue = this.queue.filter((i) => i.kind === 'off');
    switch (this.mode) {
      case 'action':
        this.estopPending = true;
        return [];
      case 'avoid':
      case 'balance':
        return [this.exitMode(now)];
      case 'manual':
        return [this.emitStop(now)];
    }
  }

  /**
   * Leave avoid/balance. The firmware's velocity is zero afterwards (a STOP went out
   * before the mode was entered). Like STOP, it bypasses the rate limit but occupies the slot.
   */
  private exitMode(now: number): RobotCommand {
    const kind = this.mode === 'avoid' ? 'avoid' : 'balance';
    this.mode = 'manual';
    this.queue = [];
    this.lastMove = STOP;
    this.lastSlotAt = now;
    return { kind, on: false };
  }

  private edges(input: ControlInput): Set<ButtonFunction> {
    const pressed = new Set<ButtonFunction>();
    for (const f of BUTTON_FUNCTIONS) if (input.buttons[f] >= PRESSED) pressed.add(f);
    const prev = this.prevPressed;
    this.prevPressed = pressed;
    const edges = new Set<ButtonFunction>();
    if (prev === null) return edges;
    for (const f of pressed) if (!prev.has(f)) edges.add(f);
    return edges;
  }

  private intentFor(f: ButtonFunction): Intent | null {
    switch (f) {
      case 'avoidToggle': return { kind: 'avoid' };
      case 'balanceToggle': return { kind: 'balance' };
      case 'reset': return { kind: 'reset' };
      case 'ledNext': return { kind: 'led' };
      default: {
        const k = ACTION_KEYS.find((a) => a === f);
        return k ? { kind: 'action', id: this.actionIds[k] } : null;
      }
    }
  }

  private apply(intent: Intent, now: number): RobotCommand {
    switch (intent.kind) {
      case 'avoid':
      case 'balance':
        this.mode = intent.kind;
        this.queue = [];
        return { kind: intent.kind, on: true };
      case 'off':
        return { kind: intent.mode, on: false };
      case 'reset':
        this.z = DEFAULT_Z;
        this.lastPose = NEUTRAL_POSE(DEFAULT_Z);
        this.lastMove = STOP;
        return { kind: 'reset' };
      case 'led': {
        this.ledIndex = (this.ledIndex + 1) % LED_PALETTE.length;
        const [r, g, b] = LED_PALETTE[this.ledIndex]!;
        return { kind: 'led', r, g, b };
      }
      case 'action':
        this.mode = 'action';
        this.actionEndsAt = now + actionDurationMs(intent.id) + ACTION_MARGIN_MS;
        this.queue = [];
        return { kind: 'action', id: intent.id };
    }
  }

  private moveFrom(input: ControlInput): RobotCommand {
    const left = input.buttons.turnLeft >= PRESSED;
    const right = input.buttons.turnRight >= PRESSED;
    const turn: Turn = left === right ? 0 : left ? 1 : 2;
    return {
      kind: 'move',
      vx: scaled(input.axes.moveX),
      vy: scaled(input.axes.moveY),
      turn,
    };
  }

  private poseFrom(input: ControlInput): RobotCommand {
    return {
      kind: 'pose',
      yaw: 0,
      pitch: scaled(input.axes.tiltPitch),
      roll: scaled(input.axes.tiltRoll),
      x: 0,
      y: 0,
      z: Math.round(this.z),
    };
  }

  private integrateHeight(input: ControlInput, dtMs: number): void {
    const dir = input.buttons.heightUp - input.buttons.heightDown;
    if (!Number.isFinite(dir) || dir === 0 || dtMs === 0) return;
    const z = this.z + dir * HEIGHT_RATE_PER_S * (dtMs / 1000);
    this.z = Math.min(Z_MAX, Math.max(Z_MIN, z));
  }
}
