/** Pure logic of the binding wizard (step order, skipping, duplicate check, action labels). */
import { BUILTIN_ACTIONS } from '../control/actions';
import { detectInput } from '../input/binder';
import {
  REQUIRED_FUNCTIONS,
  type Binding,
  type ControlFunction,
  type Mapping,
  type PadSnapshot,
} from '../input/mapping';

export interface WizardStep {
  fn: ControlFunction;
  prompt: string;
  skippable: boolean;
}

const PROMPTS: [ControlFunction, string][] = [
  ['moveY', '앞으로 이동: 왼쪽 스틱을 위(앞)로 미세요'],
  ['moveX', '오른쪽으로 이동: 왼쪽 스틱을 오른쪽으로 미세요'],
  ['estop', '비상 정지: 쓸 버튼을 누르세요'],
  ['turnLeft', '왼쪽 회전: 버튼을 누르세요 (예: LB)'],
  ['turnRight', '오른쪽 회전: 버튼을 누르세요 (예: RB)'],
  ['tiltPitch', '앞쪽 들기: 오른쪽 스틱을 위로 미세요'],
  ['tiltRoll', '오른쪽 기울이기: 오른쪽 스틱을 오른쪽으로 미세요'],
  ['heightUp', '몸 높이기: 버튼이나 트리거를 누르세요 (예: RT)'],
  ['heightDown', '몸 낮추기: 버튼이나 트리거를 누르세요 (예: LT)'],
  ['reset', '자세 초기화: 버튼을 누르세요 (예: 오른쪽 스틱 누르기)'],
  ['avoidToggle', '회피 모드 켜기/끄기: 버튼을 누르세요 (예: 메뉴)'],
  ['balanceToggle', '균형 모드 켜기/끄기: 버튼을 누르세요 (예: 보기)'],
  ['ledNext', 'LED 색 바꾸기: 버튼을 누르세요 (예: 십자키)'],
  ['action1', '동작 1: 버튼을 누르세요 (예: A)'],
  ['action2', '동작 2: 버튼을 누르세요 (예: B)'],
  ['action3', '동작 3: 버튼을 누르세요 (예: X)'],
  ['action4', '동작 4: 버튼을 누르세요 (예: Y)'],
];

export const WIZARD_STEPS: WizardStep[] = PROMPTS.map(([fn, prompt]) => ({
  fn,
  prompt,
  skippable: !REQUIRED_FUNCTIONS.includes(fn),
}));

/** Step after `i`. Skipping a required step keeps the wizard on it. */
export function nextWizardStep(i: number, skipped: boolean): number | 'done' {
  const step = WIZARD_STEPS[i];
  if (!Number.isInteger(i) || !step) throw new RangeError(`wizard step out of range: ${i}`);
  if (skipped && !step.skippable) return i;
  return i + 1 < WIZARD_STEPS.length ? i + 1 : 'done';
}

/** The function already bound to the same physical input, if any. */
export function findDuplicate(bindings: Mapping['bindings'], b: Binding): ControlFunction | null {
  for (const [fn, other] of Object.entries(bindings) as [ControlFunction, Binding][]) {
    if (other.type === b.type && other.index === b.index) return fn;
  }
  return null;
}

const BUILTIN_KO: Record<number, string> = {
  1: '트위스트 (반시계)',
  2: '트위스트 (시계)',
  3: '짧은 기상',
  4: '기상',
  5: '애교',
};

/** Label shown next to an action id: built-in action name (1..5), stored dance (6..50), else ''. */
export function actionLabel(id: number): string {
  if (!Number.isInteger(id) || id < 1 || id > 50) return '';
  const builtin = BUILTIN_ACTIONS.find((a) => a.id === id);
  if (builtin) return BUILTIN_KO[id] ?? builtin.name;
  return '저장된 춤';
}

const FN_LABEL: Partial<Record<ControlFunction, string>> = Object.fromEntries(
  PROMPTS.map(([fn, prompt]) => [fn, prompt.split(':')[0]]),
);

/**
 * Per-frame capture for the wizard. The baseline is the pad's full snapshot at the start of
 * a step (full arrays: a trigger resting at -1 must be in it). After an input is captured the
 * step advances only once the pad is back at the baseline, so a held input never carries over.
 */
export class WizardSession {
  step = 0;
  bindings: Mapping['bindings'] = {};
  message = '';
  done = false;
  private baseline: PadSnapshot | null = null;
  private waitRelease = false;
  private advanceOnRelease = false;

  /** An input was seen; waiting for the pad to return to rest. */
  get waitingRelease(): boolean {
    return this.waitRelease;
  }

  poll(s: PadSnapshot): void {
    if (this.done) return;
    const b = this.baseline;
    if (!b || b.axes.length !== s.axes.length || b.buttons.length !== s.buttons.length) {
      this.baseline = { axes: [...s.axes], buttons: [...s.buttons] };
      return;
    }
    const input = detectInput(b, s);
    if (this.waitRelease) {
      if (input) return;
      this.waitRelease = false;
      if (this.advanceOnRelease) {
        this.advanceOnRelease = false;
        this.advance(false);
      }
      this.baseline = { axes: [...s.axes], buttons: [...s.buttons] };
      return;
    }
    if (!input) return;
    const fn = WIZARD_STEPS[this.step]!.fn;
    const dup = findDuplicate(this.bindings, input);
    this.waitRelease = true;
    if (dup && dup !== fn) {
      this.message = `이미 "${FN_LABEL[dup] ?? dup}"에 지정된 입력입니다. 다른 입력을 쓰세요.`;
      return;
    }
    this.bindings[fn] = input;
    this.message = '';
    this.advanceOnRelease = true;
  }

  skip(): void {
    if (this.done || this.waitRelease) return;
    const step = WIZARD_STEPS[this.step]!;
    if (!step.skippable) {
      this.message = '필수 항목이라 건너뛸 수 없습니다.';
      return;
    }
    delete this.bindings[step.fn];
    this.message = '';
    this.advance(true);
  }

  private advance(skipped: boolean): void {
    const n = nextWizardStep(this.step, skipped);
    if (n === 'done') this.done = true;
    else this.step = n;
  }
}
