import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ACTION_IDS,
  readControls,
  parseMapping,
  serializeMapping,
  REQUIRED_FUNCTIONS,
  type Mapping,
} from '../../src/input/mapping';

const base = (b: Mapping['bindings']): Mapping => ({
  version: 1,
  bindings: b,
  actionIds: { ...DEFAULT_ACTION_IDS },
});
const snap = (axes: number[], buttons: number[] = []) => ({ axes, buttons });

describe('readControls', () => {
  it('returns every key as 0 when unbound', () => {
    const c = readControls(snap([1, 1]), base({}));
    expect(Object.keys(c.axes).sort()).toEqual(['moveX', 'moveY', 'tiltPitch', 'tiltRoll']);
    expect(Object.keys(c.buttons)).toHaveLength(13);
    expect(Object.values(c.axes).every((v) => v === 0)).toBe(true);
    expect(Object.values(c.buttons).every((v) => v === 0)).toBe(true);
  });
  it('applies deadzone and rescales', () => {
    const m = base({ moveX: { type: 'axis', index: 0, invert: false, rest: 0 } });
    expect(readControls(snap([0.1]), m).axes.moveX).toBe(0);
    expect(readControls(snap([-0.1]), m).axes.moveX).toBe(0);
    expect(readControls(snap([1]), m).axes.moveX).toBeCloseTo(1);
    expect(readControls(snap([-1]), m).axes.moveX).toBeCloseTo(-1);
    expect(readControls(snap([0.575]), m).axes.moveX).toBeCloseTo(0.5);
    expect(readControls(snap([-0.575]), m).axes.moveX).toBeCloseTo(-0.5);
  });
  it('inverts', () => {
    const m = base({ moveY: { type: 'axis', index: 0, invert: true, rest: 0 } });
    expect(readControls(snap([1]), m).axes.moveY).toBeCloseTo(-1);
    expect(readControls(snap([-1]), m).axes.moveY).toBeCloseTo(1);
  });
  it('trigger axis resting at -1 reads 0', () => {
    const m = base({ heightUp: { type: 'axis', index: 5, invert: false, rest: -1 } });
    const r = (v: number) => readControls(snap([0, 0, 0, 0, 0, v]), m).buttons.heightUp;
    expect(r(-1)).toBe(0);
    expect(r(1)).toBeCloseTo(1);
    expect(r(0)).toBeCloseTo(0.5);
  });
  it('rest -1 axis with invert reads (1 - v)/2', () => {
    const m = base({ heightUp: { type: 'axis', index: 0, invert: true, rest: -1 } });
    expect(readControls(snap([1]), m).buttons.heightUp).toBe(0);
    expect(readControls(snap([-1]), m).buttons.heightUp).toBeCloseTo(1);
  });
  it('axis on button function is max(0, signed value)', () => {
    const m = base({ turnLeft: { type: 'axis', index: 0, invert: false, rest: 0 } });
    expect(readControls(snap([1]), m).buttons.turnLeft).toBeCloseTo(1);
    expect(readControls(snap([-1]), m).buttons.turnLeft).toBe(0);
    expect(readControls(snap([0.05]), m).buttons.turnLeft).toBe(0);
  });
  it('button on axis function reads raw 0..1', () => {
    const m = base({ tiltPitch: { type: 'button', index: 2 } });
    expect(readControls(snap([], [0, 0, 0.7]), m).axes.tiltPitch).toBeCloseTo(0.7);
  });
  it('missing snapshot indices read 0', () => {
    const m = base({
      moveX: { type: 'axis', index: 9, invert: false, rest: 0 },
      estop: { type: 'button', index: 9 },
    });
    const c = readControls(snap([]), m);
    expect(c.axes.moveX).toBe(0);
    expect(c.buttons.estop).toBe(0);
  });
});

describe('mapping serialization', () => {
  const m = base({
    moveX: { type: 'axis', index: 0, invert: true, rest: 0 },
    heightUp: { type: 'axis', index: 5, invert: false, rest: -1 },
    estop: { type: 'button', index: 3 },
  });
  it('round-trips', () => {
    expect(parseMapping(serializeMapping(m))).toEqual(m);
  });
  it('REQUIRED_FUNCTIONS', () => {
    expect(REQUIRED_FUNCTIONS).toEqual(['moveX', 'moveY', 'estop']);
  });
  const good = () => JSON.parse(serializeMapping(m));
  it.each([
    ['empty object', () => '{}'],
    ['not json', () => 'nope'],
    ['version 2', () => JSON.stringify({ ...good(), version: 2 })],
    ['negative index', () => JSON.stringify({ ...good(), bindings: { estop: { type: 'button', index: -1 } } })],
    ['fractional index', () => JSON.stringify({ ...good(), bindings: { estop: { type: 'button', index: 1.5 } } })],
    ['unknown function', () => JSON.stringify({ ...good(), bindings: { fly: { type: 'button', index: 1 } } })],
    ['bad invert', () => JSON.stringify({ ...good(), bindings: { moveX: { type: 'axis', index: 0, invert: 1, rest: 0 } } })],
    ['bad rest', () => JSON.stringify({ ...good(), bindings: { moveX: { type: 'axis', index: 0, invert: false, rest: 1 } } })],
    ['bad type', () => JSON.stringify({ ...good(), bindings: { moveX: { type: 'dial', index: 0 } } })],
    ['missing actionIds', () => JSON.stringify({ version: 1, bindings: {} })],
    ['actionIds missing key', () => JSON.stringify({ ...good(), actionIds: { action1: 1, action2: 2, action3: 3 } })],
    ['actionId out of range', () => JSON.stringify({ ...good(), actionIds: { ...DEFAULT_ACTION_IDS, action1: 51 } })],
    ['actionId zero', () => JSON.stringify({ ...good(), actionIds: { ...DEFAULT_ACTION_IDS, action1: 0 } })],
    ['actionId non-integer', () => JSON.stringify({ ...good(), actionIds: { ...DEFAULT_ACTION_IDS, action1: 1.5 } })],
  ])('throws on %s', (_n, make) => {
    expect(() => parseMapping(make())).toThrow(Error);
  });
});
