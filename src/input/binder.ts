import type { Binding, PadSnapshot } from './mapping';

const THRESHOLD = 0.6;

/** Detect which control the user moved between baseline and current. Buttons win over axes. */
export function detectInput(baseline: PadSnapshot, current: PadSnapshot): Binding | null {
  let bestButton = -1;
  let bestButtonDelta = 0;
  current.buttons.forEach((v, i) => {
    const d = v - (baseline.buttons[i] ?? 0);
    if (d >= THRESHOLD && d > bestButtonDelta) {
      bestButton = i;
      bestButtonDelta = d;
    }
  });
  if (bestButton >= 0) return { type: 'button', index: bestButton };

  let bestAxis = -1;
  let bestAbs = 0;
  let bestDelta = 0;
  current.axes.forEach((v, i) => {
    const d = v - (baseline.axes[i] ?? 0);
    if (Math.abs(d) >= THRESHOLD && Math.abs(d) > bestAbs) {
      bestAxis = i;
      bestAbs = Math.abs(d);
      bestDelta = d;
    }
  });
  if (bestAxis < 0) return null;
  const rest = (baseline.axes[bestAxis] ?? 0) < -0.5 ? -1 : 0;
  return { type: 'axis', index: bestAxis, invert: rest === 0 && bestDelta < 0, rest };
}
