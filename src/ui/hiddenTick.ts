/**
 * requestAnimationFrame does not run in a hidden tab, so the controller's pending STOP repeats
 * (and a deferred e-stop at the end of an action lock) would never go out. While the page is
 * hidden, tick the controller from a timer instead. Chrome throttles timers in hidden tabs
 * (about once per second), which still delivers the repeats, only later.
 */
export interface HiddenTickOptions {
  isHidden: () => boolean;
  tick: () => void;
  intervalMs: number;
}

/** Start ticking; returns a function that stops it. */
export function startHiddenTick({ isHidden, tick, intervalMs }: HiddenTickOptions): () => void {
  const id = setInterval(() => {
    if (!isHidden()) return;
    try {
      tick();
    } catch (e) {
      console.error('hidden tick failed', e);
    }
  }, intervalMs);
  return () => clearInterval(id);
}
