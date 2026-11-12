export interface PadSnapshot {
  axes: number[];
  buttons: number[]; // value 0..1
}
export type AxisBinding = { type: 'axis'; index: number; invert: boolean; rest: 0 | -1 };
export type ButtonBinding = { type: 'button'; index: number };
export type Binding = AxisBinding | ButtonBinding;

export const AXIS_FUNCTIONS = ['moveX', 'moveY', 'tiltPitch', 'tiltRoll'] as const;
export const BUTTON_FUNCTIONS = [
  'turnLeft', 'turnRight', 'heightUp', 'heightDown', 'estop', 'reset',
  'avoidToggle', 'balanceToggle', 'ledNext', 'action1', 'action2', 'action3', 'action4',
] as const;
export type AxisFunction = (typeof AXIS_FUNCTIONS)[number];
export type ButtonFunction = (typeof BUTTON_FUNCTIONS)[number];
export type ControlFunction = AxisFunction | ButtonFunction;

const ACTION_KEYS = ['action1', 'action2', 'action3', 'action4'] as const;
type ActionKey = (typeof ACTION_KEYS)[number];

export interface Mapping {
  version: 1;
  bindings: Partial<Record<ControlFunction, Binding>>;
  actionIds: Record<ActionKey, number>;
}

export const DEFAULT_ACTION_IDS: Mapping['actionIds'] = { action1: 1, action2: 2, action3: 4, action4: 5 };
export const DEADZONE = 0.15;
export const REQUIRED_FUNCTIONS: ControlFunction[] = ['moveX', 'moveY', 'estop'];

export interface ControlInput {
  axes: Record<AxisFunction, number>;
  buttons: Record<ButtonFunction, number>;
}

/** Signed deadzone with rescale to [-1, 1]. */
function deadzone(v: number): number {
  const a = Math.abs(v);
  if (a < DEADZONE) return 0;
  return Math.sign(v) * Math.min(1, (a - DEADZONE) / (1 - DEADZONE));
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

/**
 * Value of a binding as seen by a function. `signed` is true for axis functions
 * (result in [-1,1]); false for button functions (result in [0,1]).
 */
function readBinding(s: PadSnapshot, b: Binding, signed: boolean): number {
  if (b.type === 'button') return clamp01(s.buttons[b.index] ?? 0);
  const v = s.axes[b.index] ?? 0;
  if (b.rest === -1) {
    // Trigger-like axis: normalise to 0..1; cut noise near rest without rescaling.
    const x = clamp01(b.invert ? (1 - v) / 2 : (v + 1) / 2);
    return x < DEADZONE ? 0 : x;
  }
  const d = deadzone(b.invert ? -v : v);
  return signed ? d : Math.max(0, d);
}

export function readControls(s: PadSnapshot, m: Mapping): ControlInput {
  const axes = {} as Record<AxisFunction, number>;
  const buttons = {} as Record<ButtonFunction, number>;
  for (const f of AXIS_FUNCTIONS) {
    const b = m.bindings[f];
    axes[f] = b ? readBinding(s, b, true) : 0;
  }
  for (const f of BUTTON_FUNCTIONS) {
    const b = m.bindings[f];
    buttons[f] = b ? readBinding(s, b, false) : 0;
  }
  return { axes, buttons };
}

export function serializeMapping(m: Mapping): string {
  return JSON.stringify(m);
}

const ALL_FUNCTIONS: readonly string[] = [...AXIS_FUNCTIONS, ...BUTTON_FUNCTIONS];

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}
function isIndex(x: unknown): x is number {
  return typeof x === 'number' && Number.isInteger(x) && x >= 0;
}

function parseBinding(fn: string, raw: unknown): Binding {
  if (!isObj(raw) || !isIndex(raw.index)) throw new Error(`Invalid binding for ${fn}`);
  if (raw.type === 'button') return { type: 'button', index: raw.index };
  if (raw.type === 'axis') {
    if (typeof raw.invert !== 'boolean') throw new Error(`Invalid invert for ${fn}`);
    if (raw.rest !== 0 && raw.rest !== -1) throw new Error(`Invalid rest for ${fn}`);
    return { type: 'axis', index: raw.index, invert: raw.invert, rest: raw.rest };
  }
  throw new Error(`Invalid binding type for ${fn}`);
}

export function parseMapping(json: string): Mapping {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error('Mapping is not valid JSON');
  }
  if (!isObj(raw) || raw.version !== 1) throw new Error('Unsupported mapping version');
  if (!isObj(raw.bindings)) throw new Error('Mapping bindings missing');
  const bindings: Mapping['bindings'] = {};
  for (const [fn, b] of Object.entries(raw.bindings)) {
    if (!ALL_FUNCTIONS.includes(fn)) throw new Error(`Unknown function: ${fn}`);
    bindings[fn as ControlFunction] = parseBinding(fn, b);
  }
  if (!isObj(raw.actionIds)) throw new Error('Mapping actionIds missing');
  const actionIds = {} as Mapping['actionIds'];
  for (const k of ACTION_KEYS) {
    const v = raw.actionIds[k];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 50) {
      throw new Error(`Invalid action id for ${k}`);
    }
    actionIds[k] = v;
  }
  return { version: 1, bindings, actionIds };
}
