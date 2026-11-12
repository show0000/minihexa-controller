import { describe, it, expect, vi, afterEach } from 'vitest';
import { STOP, encodeCommand, type RobotCommand } from '../../src/protocol/commands';
import { BleTransport, STOP_CONFIRM_MS, chunkAscii, type WritableChar } from '../../src/transport/ble';

const dec = new TextDecoder();
const text = (v: BufferSource) =>
  dec.decode(v instanceof ArrayBuffer ? v : new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
const flush = () => new Promise((r) => setTimeout(r, 0));

function events() {
  return {
    onTelemetry: vi.fn(),
    onDisconnect: vi.fn(),
    onError: vi.fn(),
    onWritten: vi.fn<(cmd: RobotCommand, ok: boolean) => void>(),
    onStopTimeout: vi.fn(),
  };
}
function manualChar() {
  const writes: string[] = [];
  const resolvers: Array<{ ok: () => void; fail: (e: unknown) => void }> = [];
  const c: WritableChar = {
    writeValueWithResponse(v) {
      writes.push(text(v));
      return new Promise<void>((ok, fail) => resolvers.push({ ok, fail }));
    },
  };
  return { c, writes, resolvers };
}
function dv(s: string) {
  const b = new TextEncoder().encode(s);
  return new DataView(b.buffer);
}

describe('chunkAscii', () => {
  it('short string is one chunk', () => {
    expect(chunkAscii('F|0|5|-5|0|0|30&', 20)).toEqual(['F|0|5|-5|0|0|30&']);
  });
  it('45 chars -> 20,20,5', () => {
    const parts = chunkAscii('x'.repeat(45), 20);
    expect(parts.map((p) => p.length)).toEqual([20, 20, 5]);
  });
});

describe('BleTransport', () => {
  it('serializes writes', async () => {
    const { c, writes, resolvers } = manualChar();
    const t = new BleTransport(c, events());
    t.send({ kind: 'move', vx: 0, vy: 50, turn: 0 });
    t.send({ kind: 'move', vx: 0, vy: 0, turn: 0 });
    await flush();
    expect(writes).toEqual(['C|0|50|0&']);
    resolvers[0]!.ok();
    await flush();
    expect(writes).toEqual(['C|0|50|0&', 'C|0|0|0&']);
    resolvers[1]!.ok();
    await flush();
    expect(writes.join('')).toBe('C|0|50|0&C|0|0|0&');
  });

  it('splits long commands into <=20 byte writes in order', async () => {
    const { c, writes, resolvers } = manualChar();
    const t = new BleTransport(c, events());
    t.send({ kind: 'pose', yaw: -50, pitch: -50, roll: -50, x: -50, y: -50, z: 30 });
    for (let i = 0; i < 5; i++) {
      await flush();
      resolvers[i]?.ok();
    }
    await flush();
    expect(writes.every((w) => w.length <= 20)).toBe(true);
    expect(writes.join('')).toBe('F|-50|-50|-50|-50|-50|30&');
  });

  it('write failure reports and does not throw', async () => {
    const onError = vi.fn();
    const writes: string[] = [];
    let fail = true;
    const c: WritableChar = {
      async writeValueWithResponse(v) {
        writes.push(text(v));
        if (fail) {
          fail = false;
          throw new Error('gatt');
        }
      },
    };
    const t = new BleTransport(c, { ...events(), onError });
    expect(() => t.send({ kind: 'reset' })).not.toThrow();
    await flush();
    expect(onError).toHaveBeenCalledTimes(1);
    t.send({ kind: 'reset' });
    await flush();
    expect(writes).toEqual(['O&', 'O&']);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('decodes telemetry notifications; ignores garbage', () => {
    const ev = events();
    const t = new BleTransport(manualChar().c, ev);
    t.handleNotification(dv('$7400$215$'));
    expect(ev.onTelemetry).toHaveBeenCalledWith({ batteryMv: 7400, distance: 215 });
    t.handleNotification(dv('garbage'));
    expect(ev.onTelemetry).toHaveBeenCalledTimes(1);
  });

  it('disconnect: connected false, onDisconnect once, send is a no-op', async () => {
    const ev = events();
    const { c, writes } = manualChar();
    const t = new BleTransport(c, ev);
    expect(t.connected).toBe(true);
    t.handleDisconnected();
    t.handleDisconnected();
    expect(t.connected).toBe(false);
    expect(ev.onDisconnect).toHaveBeenCalledTimes(1);
    expect(() => t.send({ kind: 'reset' })).not.toThrow();
    await flush();
    expect(writes).toEqual([]);
  });

  it('flushes a stale fragment with a lone & before the next command', async () => {
    const stream: string[] = [];
    let n = 0;
    const c: WritableChar = {
      async writeValueWithResponse(v) {
        n++;
        if (n === 2) throw new Error('chunk2'); // pose chunk 2 fails
        stream.push(text(v));
      },
    };
    const onError = vi.fn();
    const t = new BleTransport(c, { ...events(), onError });
    t.send({ kind: 'pose', yaw: -50, pitch: -50, roll: -50, x: -50, y: -50, z: 30 });
    await flush();
    expect(onError).toHaveBeenCalledTimes(1);
    stream.length = 0;
    t.send({ kind: 'move', vx: 0, vy: 0, turn: 0 });
    await flush();
    expect(stream.join('')).toBe('&C|0|0|0&');
  });

  it('failure on chunk 1 does not trigger a flush', async () => {
    const stream: string[] = [];
    let n = 0;
    const c: WritableChar = {
      async writeValueWithResponse(v) {
        n++;
        if (n === 1) throw new Error('chunk1');
        stream.push(text(v));
      },
    };
    const t = new BleTransport(c, events());
    t.send({ kind: 'pose', yaw: -50, pitch: -50, roll: -50, x: -50, y: -50, z: 30 });
    await flush();
    t.send({ kind: 'move', vx: 0, vy: 0, turn: 0 });
    await flush();
    expect(stream.join('')).toBe('C|0|0|0&');
  });

  it('worst-case move command is a single chunk', () => {
    const s = encodeCommand({ kind: 'move', vx: -50, vy: -50, turn: 0 });
    expect(s).toBe('C|-50|-50|0&');
    expect(chunkAscii(s, 20)).toHaveLength(1);
  });
});

const mv = (vx: number, vy: number): RobotCommand => ({ kind: 'move', vx, vy, turn: 0 });
const pz = (z: number): RobotCommand => ({ kind: 'pose', yaw: 0, pitch: 0, roll: 0, x: 0, y: 0, z });

describe('BleTransport write outcomes', () => {
  it('reports each written command with ok=true after its last chunk resolves', async () => {
    const { c, resolvers } = manualChar();
    const ev = events();
    const t = new BleTransport(c, ev);
    t.send(mv(0, 50));
    await flush();
    expect(ev.onWritten).not.toHaveBeenCalled();
    resolvers[0]!.ok();
    await flush();
    expect(ev.onWritten).toHaveBeenCalledWith(mv(0, 50), true);
  });

  it('reports a failed write with ok=false', async () => {
    const { c, resolvers } = manualChar();
    const ev = events();
    const t = new BleTransport(c, ev);
    t.send(STOP);
    await flush();
    resolvers[0]!.fail(new Error('gatt'));
    await flush();
    expect(ev.onWritten).toHaveBeenCalledWith(STOP, false);
    expect(ev.onError).toHaveBeenCalledTimes(1);
  });

  it('a command in flight at disconnect is reported unconfirmed before onDisconnect; pending ones are dropped', async () => {
    const { c, writes, resolvers } = manualChar();
    const order: string[] = [];
    const ev = events();
    ev.onWritten.mockImplementation((cmd, ok) => order.push(`${cmd.kind}:${ok}`));
    ev.onDisconnect.mockImplementation(() => order.push('disconnect'));
    const t = new BleTransport(c, ev);
    t.send(mv(0, 50));
    t.send({ kind: 'led', r: 1, g: 2, b: 3 });
    await flush();
    t.handleDisconnected();
    expect(order).toEqual(['move:false', 'disconnect']);
    resolvers[0]!.ok(); // settles late: must not be reported again
    await flush();
    expect(order).toEqual(['move:false', 'disconnect']);
    expect(writes).toEqual(['C|0|50|0&']);
  });
});

describe('BleTransport pending queue coalescing', () => {
  /** Put a LED in flight so later sends stay pending, then release everything in order. */
  async function run(cmds: RobotCommand[]): Promise<string[]> {
    const { c, writes, resolvers } = manualChar();
    const t = new BleTransport(c, events());
    t.send({ kind: 'led', r: 0, g: 0, b: 0 });
    await flush();
    for (const cmd of cmds) t.send(cmd);
    for (let i = 0; i < 20; i++) {
      resolvers[i]?.ok();
      await flush();
    }
    return writes.slice(1);
  }

  it('a newer move replaces a pending move', async () => {
    expect(await run([mv(0, 10), mv(0, 20), mv(0, 30)])).toEqual(['C|0|30|0&']);
  });

  it('a newer pose replaces a pending pose', async () => {
    expect(await run([pz(5), pz(6), pz(7)])).toEqual(['F|0|0|0|0|0|7&']);
  });

  it('only one write is in flight at a time and the pending queue stays bounded', async () => {
    const { c, writes } = manualChar();
    const t = new BleTransport(c, events());
    for (let i = 0; i < 1000; i++) {
      t.send(mv(0, (i % 50) + 1));
      t.send(pz(i % 30));
    }
    await flush();
    expect(writes).toHaveLength(1);
    expect(t.pendingCount).toBeLessThanOrEqual(2);
  });

  it('STOP drops pending moves and poses', async () => {
    expect(await run([mv(0, 10), pz(5), STOP])).toEqual(['C|0|0|0&']);
  });

  it('avoid-off and balance-off drop pending moves and poses but keep a pending STOP', async () => {
    expect(await run([mv(0, 10), pz(5), { kind: 'avoid', on: false }])).toEqual(['I|0&']);
    expect(await run([pz(5), { kind: 'balance', on: false }])).toEqual(['J|0&']);
    expect(await run([STOP, { kind: 'avoid', on: false }])).toEqual(['C|0|0|0&', 'I|0&']);
  });

  it('non-coalescable commands keep their order', async () => {
    const out = await run([
      { kind: 'action', id: 3 },
      { kind: 'avoid', on: true },
      { kind: 'balance', on: true },
      { kind: 'reset' },
      { kind: 'led', r: 1, g: 1, b: 1 },
      { kind: 'led', r: 2, g: 2, b: 2 },
    ]);
    expect(out).toEqual(['K|1|3&', 'I|1&', 'J|1&', 'O&', 'H|1|1|1&', 'H|2|2|2&']);
  });

  it('a coalesced move goes to the back, after commands queued before it', async () => {
    expect(await run([mv(0, 10), { kind: 'reset' }, mv(0, 20)])).toEqual(['O&', 'C|0|20|0&']);
  });
});

describe('BleTransport STOP confirmation timeout', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it(`reports a STOP not confirmed within ${STOP_CONFIRM_MS}ms`, async () => {
    vi.useFakeTimers();
    const { c } = manualChar(); // writes never resolve
    const ev = events();
    const t = new BleTransport(c, ev);
    t.send(mv(0, 50));
    t.send(STOP);
    await vi.advanceTimersByTimeAsync(STOP_CONFIRM_MS - 1);
    expect(ev.onStopTimeout).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(ev.onStopTimeout).toHaveBeenCalledTimes(1);
  });

  it('a STOP confirmed in time is not reported', async () => {
    vi.useFakeTimers();
    const { c, resolvers } = manualChar();
    const ev = events();
    const t = new BleTransport(c, ev);
    t.send(STOP);
    await vi.advanceTimersByTimeAsync(100);
    resolvers[0]!.ok();
    await vi.advanceTimersByTimeAsync(1000);
    expect(ev.onStopTimeout).not.toHaveBeenCalled();
    expect(ev.onWritten).toHaveBeenCalledWith(STOP, true);
  });

  it('the timeout runs from the first unconfirmed STOP even if more STOPs follow', async () => {
    vi.useFakeTimers();
    const { c } = manualChar();
    const ev = events();
    const t = new BleTransport(c, ev);
    t.send(STOP);
    await vi.advanceTimersByTimeAsync(200);
    t.send(STOP);
    await vi.advanceTimersByTimeAsync(100);
    expect(ev.onStopTimeout).toHaveBeenCalledTimes(1);
  });

  it('no timeout report after disconnect', async () => {
    vi.useFakeTimers();
    const { c } = manualChar();
    const ev = events();
    const t = new BleTransport(c, ev);
    t.send(STOP);
    t.handleDisconnected();
    await vi.advanceTimersByTimeAsync(1000);
    expect(ev.onStopTimeout).not.toHaveBeenCalled();
  });
});
