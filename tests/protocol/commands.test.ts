import { describe, expect, it } from 'vitest';
import { STOP, commandsEqual, encodeCommand, parseTelemetry } from '../../src/protocol/commands';

describe('encodeCommand', () => {
  it('encodes move with clamp and rounding', () => {
    expect(encodeCommand({ kind: 'move', vx: 10, vy: -20, turn: 1 })).toBe('C|10|-20|1&');
    expect(encodeCommand({ kind: 'move', vx: 99, vy: -99, turn: 0 })).toBe('C|50|-50|0&');
    expect(encodeCommand({ kind: 'move', vx: 10.6, vy: 0, turn: 0 })).toBe('C|11|0|0&');
  });
  it('encodes pose with clamp', () => {
    expect(encodeCommand({ kind: 'pose', yaw: 0, pitch: 5, roll: -5, x: 0, y: 0, z: 40 })).toBe('F|0|5|-5|0|0|30&');
    expect(encodeCommand({ kind: 'pose', yaw: 0, pitch: 0, roll: 0, x: 0, y: 0, z: -3 })).toBe('F|0|0|0|0|0|0&');
  });
  it('encodes action and validates id', () => {
    expect(encodeCommand({ kind: 'action', id: 4 })).toBe('K|1|4&');
    expect(() => encodeCommand({ kind: 'action', id: 0 })).toThrow(RangeError);
    expect(() => encodeCommand({ kind: 'action', id: 51 })).toThrow(RangeError);
  });
  it('encodes led, avoid, balance, reset', () => {
    expect(encodeCommand({ kind: 'led', r: 300, g: -1, b: 178 })).toBe('H|255|0|178&');
    expect(encodeCommand({ kind: 'avoid', on: true })).toBe('I|1&');
    expect(encodeCommand({ kind: 'balance', on: false })).toBe('J|0&');
    expect(encodeCommand({ kind: 'reset' })).toBe('O&');
  });
});

describe('parseTelemetry', () => {
  it('parses valid and rejects invalid', () => {
    expect(parseTelemetry('$7400$215$')).toEqual({ batteryMv: 7400, distance: 215 });
    expect(parseTelemetry('$7400$')).toBeNull();
    expect(parseTelemetry('garbage')).toBeNull();
  });
});

describe('commandsEqual', () => {
  it('compares by encoding', () => {
    expect(commandsEqual(STOP, { kind: 'move', vx: 0, vy: 0, turn: 0 })).toBe(true);
    expect(commandsEqual(STOP, { kind: 'reset' })).toBe(false);
  });
});
