/** Picks the gamepad in use and turns it into a PadSnapshot. */
import type { PadSnapshot } from '../input/mapping';

export class PadTracker {
  /** Index of the pad in use; null when none is connected. */
  index: number | null = null;

  /** The pad in use: the tracked one if still connected, else the first connected pad. */
  current(): Gamepad | null {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const tracked = this.index === null ? null : pads[this.index];
    if (tracked && tracked.connected) return tracked;
    for (const p of pads) {
      if (p && p.connected) {
        this.index = p.index;
        return p;
      }
    }
    this.index = null;
    return null;
  }
}

export function snapshot(gp: Gamepad): PadSnapshot {
  return {
    axes: Array.from(gp.axes, (v) => (Number.isFinite(v) ? v : 0)),
    buttons: Array.from(gp.buttons, (b) => (b.value > 0 ? b.value : b.pressed ? 1 : 0)),
  };
}
