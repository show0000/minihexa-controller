/** Side panel: connection, battery, distance, mode, action lock, warning and notices. */
import type { ControllerMode, ControllerStatus } from '../control/controller';
import type { Telemetry } from '../protocol/commands';
import type { LinkState } from './robotLink';

export interface PanelState {
  link: LinkState;
  padName: string | null;
  telemetry: Telemetry | null;
  status: ControllerStatus;
  now: number;
  warning: string | null;
  notice: string | null;
}

const LINK_TEXT: Record<LinkState, string> = {
  disconnected: '연결 안 됨 (시뮬레이터만)',
  connecting: '연결 중…',
  connected: '연결됨',
  disconnecting: '정지 확인 후 연결 끊는 중…',
};

const MODE_TEXT: Record<ControllerMode, string> = {
  manual: '일반 조종',
  avoid: '회피 중 (스틱이나 버튼을 쓰면 꺼집니다)',
  balance: '균형 중 (스틱이나 버튼을 쓰면 꺼집니다)',
  action: '동작 중',
};

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const e = document.getElementById(id);
  if (!e) throw new Error(`missing element #${id}`);
  return e as T;
}

function setText(e: HTMLElement, text: string): void {
  if (e.textContent !== text) e.textContent = text;
}

function setBanner(e: HTMLElement, text: string | null): void {
  e.hidden = text === null;
  setText(e, text ?? '');
}

export function lockText(s: ControllerStatus, now: number): string | null {
  if (s.mode !== 'action' || s.actionEndsAt === null) return null;
  const secs = Math.max(0, Math.ceil((s.actionEndsAt - now) / 1000));
  const base = `동작 중 (${secs}초) · 조종 입력 잠김`;
  return s.estopPending ? `${base} · 동작이 끝나면 바로 정지합니다` : base;
}

export function createStatusPanel(): { update(s: PanelState): void } {
  const conn = el('st-conn');
  const pad = el('st-pad');
  const battery = el('st-battery');
  const distance = el('st-distance');
  const mode = el('st-mode');
  const height = el('st-height');
  const lock = el('st-lock');
  const latch = el('st-latch');
  const warning = el('warning');
  const notice = el('notice');
  const connectBtn = el<HTMLButtonElement>('connect');

  return {
    update(s: PanelState): void {
      setText(conn, LINK_TEXT[s.link]);
      setText(pad, s.padName ?? '없음 (패드를 연결하고 버튼을 한 번 누르세요)');
      setText(battery, s.telemetry ? `${(s.telemetry.batteryMv / 1000).toFixed(2)} V` : '-');
      setText(distance, s.telemetry ? `${s.telemetry.distance} mm` : '-');
      setText(mode, MODE_TEXT[s.status.mode]);
      setText(height, `${Math.round(s.status.z)} / 30`);
      setBanner(lock, lockText(s.status, s.now));
      latch.hidden = !s.status.stickLatched;
      setBanner(warning, s.warning);
      setBanner(notice, s.notice);
      setText(connectBtn, s.link === 'connected' ? '연결 끊기' : '로봇 연결');
      connectBtn.disabled = s.link === 'connecting' || s.link === 'disconnecting';
    },
  };
}
