import { describe, it, expect } from 'vitest';
import { Fanout } from '../../src/transport/fanout';
import type { Transport } from '../../src/transport/types';
import type { RobotCommand } from '../../src/protocol/commands';

function fake(throws = false, connected = true) {
  const got: RobotCommand[] = [];
  const t: Transport = {
    send(c) {
      got.push(c);
      if (throws) throw new Error('boom');
    },
    connected,
  };
  return { t, got };
}
const cmd: RobotCommand = { kind: 'reset' };

describe('Fanout', () => {
  it('sends only to sim when robot is null', () => {
    const sim = fake();
    const f = new Fanout(sim.t);
    f.send(cmd);
    expect(sim.got).toEqual([cmd]);
    expect(f.connected).toBe(false);
  });
  it('sends to both after setRobot', () => {
    const sim = fake();
    const robot = fake();
    const f = new Fanout(sim.t);
    f.setRobot(robot.t);
    f.send(cmd);
    expect(sim.got).toEqual([cmd]);
    expect(robot.got).toEqual([cmd]);
    expect(f.connected).toBe(true);
    f.setRobot(null);
    f.send(cmd);
    expect(robot.got).toHaveLength(1);
  });
  it('sim still receives when robot send throws, and error does not propagate', () => {
    const sim = fake();
    const robot = fake(true);
    const f = new Fanout(sim.t);
    f.setRobot(robot.t);
    expect(() => f.send(cmd)).not.toThrow();
    expect(sim.got).toEqual([cmd]);
  });
});
