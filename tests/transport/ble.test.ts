import { describe, it, expect, vi } from 'vitest';
import { BleTransport, chunkAscii, type WritableChar } from '../../src/transport/ble';

const dec = new TextDecoder();
const text = (v: BufferSource) =>
  dec.decode(v instanceof ArrayBuffer ? v : new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
const flush = () => new Promise((r) => setTimeout(r, 0));

function events() {
  return { onTelemetry: vi.fn(), onDisconnect: vi.fn(), onError: vi.fn() };
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
    resolvers[0].ok();
    await flush();
    expect(writes).toEqual(['C|0|50|0&', 'C|0|0|0&']);
    resolvers[1].ok();
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
});
