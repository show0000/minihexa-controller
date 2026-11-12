import { afterEach, describe, expect, it, vi } from 'vitest';
import { STOP, type RobotCommand } from '../../src/protocol/commands';
import type { BleEvents } from '../../src/transport/ble';
import { Fanout } from '../../src/transport/fanout';
import { DISCONNECT_STOP_WAIT_MS, RobotLink, WALKING_WARNING, type RobotTransport } from '../../src/ui/robotLink';

const WALK: RobotCommand = { kind: 'move', vx: 0, vy: 50, turn: 0 };

class FakeTransport implements RobotTransport {
  sent: RobotCommand[] = [];
  connected = true;
  disconnectCalls = 0;
  constructor(readonly ev: BleEvents) {}
  send(c: RobotCommand): void {
    if (this.connected) this.sent.push(c);
  }
  disconnect(): void {
    this.disconnectCalls++;
    this.drop();
  }
  /** The link drops (or disconnect() completes). */
  drop(): void {
    if (!this.connected) return;
    this.connected = false;
    this.ev.onDisconnect();
  }
  written(c: RobotCommand, ok = true): void {
    this.ev.onWritten(c, ok);
  }
}

function setup(onConnected?: (fanout: Fanout) => void) {
  const simSent: RobotCommand[] = [];
  const fanout = new Fanout({ send: (c) => simSent.push(c), connected: true });
  let t: FakeTransport | null = null;
  const link = new RobotLink(
    fanout,
    () => (onConnected ? onConnected(fanout) : fanout.send(STOP)),
    {
      connect: async (ev) => (t = new FakeTransport(ev)),
      bluetoothAvailable: () => true,
    },
  );
  return { link, fanout, simSent, transport: () => t! };
}

