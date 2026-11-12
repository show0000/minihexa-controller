import { describe, expect, it } from 'vitest';
import { detectInput } from '../../src/input/binder';

const s = (axes: number[], buttons: number[] = []) => ({ axes, buttons });

describe('detectInput', () => {
  it('detects button press', () => {
    expect(detectInput(s([], [0, 0, 0, 0]), s([], [0, 0, 0, 1]))).toEqual({ type: 'button', index: 3 });
  });
  it('detects negative axis push as inverted', () => {
    expect(detectInput(s([0, 0]), s([0, -0.9]))).toEqual({ type: 'axis', index: 1, invert: true, rest: 0 });
  });
  it('detects positive axis push', () => {
    expect(detectInput(s([0.9, 0]), s([0, 0]))).toEqual({ type: 'axis', index: 0, invert: true, rest: 0 });
    expect(detectInput(s([0]), s([0.9]))).toEqual({ type: 'axis', index: 0, invert: false, rest: 0 });
  });
  it('detects trigger axis resting at -1', () => {
    const b = [0, 0, 0, 0, 0, -1];
    const c = [0, 0, 0, 0, 0, 0.9];
    expect(detectInput(s(b), s(c))).toEqual({ type: 'axis', index: 5, invert: false, rest: -1 });
  });
  it('returns null for small change', () => {
    expect(detectInput(s([0], [0]), s([0.5], [0.5]))).toBeNull();
  });
  it('prefers button over axis', () => {
    expect(detectInput(s([0], [0]), s([1], [1]))).toEqual({ type: 'button', index: 0 });
  });
  it('picks the largest change', () => {
    expect(detectInput(s([0, 0]), s([0.7, 1]))).toEqual({ type: 'axis', index: 1, invert: false, rest: 0 });
  });
});
