import { afterEach, describe, expect, it, vi } from 'vitest';
import { Controller, SEND_INTERVAL_MS } from '../../src/control/controller';
import { DEFAULT_ACTION_IDS, readControls } from '../../src/input/mapping';
import { emptyMapping } from '../../src/ui/mappingStore';
import { STOP, type RobotCommand } from '../../src/protocol/commands';
import { startHiddenTick } from '../../src/ui/hiddenTick';

const NEUTRAL = readControls({ axes: [], buttons: [] }, emptyMapping());

afterEach(() => {
  vi.useRealTimers();
});

describe('startHiddenTick', () => {
  it('ticks every interval only while hidden', () => {
    vi.useFakeTimers();
    let hidden = false;
    const tick = vi.fn();
    startHiddenTick({ isHidden: () => hidden, tick, intervalMs: 50 });
    vi.advanceTimersByTime(200);
    expect(tick).not.toHaveBeenCalled();
    hidden = true;
    vi.advanceTimersByTime(200);
    expect(tick).toHaveBeenCalledTimes(4);
  });

  it('keeps ticking after a tick throws, and stops when asked', () => {
    vi.useFakeTimers();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const tick = vi.fn(() => {
      throw new Error('boom');
    });
    const stop = startHiddenTick({ isHidden: () => true, tick, intervalMs: 50 });
    vi.advanceTimersByTime(100);
    expect(tick).toHaveBeenCalledTimes(2);
    stop();
    vi.advanceTimersByTime(100);
    expect(tick).toHaveBeenCalledTimes(2);
    err.mockRestore();
  });

  it('flushes the controller STOP repeats while the tab is hidden (no rAF)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const c = new Controller({ ...DEFAULT_ACTION_IDS });
    const sent: RobotCommand[] = [];
    const walk = { axes: { ...NEUTRAL.axes, moveY: 1 }, buttons: NEUTRAL.buttons };
    sent.push(...c.update(0, walk));
    expect(sent).toEqual([{ kind: 'move', vx: 0, vy: 50, turn: 0 }]);
    sent.length = 0;
    // The visibilitychange handler sends this directly; afterwards only the ticker runs.
    sent.push(...c.hidden(Date.now()));
    startHiddenTick({
      isHidden: () => true,
      tick: () => sent.push(...c.update(Date.now(), NEUTRAL)),
      intervalMs: SEND_INTERVAL_MS,
    });
    vi.advanceTimersByTime(300);
    expect(sent).toEqual([STOP, STOP, STOP]);
  });
});
