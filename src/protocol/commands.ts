export type Turn = 0 | 1 | 2;

export type RobotCommand =
  | { kind: 'move'; vx: number; vy: number; turn: Turn }
  | { kind: 'pose'; yaw: number; pitch: number; roll: number; x: number; y: number; z: number }
  | { kind: 'action'; id: number }
  | { kind: 'led'; r: number; g: number; b: number }
  | { kind: 'avoid'; on: boolean }
  | { kind: 'balance'; on: boolean }
  | { kind: 'reset' };

export const STOP: RobotCommand = { kind: 'move', vx: 0, vy: 0, turn: 0 };

export interface Telemetry {
  batteryMv: number;
  distance: number;
}

export const BLE_UUIDS = {
  service: '0000ffe0-0000-1000-8000-00805f9b34fb',
  write: '0000ffe1-0000-1000-8000-00805f9b34fb',
  notify: '0000ffe2-0000-1000-8000-00805f9b34fb',
} as const;
export const BLE_NAME = 'miniHexa';

/** Round to nearest integer, then clamp to [min, max]. */
function q(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) throw new RangeError(`non-finite value: ${v}`);
  return Math.min(max, Math.max(min, Math.round(v))) + 0; // +0 normalizes -0
}

export function encodeCommand(c: RobotCommand): string {
  switch (c.kind) {
    case 'move':
      return `C|${q(c.vx, -50, 50)}|${q(c.vy, -50, 50)}|${c.turn}&`;
    case 'pose':
      return `F|${q(c.yaw, -50, 50)}|${q(c.pitch, -50, 50)}|${q(c.roll, -50, 50)}|${q(c.x, -50, 50)}|${q(c.y, -50, 50)}|${q(c.z, 0, 30)}&`;
    case 'action': {
      if (!Number.isInteger(c.id) || c.id < 1 || c.id > 50) {
        throw new RangeError(`action id out of range 1..50: ${c.id}`);
      }
      return `K|1|${c.id}&`;
    }
    case 'led':
      return `H|${q(c.r, 0, 255)}|${q(c.g, 0, 255)}|${q(c.b, 0, 255)}&`;
    case 'avoid':
      return `I|${c.on ? 1 : 0}&`;
    case 'balance':
      return `J|${c.on ? 1 : 0}&`;
    case 'reset':
      return 'O&';
  }
}

export function commandsEqual(a: RobotCommand, b: RobotCommand): boolean {
  return encodeCommand(a) === encodeCommand(b);
}

export function parseTelemetry(s: string): Telemetry | null {
  const m = /^\$(\d+)\$(\d+)\$$/.exec(s.trim());
  if (!m) return null;
  return { batteryMv: Number(m[1]), distance: Number(m[2]) };
}