async function connected(onConnected?: (fanout: Fanout) => void) {
  const s = setup(onConnected);
  await s.link.connect();
  return s;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('RobotLink: walking belief follows written commands, not queued ones', () => {
  it('after connecting, the robot may be walking until the resync STOP write succeeds', async () => {
    const { link, transport } = await connected();
    expect(link.state).toBe('connected');
    expect(transport().sent).toEqual([STOP]);
    expect(link.robotMayWalk).toBe(true);
    transport().written(STOP);
    expect(link.robotMayWalk).toBe(false);
  });

  it('a move that was only queued (never written) does not raise the warning on link loss', async () => {
    const { link, fanout, transport } = await connected();
    transport().written(STOP);
    fanout.send(WALK);
    transport().drop();
    expect(link.state).toBe('disconnected');
    expect(link.warning).toBeNull();
  });

  it('a written non-zero move raises the warning on link loss', async () => {
    const { link, fanout, transport } = await connected();
    transport().written(STOP);
    fanout.send(WALK);
    transport().written(WALK);
    expect(link.robotMayWalk).toBe(true);
    expect(link.warning).toBeNull();
    transport().drop();
    expect(link.warning).toBe(WALKING_WARNING);
  });

  it('an unconfirmed (failed) non-zero move still counts as walking', async () => {
    const { link, transport } = await connected();
    transport().written(STOP);
    transport().written(WALK, false);
    transport().drop();
    expect(link.warning).toBe(WALKING_WARNING);
  });

  it('a STOP that was queued but not yet written does not clear the warning state', async () => {
    const { link, fanout, transport } = await connected();
    transport().written(STOP);
    transport().written(WALK);
    fanout.send(STOP); // queued only
    transport().drop();
    expect(link.warning).toBe(WALKING_WARNING);
  });

  it('a failed STOP write keeps the robot possibly walking and shows the warning at once', async () => {
    const { link, transport } = await connected();
    transport().written(STOP);
    transport().written(WALK);
    transport().written(STOP, false);
    expect(link.robotMayWalk).toBe(true);
    expect(link.warning).toBe(WALKING_WARNING);
    transport().drop();
    expect(link.warning).toBe(WALKING_WARNING);
  });

  it('a failed STOP after a confirmed stop still raises the flag (conservative)', async () => {
    const { link, transport } = await connected();
    transport().written(STOP);
    transport().written(STOP, false);
    expect(link.robotMayWalk).toBe(true);
  });

  it('a successful STOP write clears the flag and the warning', async () => {
    const { link, transport } = await connected();
    transport().written(WALK);
    transport().written(STOP, false);
    expect(link.warning).toBe(WALKING_WARNING);
    transport().written(STOP);
    expect(link.robotMayWalk).toBe(false);
    expect(link.warning).toBeNull();
    transport().drop();
    expect(link.warning).toBeNull();
  });

  it('a successful reset write clears the flag', async () => {
    const { link, transport } = await connected();
    transport().written(WALK);
    transport().written({ kind: 'reset' });
    expect(link.robotMayWalk).toBe(false);
  });

  it('avoid on (written or not confirmed) counts as walking', async () => {
    for (const ok of [true, false]) {
      const { link, transport } = await connected();
      transport().written(STOP);
      transport().written({ kind: 'avoid', on: true }, ok);
      expect(link.robotMayWalk).toBe(true);
    }
  });

  it('a STOP confirmation timeout shows the warning while still connected', async () => {
    const { link, transport } = await connected();
    transport().written(STOP);
    transport().written(WALK);
    transport().ev.onStopTimeout();
    expect(link.state).toBe('connected');
    expect(link.robotMayWalk).toBe(true);
    expect(link.warning).toBe(WALKING_WARNING);
  });

  it('a warning from an earlier session stays until the new session confirms a STOP', async () => {
    const { link, transport } = await connected();
    transport().written(WALK);
    transport().drop();
    expect(link.warning).toBe(WALKING_WARNING);
    await link.connect();
    expect(link.warning).toBe(WALKING_WARNING);
    transport().written(STOP);
    expect(link.warning).toBeNull();
  });

  it('events from a previous transport are ignored', async () => {
    const { link, transport } = await connected();
    const old = transport();
    old.drop();
    await link.connect();
    transport().written(STOP);
    old.written(WALK);
    expect(link.robotMayWalk).toBe(false);
  });
});

describe('RobotLink: user disconnect waits for a confirmed STOP', () => {
  it('detaches from the Fanout, sends a STOP and disconnects once it is written', async () => {
    const { link, fanout, transport } = await connected();
    transport().written(STOP);
    transport().written(WALK);
    const done = link.disconnect();
    expect(link.state).toBe('disconnecting');
    expect(fanout.connected).toBe(false); // later controller output no longer reaches the robot
    expect(transport().sent.at(-1)).toEqual(STOP);
    expect(transport().disconnectCalls).toBe(0);
    transport().written(STOP);
    await done;
    expect(transport().disconnectCalls).toBe(1);
    expect(link.state).toBe('disconnected');
    expect(link.warning).toBeNull();
  });

  it(`disconnects after ${DISCONNECT_STOP_WAIT_MS}ms without a confirmed STOP and shows the warning`, async () => {
    vi.useFakeTimers();
    const { link, transport } = await connected();
    transport().written(STOP);
    const done = link.disconnect();
    await vi.advanceTimersByTimeAsync(DISCONNECT_STOP_WAIT_MS - 1);
    expect(transport().disconnectCalls).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(transport().disconnectCalls).toBe(1);
    expect(link.state).toBe('disconnected');
    expect(link.warning).toBe(WALKING_WARNING);
  });

  it('a failed STOP during disconnect is not a confirmation', async () => {
    vi.useFakeTimers();
    const { link, transport } = await connected();
    transport().written(STOP);
    const done = link.disconnect();
    transport().written(STOP, false);
    await vi.advanceTimersByTimeAsync(DISCONNECT_STOP_WAIT_MS);
    await done;
    expect(link.warning).toBe(WALKING_WARNING);
  });

  it('a trailing STOP still in flight when the link closes does not raise a false warning', async () => {
    const { link, transport } = await connected();
    transport().written(WALK);
    const done = link.disconnect();
    // The controller's e-stop STOP is confirmed; the link's own STOP is now in flight and the
    // real transport reports it unconfirmed when disconnect() closes the link.
    const t = transport();
    t.disconnect = () => {
      t.disconnectCalls++;
      t.ev.onWritten(STOP, false);
      t.drop();
    };
    t.written(STOP);
    await done;
    expect(t.disconnectCalls).toBe(1);
    expect(link.state).toBe('disconnected');
    expect(link.warning).toBeNull();
  });

  it('a second disconnect while waiting is ignored', async () => {
    const { link, transport } = await connected();
    const a = link.disconnect();
    const b = link.disconnect();
    transport().written(STOP);
    await Promise.all([a, b]);
    expect(transport().sent.filter((c) => c === STOP || c.kind === 'move')).toHaveLength(2); // resync + one
    expect(transport().disconnectCalls).toBe(1);
  });

  it('the link dropping while waiting ends the wait with the usual warning logic', async () => {
    const { link, transport } = await connected();
    transport().written(STOP);
    transport().written(WALK);
    const done = link.disconnect();
    transport().drop();
    await done;
    expect(link.state).toBe('disconnected');
    expect(link.warning).toBe(WALKING_WARNING);
    expect(transport().disconnectCalls).toBe(0);
  });
});

describe('RobotLink: connect failures', () => {
  it('rolls back when onConnected throws and warns that the robot may be walking', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { link, fanout, transport } = await connected(() => {
      throw new Error('resync broke');
    });
    err.mockRestore();
    expect(link.state).toBe('disconnected');
    expect(transport().disconnectCalls).toBe(1);
    expect(fanout.connected).toBe(false);
    expect(link.telemetry).toBeNull();
    expect(link.notice).toContain('resync broke');
    expect(link.warning).toBe(WALKING_WARNING); // no STOP was confirmed: state unknown
  });

  it('reports a failed connect and stays disconnected', async () => {
    const fanout = new Fanout({ send: () => {}, connected: true });
    const link = new RobotLink(fanout, () => {}, {
      connect: async () => {
        throw new Error('gatt fail');
      },
      bluetoothAvailable: () => true,
    });
    await link.connect();
    expect(link.state).toBe('disconnected');
    expect(link.notice).toContain('gatt fail');
  });

  it('says so when Web Bluetooth is missing', async () => {
    const fanout = new Fanout({ send: () => {}, connected: true });
    const link = new RobotLink(fanout, () => {}, { bluetoothAvailable: () => false });
    await link.connect();
    expect(link.state).toBe('disconnected');
    expect(link.notice).toContain('Web Bluetooth');
  });
});
