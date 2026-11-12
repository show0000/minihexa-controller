import { describe, expect, it } from 'vitest';
import { AXIS_FUNCTIONS, BUTTON_FUNCTIONS, REQUIRED_FUNCTIONS, type Binding } from '../../src/input/mapping';
import { WIZARD_STEPS, WizardSession, actionLabel, findDuplicate, nextWizardStep } from '../../src/ui/wizardSteps';

describe('WIZARD_STEPS', () => {
  it('contains every control function exactly once', () => {
    const fns = WIZARD_STEPS.map((s) => s.fn);
    expect(new Set(fns).size).toBe(fns.length);
    expect([...fns].sort()).toEqual([...AXIS_FUNCTIONS, ...BUTTON_FUNCTIONS].sort());
  });
  it('marks exactly the required functions as not skippable', () => {
    for (const s of WIZARD_STEPS) {
      expect(s.skippable).toBe(!REQUIRED_FUNCTIONS.includes(s.fn));
      expect(s.prompt.length).toBeGreaterThan(0);
    }
  });
});

describe('nextWizardStep', () => {
  it('advances after a captured input', () => {
    expect(nextWizardStep(0, false)).toBe(1);
  });
  it('stays on a required step when skipping', () => {
    const i = WIZARD_STEPS.findIndex((s) => !s.skippable);
    expect(nextWizardStep(i, true)).toBe(i);
  });
  it('advances when skipping an optional step', () => {
    const i = WIZARD_STEPS.findIndex((s) => s.skippable && s !== WIZARD_STEPS[WIZARD_STEPS.length - 1]);
    expect(nextWizardStep(i, true)).toBe(i + 1);
  });
  it("returns 'done' after the last step", () => {
    const last = WIZARD_STEPS.length - 1;
    expect(nextWizardStep(last, false)).toBe('done');
    if (WIZARD_STEPS[last]!.skippable) expect(nextWizardStep(last, true)).toBe('done');
  });
  it('rejects out-of-range steps', () => {
    expect(() => nextWizardStep(-1, false)).toThrow(RangeError);
    expect(() => nextWizardStep(WIZARD_STEPS.length, false)).toThrow(RangeError);
  });
});

describe('findDuplicate', () => {
  const axis0: Binding = { type: 'axis', index: 0, invert: false, rest: 0 };
  it('finds a function already using the same input', () => {
    expect(findDuplicate({ moveX: axis0 }, { type: 'axis', index: 0, invert: true, rest: 0 })).toBe('moveX');
  });
  it('treats axis and button with the same index as different inputs', () => {
    expect(findDuplicate({ moveX: axis0 }, { type: 'button', index: 0 })).toBeNull();
  });
});

describe('actionLabel', () => {
  it('names built-in actions 1..5 and stored dances 6..50', () => {
    for (let id = 1; id <= 5; id++) expect(actionLabel(id)).not.toBe('저장된 춤');
    expect(actionLabel(6)).toBe('저장된 춤');
    expect(actionLabel(50)).toBe('저장된 춤');
    expect(actionLabel(0)).toBe('');
    expect(actionLabel(51)).toBe('');
  });
});

describe('WizardSession', () => {
  const rest = () => ({ axes: [0, 0, 0, 0, 0, -1], buttons: [0, 0, 0, 0] });
  const withAxis = (i: number, v: number) => {
    const s = rest();
    s.axes[i] = v;
    return s;
  };
  const withButton = (i: number) => {
    const s = rest();
    s.buttons[i] = 1;
    return s;
  };

  it('binds the first step and advances only after release', () => {
    const w = new WizardSession();
    w.poll(rest()); // baseline
    w.poll(withAxis(1, -1));
    expect(w.bindings.moveY).toEqual({ type: 'axis', index: 1, invert: true, rest: 0 });
    expect(w.step).toBe(0);
    w.poll(withAxis(1, -1));
    expect(w.step).toBe(0);
    w.poll(rest());
    expect(w.step).toBe(1);
  });

  it('uses the full baseline so a trigger resting at -1 is not misread', () => {
    const w = new WizardSession();
    w.poll(rest());
    w.poll(rest());
    expect(w.bindings.moveY).toBeUndefined();
  });

  it('rejects an input already bound to another function', () => {
    const w = new WizardSession();
    w.poll(rest());
    w.poll(withAxis(1, -1));
    w.poll(rest()); // step 1: moveX
    w.poll(withAxis(1, -1));
    expect(w.bindings.moveX).toBeUndefined();
    expect(w.message).toContain('이미');
    w.poll(rest());
    expect(w.step).toBe(1);
    w.poll(withAxis(0, 1));
    w.poll(rest());
    expect(w.bindings.moveX).toEqual({ type: 'axis', index: 0, invert: false, rest: 0 });
    expect(w.step).toBe(2);
  });

  it('refuses to skip a required step and skips optional ones', () => {
    const w = new WizardSession();
    w.skip();
    expect(w.step).toBe(0);
    expect(w.message.length).toBeGreaterThan(0);
    const opt = WIZARD_STEPS.findIndex((s) => s.skippable);
    w.step = opt;
    w.skip();
    expect(w.step).toBe(opt + 1);
  });

  it('finishes after the last step', () => {
    const w = new WizardSession();
    w.step = WIZARD_STEPS.length - 1;
    w.poll(rest());
    w.poll(withButton(3));
    w.poll(rest());
    expect(w.done).toBe(true);
    expect(w.bindings[WIZARD_STEPS[WIZARD_STEPS.length - 1]!.fn]).toEqual({ type: 'button', index: 3 });
  });

  it('re-captures the baseline when the pad layout changes', () => {
    const w = new WizardSession();
    w.poll({ axes: [0, 0], buttons: [0] });
    w.poll(rest()); // different lengths: becomes the new baseline, not an input
    expect(w.bindings.moveY).toBeUndefined();
    w.poll(withAxis(1, -1));
    expect(w.bindings.moveY).toBeDefined();
  });
});
