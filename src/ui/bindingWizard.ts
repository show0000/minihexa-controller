/** Binding wizard dialog: walks WIZARD_STEPS with the pad, then asks for the action ids. */
import { parseMapping, serializeMapping, type Mapping, type PadSnapshot } from '../input/mapping';
import { WIZARD_STEPS, WizardSession, actionLabel } from './wizardSteps';

export { WIZARD_STEPS, nextWizardStep } from './wizardSteps';

const ACTION_KEYS = ['action1', 'action2', 'action3', 'action4'] as const;

export interface BindingWizard {
  readonly active: boolean;
  open(current: Mapping): void;
  /** Feed the pad in use each frame while the wizard is open. */
  poll(s: PadSnapshot | null, padName: string | null): void;
}

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const e = document.getElementById(id);
  if (!e) throw new Error(`missing element #${id}`);
  return e as T;
}

function validId(v: string): number | null {
  const n = Number(v);
  return v.trim() !== '' && Number.isInteger(n) && n >= 1 && n <= 50 ? n : null;
}

export function createBindingWizard(onSave: (m: Mapping) => void): BindingWizard {
  const root = el('wizard');
  const progress = el('wz-progress');
  const prompt = el('wz-prompt');
  const message = el('wz-message');
  const padLine = el('wz-pad');
  const skipBtn = el<HTMLButtonElement>('wz-skip');
  const actions = el('wz-actions');
  const saveBtn = el<HTMLButtonElement>('wz-save');
  const rows = el('wz-action-rows');

  let session = new WizardSession();
  let active = false;

  const inputs = ACTION_KEYS.map((key, i) => {
    const row = document.createElement('label');
    row.className = 'wz-action';
    const name = document.createElement('b');
    name.textContent = `동작 ${i + 1}`;
    const input = document.createElement('input');
    input.type = 'number';
    input.min = '1';
    input.max = '50';
    input.step = '1';
    input.dataset.key = key;
    const label = document.createElement('span');
    row.append(name, input, label);
    rows.append(row);
    input.addEventListener('input', refreshActions);
    return { key, input, label };
  });

  function refreshActions(): boolean {
    let ok = true;
    for (const { input, label } of inputs) {
      const id = validId(input.value);
      label.textContent = id === null ? '1~50 사이 정수를 넣으세요' : actionLabel(id);
      if (id === null) ok = false;
    }
    saveBtn.disabled = !ok || !session.done;
    return ok;
  }

  function render(): void {
    if (session.done) {
      progress.textContent = `완료 (${WIZARD_STEPS.length}/${WIZARD_STEPS.length})`;
      prompt.textContent = '입력 지정이 끝났습니다. 동작 번호를 확인하고 저장하세요.';
      skipBtn.disabled = true;
    } else {
      const step = WIZARD_STEPS[session.step]!;
      progress.textContent = `${session.step + 1}/${WIZARD_STEPS.length}${step.skippable ? '' : ' · 필수'}`;
      prompt.textContent = step.prompt;
      skipBtn.disabled = !step.skippable;
    }
    message.textContent =
      session.message || (session.waitingRelease && !session.done ? '입력을 받았습니다. 손을 떼세요.' : '');
    actions.hidden = false;
    refreshActions();
  }

  function close(): void {
    active = false;
    root.hidden = true;
  }

  skipBtn.addEventListener('click', () => {
    session.skip();
    render();
  });
  el('wz-restart').addEventListener('click', () => {
    session = new WizardSession();
    render();
  });
  el('wz-cancel').addEventListener('click', close);
  saveBtn.addEventListener('click', () => {
    if (!session.done || !refreshActions()) return;
    const ids = {} as Mapping['actionIds'];
    for (const { key, input } of inputs) ids[key] = validId(input.value)!;
    // Round-trip through the parser so a saved mapping is always one we can load again.
    const m = parseMapping(serializeMapping({ version: 1, bindings: session.bindings, actionIds: ids }));
    close();
    onSave(m);
  });

  return {
    get active() {
      return active;
    },
    open(current: Mapping): void {
      session = new WizardSession();
      for (const { key, input } of inputs) input.value = String(current.actionIds[key]);
      active = true;
      root.hidden = false;
      render();
    },
    poll(s: PadSnapshot | null, padName: string | null): void {
      if (!active) return;
      padLine.textContent = padName ? `사용 중인 패드: ${padName}` : '게임패드가 없습니다. 패드를 연결하고 아무 버튼이나 누르세요.';
      if (!s) return;
      const key = () => `${session.step}|${session.done}|${session.message}|${session.waitingRelease}`;
      const before = key();
      session.poll(s);
      if (key() !== before) render();
    },
  };
}
