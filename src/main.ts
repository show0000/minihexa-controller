import './ui/styles.css';
import { Controller } from './control/controller';
import { readControls, type Mapping } from './input/mapping';
import type { RobotCommand } from './protocol/commands';
import { createScene } from './sim/scene';
import { SimRobot } from './sim/robotModel';
import { Fanout } from './transport/fanout';
import { createBindingWizard } from './ui/bindingWizard';
import { PadTracker, snapshot } from './ui/gamepad';
import { downloadMapping, emptyMapping, loadMapping, readMappingFile, saveMapping } from './ui/mappingStore';
import { RobotLink } from './ui/robotLink';
import { createStatusPanel } from './ui/statusPanel';

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const e = document.getElementById(id);
  if (!e) throw new Error(`missing element #${id}`);
  return e as T;
}

const sim = new SimRobot();
const fanout = new Fanout({ send: (c) => sim.apply(c, performance.now()), connected: true });
const link = new RobotLink(fanout, () => send(controller.resync(performance.now())));
const pads = new PadTracker();
const panel = createStatusPanel();
const canvas = el<HTMLCanvasElement>('sim');
const scene = createScene(canvas);
new ResizeObserver(() => scene.resize()).observe(canvas);

const storedMapping = loadMapping();
let mapping: Mapping = storedMapping ?? emptyMapping();
const controller = new Controller(mapping.actionIds);
const NEUTRAL = readControls({ axes: [], buttons: [] }, emptyMapping());
let notice: string | null = null;

function send(cmds: RobotCommand[]): void {
  for (const c of cmds) fanout.send(c);
}

function applyMapping(m: Mapping): void {
  controller.setActionIds(m.actionIds);
  mapping = m;
  notice = saveMapping(m) ? null : '브라우저에 매핑을 저장하지 못했습니다. 파일로 내보내 두세요.';
}

const wizard = createBindingWizard(applyMapping);

function openWizard(): void {
  // No pad input reaches the controller while the wizard is open; leave every mode first.
  send(controller.estop(performance.now()));
  wizard.open(mapping);
}

el('estop').addEventListener('click', () => send(controller.estop(performance.now())));
el('bind').addEventListener('click', openWizard);
el('connect').addEventListener('click', () => {
  if (link.state === 'connected') {
    // E-stop through the controller first; disconnect() then waits for a confirmed STOP.
    send(controller.estop(performance.now()));
    void link.disconnect();
  } else if (link.state === 'disconnected') {
    void link.connect();
  }
});
el('notice').addEventListener('click', () => {
  notice = null;
  link.notice = null;
});
el('export').addEventListener('click', () => downloadMapping(mapping));
const fileInput = el<HTMLInputElement>('import-file');
el('import').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0];
  fileInput.value = '';
  if (!file) return;
  try {
    applyMapping(await readMappingFile(file));
    notice = notice ?? '매핑을 불러왔습니다.';
  } catch (e) {
    notice = `매핑 파일을 읽지 못했습니다: ${e instanceof Error ? e.message : String(e)}`;
  }
});

window.addEventListener('gamepaddisconnected', (e) => {
  if (e.gamepad.index !== pads.index) return;
  send(controller.gamepadLost(performance.now()));
  pads.index = null; // the loop must not report this loss a second time
});
// rAF stops in a hidden tab, so these must send directly.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) send(controller.hidden(performance.now()));
});
window.addEventListener('blur', () => send(controller.hidden(performance.now())));

function frame(): void {
  // Schedule first so one exception cannot stop the loop (and with it every STOP).
  requestAnimationFrame(frame);
  try {
    step(performance.now());
  } catch (e) {
    console.error('frame failed', e);
  }
}

function step(now: number): void {
  // Pad gone without an event, or the tracked index changed: treat it as a lost pad.
  const { pad: gp, lost } = pads.poll();
  if (lost) send(controller.gamepadLost(now));
  const snap = gp ? snapshot(gp) : null;

  let input = NEUTRAL;
  if (wizard.active) {
    wizard.poll(snap, gp?.id ?? null);
  } else if (snap && !document.hidden && document.hasFocus()) {
    input = readControls(snap, mapping);
  }
  send(controller.update(now, input));

  scene.render(sim.tick(now));
  panel.update({
    link: link.state,
    padName: gp?.id ?? null,
    telemetry: link.telemetry,
    status: controller.status(),
    now,
    warning: link.warning,
    notice: [notice, link.notice].filter(Boolean).join(' · ') || null,
  });
}

if (!storedMapping) openWizard();
requestAnimationFrame(frame);
