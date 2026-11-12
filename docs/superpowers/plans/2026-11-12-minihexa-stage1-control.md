# miniHexa 1단계(조종) 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Chrome 웹앱 하나로 Xbox 호환 게임패드를 써서 miniHexa를 BLE로 조종하고, 같은 명령으로 3D 시뮬레이터를 움직인다. 정지 보장을 포함하고 GitHub Pages에 배포한다.

**Architecture:** 순수 TypeScript 모듈(프로토콜 인코더, 입력 매핑, 컨트롤러 상태 기계, 기구학과 걸음새)과 브라우저 의존 계층(Web Bluetooth 전송, Three.js 렌더링, DOM UI)을 분리한다. 컨트롤러가 `RobotCommand`를 만들면 Fanout 전송이 시뮬레이터에는 항상, BLE에는 연결되어 있을 때 보낸다. 프레임워크 없는 DOM으로 구성하고, Vite로 정적 빌드한다.

**Tech Stack:** TypeScript 5.x, Vite 8.3.x, Vitest 5.1.x, three 0.187.x (+ @types/three), @types/web-bluetooth. Node 22 (개발 Mac에만 필요).

**Spec:** `docs/superpowers/specs/2026-11-12-minihexa-mac-controller-design.md` (프로토콜 원본: `vendor/app_firmware/remote/`)

## Global Constraints

- **Chrome 150에 있는 웹 API만 사용한다** (Intel 맥 macOS 12.7.4의 Chrome이 150에서 멈춤). Vite `build.target: 'chrome120'`.
- 보안 컨텍스트에서 동작해야 한다: GitHub Pages(https)와 `http://localhost`.
- BLE: 기기 이름 `miniHexa`, 서비스 `0000ffe0-0000-1000-8000-00805f9b34fb`, 쓰기 `0000ffe1-0000-1000-8000-00805f9b34fb`(WRITE, with response), 알림 `0000ffe2-0000-1000-8000-00805f9b34fb`.
- 명령 형식: ASCII, `|` 구분, `&` 종료, 부호 있는 10진 정수.
- 이동 값 vx, vy: -50~50. 회전: 0/1(왼쪽)/2(오른쪽). 자세 yaw/pitch/roll/x/y: -50~50, z: 0~30. LED: 0~255. 동작 id: 1~50 정수.
- `vendor/`는 git에 올리지 않는다 (공개 저장소).
- 정지 보장(spec §4.8)이 최우선이다. 안전 경로의 모든 동작은 단위 테스트로 고정한다.
- UI 문구는 한국어로 쓴다.

## Review Focus

1. **게임패드가 끊겼다가 다시 연결될 때**: 끊기는 즉시 정지하고, 재연결 뒤 스틱이 중립이면 아무 이동 명령도 보내지 않아야 한다 → Task 3 `gamepad lost then neutral resumes silently`.
2. **트리거가 축(-1에서 쉼)으로 잡히는 호환 패드**: 손을 떼고 있는데 높이가 저절로 변하면 안 된다 → Task 2 `trigger axis resting at -1 reads 0`.
3. **이동과 자세 입력이 동시에 계속 바뀔 때**: 자세 명령 때문에 이동 명령이 밀려나지 않아야 하고, 정지는 즉시 나가야 한다 → Task 3 `move not starved by pose`.
4. **BLE 쓰기 실패나 전송 중 연결 끊김**: 처리되지 않은 Promise 거부 없이 경고를 표시하고, 시뮬레이터는 계속 동작해야 한다 → Task 4 `write failure reports and does not throw`.
5. **동작 버튼 연타**: 동작 명령은 한 번만 나가고 잠금 시간이 늘어나지 않아야 한다 → Task 3 `repeated action press during lock is ignored`.

---

## File Structure

```
.gitignore                      vendor/, node_modules/, dist/
package.json, tsconfig.json, vite.config.ts, index.html
.github/workflows/pages.yml     GitHub Pages 배포
src/protocol/commands.ts        RobotCommand 타입, 인코더, 텔레메트리 파서, BLE 상수
src/input/mapping.ts            Binding/Mapping 타입, 입력 읽기, 직렬화
src/input/binder.ts             지정 화면용 입력 감지 (순수)
src/control/actions.ts          내장 동작 1~5 스크립트와 소요 시간
src/control/controller.ts       ControlInput → RobotCommand[] 상태 기계 (안전 로직)
src/transport/types.ts          Transport 인터페이스
src/transport/ble.ts            Web Bluetooth 전송, chunkAscii
src/transport/fanout.ts         시뮬레이터 + BLE 동시 전송
src/sim/kinematics.ts           다리 IK/FK, 몸체 자세 변환
src/sim/gait.ts                 삼각 보행 상태 갱신
src/sim/robotModel.ts           SimRobot: 명령 소비 → 관절과 몸체 상태
src/sim/scene.ts                Three.js 렌더링 (테스트 없음, 수동 확인)
src/ui/bindingWizard.ts         버튼 지정 화면
src/ui/statusPanel.ts           연결, 배터리, 거리, 모드, 잠금 카운트다운, 경고
src/main.ts                     조립과 메인 루프
tests/**                        각 순수 모듈의 Vitest 테스트
```

---

### Task 1: 프로젝트 골격 + 프로토콜 인코더

**Files:**
- Create: `.gitignore`, `package.json`, `tsconfig.json`, `vite.config.ts`, `index.html`, `src/main.ts`(빈 진입점), `src/protocol/commands.ts`
- Test: `tests/protocol/commands.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type Turn = 0 | 1 | 2;
  export type RobotCommand =
    | { kind: 'move'; vx: number; vy: number; turn: Turn }
    | { kind: 'pose'; yaw: number; pitch: number; roll: number; x: number; y: number; z: number }
    | { kind: 'action'; id: number }
    | { kind: 'led'; r: number; g: number; b: number }
    | { kind: 'avoid'; on: boolean }
    | { kind: 'balance'; on: boolean }
    | { kind: 'reset' };
  export const STOP: RobotCommand; // { kind:'move', vx:0, vy:0, turn:0 }
  export function encodeCommand(c: RobotCommand): string;
  export function commandsEqual(a: RobotCommand, b: RobotCommand): boolean;
  export interface Telemetry { batteryMv: number; distance: number }
  export function parseTelemetry(s: string): Telemetry | null;
  export const BLE_UUIDS: { service: string; write: string; notify: string }; export const BLE_NAME = 'miniHexa';
  ```

- [ ] **Step 1: 골격 만들기**: `git init`, `.gitignore`(`vendor/`, `node_modules/`, `dist/`), `npm init`, devDependencies 설치(typescript, vite@8.3.8, vitest@5.1.0, three@0.187.0, @types/three, @types/web-bluetooth). `vite.config.ts`에 `base: './'`, `build.target: 'chrome120'`. 스크립트는 `dev`, `build`, `test`(`vitest run`), `typecheck`(`tsc --noEmit`). `npm run build`가 성공하는지 확인한다.

- [ ] **Step 2: 실패하는 테스트 작성** (`tests/protocol/commands.test.ts`)

  ```ts
  expect(encodeCommand({kind:'move', vx:10, vy:-20, turn:1})).toBe('C|10|-20|1&');
  expect(encodeCommand({kind:'move', vx:99, vy:-99, turn:0})).toBe('C|50|-50|0&');      // clamp
  expect(encodeCommand({kind:'move', vx:10.6, vy:0, turn:0})).toBe('C|11|0|0&');        // round
  expect(encodeCommand({kind:'pose', yaw:0, pitch:5, roll:-5, x:0, y:0, z:40})).toBe('F|0|5|-5|0|0|30&');
  expect(encodeCommand({kind:'pose', yaw:0, pitch:0, roll:0, x:0, y:0, z:-3})).toBe('F|0|0|0|0|0|0&');
  expect(encodeCommand({kind:'action', id:4})).toBe('K|1|4&');
  expect(() => encodeCommand({kind:'action', id:0})).toThrow(RangeError);
  expect(() => encodeCommand({kind:'action', id:51})).toThrow(RangeError);
  expect(encodeCommand({kind:'led', r:300, g:-1, b:178})).toBe('H|255|0|178&');
  expect(encodeCommand({kind:'avoid', on:true})).toBe('I|1&');
  expect(encodeCommand({kind:'balance', on:false})).toBe('J|0&');
  expect(encodeCommand({kind:'reset'})).toBe('O&');
  expect(parseTelemetry('$7400$215$')).toEqual({batteryMv:7400, distance:215});
  expect(parseTelemetry('$7400$')).toBeNull();
  expect(parseTelemetry('garbage')).toBeNull();
  expect(commandsEqual(STOP, {kind:'move', vx:0, vy:0, turn:0})).toBe(true);
  expect(commandsEqual(STOP, {kind:'reset'})).toBe(false);
  ```

- [ ] **Step 3: 실패 확인**: `npx vitest run tests/protocol` → FAIL (모듈 없음)

- [ ] **Step 4: `src/protocol/commands.ts` 구현.** 반올림한 뒤 clamp한다. `commandsEqual`은 인코딩 결과 문자열을 비교한다.

- [ ] **Step 5: 통과 확인**: `npx vitest run tests/protocol` → PASS, `npm run typecheck` → 오류 0

- [ ] **Step 6: 커밋**: `git add -A && git commit -m "feat: scaffold project and miniHexa command encoder"`

---

### Task 2: 게임패드 매핑과 입력 감지

**Files:**
- Create: `src/input/mapping.ts`, `src/input/binder.ts`
- Test: `tests/input/mapping.test.ts`, `tests/input/binder.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface PadSnapshot { axes: number[]; buttons: number[] } // buttons: value 0..1
  export type AxisBinding = { type: 'axis'; index: number; invert: boolean; rest: 0 | -1 };
  export type ButtonBinding = { type: 'button'; index: number };
  export type Binding = AxisBinding | ButtonBinding;
  export type AxisFunction = 'moveX' | 'moveY' | 'tiltPitch' | 'tiltRoll';
  export type ButtonFunction = 'turnLeft' | 'turnRight' | 'heightUp' | 'heightDown' | 'estop' | 'reset'
    | 'avoidToggle' | 'balanceToggle' | 'ledNext' | 'action1' | 'action2' | 'action3' | 'action4';
  export type ControlFunction = AxisFunction | ButtonFunction;
  export interface Mapping { version: 1; bindings: Partial<Record<ControlFunction, Binding>>; actionIds: Record<'action1'|'action2'|'action3'|'action4', number> }
  export const DEFAULT_ACTION_IDS = { action1: 1, action2: 2, action3: 4, action4: 5 };
  export const DEADZONE = 0.15;
  export interface ControlInput { axes: Record<AxisFunction, number>; buttons: Record<ButtonFunction, number> }
  export function readControls(s: PadSnapshot, m: Mapping): ControlInput;
  export function serializeMapping(m: Mapping): string;
  export function parseMapping(json: string): Mapping; // 잘못된 입력이면 Error
  export const REQUIRED_FUNCTIONS: ControlFunction[]; // ['moveX','moveY','estop']
  // binder.ts
  export function detectInput(baseline: PadSnapshot, current: PadSnapshot): Binding | null;
  ```

- [ ] **Step 1: 실패하는 테스트 작성**
  - `readControls`: 축 값 0.1 → 0 (데드존). 0.15 이상이면 `(|v|-0.15)/(1-0.15)`에 부호를 붙여 [-1, 1]로 정규화. `invert: true`면 부호 반전. 바인딩이 없는 기능은 0.
  - `trigger axis resting at -1 reads 0`: `{type:'axis', index:5, invert:false, rest:-1}`를 버튼 기능(`heightUp`)에 연결했을 때, 축 -1 → 0, 축 1 → 1, 축 0 → 0.5.
  - 버튼 기능에 축 바인딩(rest 0)을 연결하면 `max(0, 부호 적용 값)`.
  - 축 기능에 버튼 바인딩을 연결하면 버튼 값 그대로(0~1).
  - `parseMapping(serializeMapping(m))`이 `m`과 같다. `parseMapping('{}')`, `version: 2`, index가 음수인 경우는 throw.
  - `detectInput`: 버튼 3이 0 → 1이면 `{type:'button', index:3}`. 축 1이 0 → -0.9이면 `{type:'axis', index:1, invert:true, rest:0}` (밀어 넣은 방향이 +가 되도록). 축 5가 -1 → 0.9이면 `{type:'axis', index:5, invert:false, rest:-1}`. 변화량이 0.6 미만이면 null. 버튼과 축이 동시에 바뀌면 버튼을 우선한다.

- [ ] **Step 2: 실패 확인**: `npx vitest run tests/input` → FAIL
- [ ] **Step 3: `mapping.ts`, `binder.ts` 구현.** baseline이 -0.5 미만이면 `rest = -1`, 아니면 0. rest -1 축은 `(v+1)/2`로 0~1을 만든 뒤 invert를 적용한다.
- [ ] **Step 4: 통과 확인**: `npx vitest run tests/input` → PASS
- [ ] **Step 5: 커밋**: `git commit -am "feat: gamepad mapping, reading and input detection"`

---

### Task 3: 내장 동작 스크립트 + 컨트롤러 상태 기계 (안전 핵심)

**Files:**
- Create: `src/control/actions.ts`, `src/control/controller.ts`
- Test: `tests/control/actions.test.ts`, `tests/control/controller.test.ts`

**Interfaces:**
- Consumes: Task 1 `RobotCommand`, `STOP`, `commandsEqual`. Task 2 `ControlInput`, `Mapping['actionIds']`.
- Produces:
  ```ts
  // actions.ts — 펌웨어 hiwonder_robot.cpp 747~862줄을 그대로 옮긴 스크립트
  export interface ActionStep { att: { pitch: number; roll: number; yaw: number }; pos: { x: number; y: number } | 'keep'; vel?: { vx: number; vy: number; omega: number; steps: number }; moveMs: number; holdMs: number }
  export interface BuiltinAction { id: 1|2|3|4|5; name: string; steps: ActionStep[] }
  export const BUILTIN_ACTIONS: BuiltinAction[];
  export function actionDurationMs(id: number): number; // 스크립트의 holdMs 합. 저장된 동작(6~50)은 STORED_ACTION_LOCK_MS = 10000
  // controller.ts
  export type ControllerMode = 'manual' | 'avoid' | 'balance' | 'action';
  export interface ControllerStatus { mode: ControllerMode; actionEndsAt: number | null; estopPending: boolean; z: number }
  export const SEND_INTERVAL_MS = 50; export const ACTION_MARGIN_MS = 500; export const HEIGHT_RATE_PER_S = 15; export const DEFAULT_Z = 10;
  export const LED_PALETTE: [number, number, number][]; // 첫 항목은 [0,237,178] (펌웨어 기본색)
  export class Controller {
    constructor(actionIds: Record<'action1'|'action2'|'action3'|'action4', number>);
    update(now: number, input: ControlInput): RobotCommand[];
    gamepadLost(now: number): RobotCommand[];
    hidden(now: number): RobotCommand[];
    estop(now: number): RobotCommand[];
    status(): ControllerStatus;
  }
  ```

- [ ] **Step 1: actions 테스트 작성**: `actionDurationMs(1) === 4600`, `(2) === 4600`(twist: 3바퀴×12스텝×100 + 500 + 500), `(3) === 2200`, `(4) === 8700`, `(5) === 2500`, `(7) === 10000`.

- [ ] **Step 2: controller 테스트 작성.** 아래 규칙마다 테스트를 하나씩 둔다. `t`는 ms 단위 시각이고, 입력 헬퍼 `inp({moveY:1})`처럼 쓴다.
  - **변화가 있을 때만 전송**: 같은 입력으로 `update`를 반복하면 첫 호출에서만 `{move, vy:50}`이 나온다.
  - **속도 제한**: 이동 값이 바뀌어도 직전 전송 후 50ms가 지나지 않았으면 보내지 않는다. 50ms가 지나면 가장 최근 값을 보낸다.
  - **정지는 즉시**: 이동 중에 스틱이 중립으로 오면 속도 제한과 상관없이 같은 `update`에서 `STOP`을 반환한다.
  - **한 번에 한 명령**: 한 `update`가 반환하는 명령은 최대 1개. 우선순위는 STOP > 모드·동작·리셋 > move > pose.
  - **`move not starved by pose`**: 매 50ms마다 이동과 기울이기가 함께 바뀌어도, 연속된 두 전송 슬롯 안에 move가 최소 한 번 나간다 (move와 pose가 번갈아 나감).
  - **회전**: turnLeft만 누르면 turn 1, turnRight만 누르면 2, 둘 다 누르거나 둘 다 떼면 0.
  - **자세**: tiltPitch 1 → pitch 50, tiltRoll -1 → roll -50. heightUp 1을 1초 누르면 z가 10 → 25, 이후 30에서 멈춘다. yaw, x, y는 0.
  - **동작**: action1을 누르는 순간 `{action, id:1}`을 내보내고 모드가 `action`, `actionEndsAt = t + 4600 + 500`. 잠금 동안에는 입력이 있어도 `[]`.
  - **`repeated action press during lock is ignored`**: 잠금 중에 action1을 다시 눌러도 명령이 나가지 않고 `actionEndsAt`도 그대로다.
  - **잠금 중 비상 정지**: `estop()`은 `[]`를 반환하고 `estopPending: true`. 잠금이 끝난 뒤 첫 `update`가 `STOP`을 내보내고 모드는 `manual`.
  - **회피와 균형**: avoidToggle을 누르면 `{avoid, on:true}`, 모드 `avoid`. 이 모드에서 스틱을 데드존 밖으로 움직이거나, 다른 버튼을 누르거나, avoidToggle을 다시 누르면 `{avoid, on:false}`를 내보내고 `manual`로 돌아간다. 이때 스틱 값은 다음 슬롯에서 move로 나간다. balance도 같다.
  - **리셋**: reset을 누르면 `{reset}`, z = 10, pitch와 roll 기준값도 초기화된다.
  - **LED**: ledNext를 누를 때마다 팔레트 다음 색. 마지막 다음은 첫 색.
  - **`gamepad lost then neutral resumes silently`**: 이동 중에 `gamepadLost(t)`를 호출하면 `[STOP]`. 그다음 중립 입력의 `update`는 `[]`.
  - `gamepadLost`와 `hidden`: manual 모드에서는 항상 `[STOP]`, avoid 모드면 `[{avoid, on:false}]`, balance 모드면 `[{balance, on:false}]`, action 모드면 `[]`이고 `estopPending: true`.
  - 버튼은 0.5 이상이면 눌린 것으로 보고, 누르는 순간(엣지)에만 반응한다.

- [ ] **Step 3: 실패 확인**: `npx vitest run tests/control` → FAIL
- [ ] **Step 4: `actions.ts` 구현** (펌웨어 스크립트를 데이터로 옮긴다. twist는 반지름 8, 3바퀴, 바퀴당 12스텝의 roll/pitch 원 궤적을 생성한다. `next_circular_point`는 720~746줄 참고), **`controller.ts` 구현.**
- [ ] **Step 5: 통과 확인**: `npx vitest run tests/control` → PASS
- [ ] **Step 6: 커밋**: `git commit -am "feat: controller state machine with stop guarantees"`

---

### Task 4: Web Bluetooth 전송 + Fanout

**Files:**
- Create: `src/transport/types.ts`, `src/transport/ble.ts`, `src/transport/fanout.ts`
- Test: `tests/transport/ble.test.ts`, `tests/transport/fanout.test.ts`

**Interfaces:**
- Consumes: Task 1 `RobotCommand`, `encodeCommand`, `parseTelemetry`, `BLE_UUIDS`, `BLE_NAME`.
- Produces:
  ```ts
  export interface Transport { send(cmd: RobotCommand): void; readonly connected: boolean }
  export interface BleEvents { onTelemetry(t: Telemetry): void; onDisconnect(): void; onError(e: unknown): void }
  export function chunkAscii(s: string, size: number): string[];
  export interface WritableChar { writeValueWithResponse(v: BufferSource): Promise<void> } // 테스트용 최소 인터페이스
  export class BleTransport implements Transport {
    static connect(events: BleEvents): Promise<BleTransport>; // navigator.bluetooth.requestDevice({filters:[{name:BLE_NAME}], optionalServices:[BLE_UUIDS.service]})
    constructor(writeChar: WritableChar, events: BleEvents); // 테스트에서 가짜 특성 주입
    send(cmd: RobotCommand): void; // 쓰기를 직렬화(이전 쓰기 Promise 뒤에 연결), 20바이트 청크
    disconnect(): void;
    readonly connected: boolean;
  }
  export class Fanout implements Transport { constructor(sim: Transport); setRobot(t: Transport | null): void; send(cmd): void; readonly connected: boolean /* robot 연결 여부 */ }
  ```

- [ ] **Step 1: 실패하는 테스트 작성**
  - `chunkAscii('F|0|5|-5|0|0|30&', 20)` → 원소 1개. 45자 문자열 → 20, 20, 5.
  - 가짜 특성(쓰기를 기록하고, 수동으로 resolve하는 Promise를 반환)에서 `send`를 두 번 연속 호출하면, 첫 쓰기가 resolve되기 전에는 두 번째 쓰기가 시작되지 않는다. 기록된 바이트를 이어 붙이면 `'C|0|50|0&C|0|0|0&'`.
  - **`write failure reports and does not throw`**: 특성이 reject하면 `onError`가 1번 호출되고, 다음 `send`는 정상적으로 쓰인다. 처리되지 않은 거부가 없어야 한다 (vitest의 unhandledRejection 감지).
  - Fanout: 로봇이 null이면 sim만 받는다. `setRobot(fake)` 뒤에는 둘 다 받는다. 로봇 `send`가 throw해도 sim은 받는다.
- [ ] **Step 2: 실패 확인**: `npx vitest run tests/transport` → FAIL
- [ ] **Step 3: 구현.** `connect`에서 notify 특성의 `characteristicvaluechanged` → TextDecoder → `parseTelemetry`(null이면 무시). `gattserverdisconnected`이면 `connected=false`로 두고 `onDisconnect`를 호출한다.
- [ ] **Step 4: 통과 확인**: `npx vitest run tests/transport` → PASS
- [ ] **Step 5: 커밋**: `git commit -am "feat: web bluetooth transport and fanout"`

---

### Task 5: 시뮬레이터 모델 (기구학, 걸음새, SimRobot)

**Files:**
- Create: `src/sim/kinematics.ts`, `src/sim/gait.ts`, `src/sim/robotModel.ts`
- Test: `tests/sim/kinematics.test.ts`, `tests/sim/gait.test.ts`, `tests/sim/robotModel.test.ts`

**Interfaces:**
- Consumes: Task 1 `RobotCommand`. Task 3 `BUILTIN_ACTIONS`, `actionDurationMs`.
- Produces:
  ```ts
  // kinematics.ts (단위 cm, 각도 rad)
  export interface Vec3 { x: number; y: number; z: number }
  export interface JointAngles { a: number; b: number; c: number } // a: 몸통쪽 수평 회전, b: 둘째 마디 들기, c: 셋째 마디 굽힘
  export const LINK = { l1: 2.85, l2: 3.70, l3: 7.2 };
  export const LEG_ORIGINS: Vec3[]; // spec §3.3 순서대로 L1..L6, z=0
  export const LEG_MOUNT_ANGLE: number[]; // atan2(origin.y, origin.x)
  export function ikLeg(foot: Vec3): JointAngles | null; // 다리 좌표계(x: 바깥, z: 위). 닿지 않으면 null
  export function fkLeg(j: JointAngles): Vec3;
  export function bodyToLeg(i: number, footBody: Vec3): Vec3;
  export function applyBodyPose(feetWorld: Vec3[], pose: BodyPose): Vec3[]; // 발은 바닥에 고정, 몸체만 이동·회전 → 몸체 좌표계 발 위치
  export interface BodyPose { x: number; y: number; z: number; pitch: number; roll: number; yaw: number } // cm, deg
  export const STANCE: Vec3[]; // 몸체 좌표계 기본 발 위치 (빌더가 정함. 모든 다리가 ikLeg로 닿아야 함)
  // gait.ts
  export interface GaitState { t: number; feet: Vec3[]; odom: { x: number; y: number; heading: number } }
  export const GAIT = { minPeriodMs: 400 /* 펌웨어 move_time ≥ 400 */, lift: 3, maxHalfStep: 3, cmPerSecAtMax: 15 };
  export function initGait(): GaitState;
  export function stepGait(s: GaitState, dtMs: number, vel: { vx: number; vy: number; omega: number }): GaitState; // vx, vy는 -3~3 (펌웨어 단위)
  // robotModel.ts
  export interface SimFrame { joints: JointAngles[]; body: BodyPose; odom: GaitState['odom']; led: [number, number, number]; busyUntil: number | null }
  export class SimRobot { apply(cmd: RobotCommand, now: number): void; tick(now: number): SimFrame }
  export function commandToVelocity(cmd: Extract<RobotCommand, { kind: 'move' }>): { vx: number; vy: number; omega: number };
  ```

- [ ] **Step 1: 실패하는 테스트 작성**
  - `ikLeg(fkLeg(j))`가 `j`와 1e-6 이내로 같다. 대표 관절 조합 5개 이상과 STANCE 6개 발 위치 모두.
  - 원점에서 `l1+l2+l3+0.1` 떨어진 점은 `ikLeg`가 null.
  - `commandToVelocity`: `C 50 0 0` → vx 3. `C 0 0 1` → omega 2.5. `C 0 25 2` → vy 1.5, omega -0.2 (펌웨어 remote.ino 규칙).
  - `stepGait`에서 vel이 0이면 1초 동안 발이 STANCE에서 움직이지 않는다 (1e-9).
  - vy가 3이면 매 시점 바닥에서 떨어진 발(z가 STANCE보다 0.01 이상 높은 발)은 같은 삼각 그룹({0,2,4} 또는 {1,3,5}) 안에서만 나온다. 주기의 1/4 시점에는 한 그룹이 들려 있고 최대 높이는 3 근처(±0.1)다.
  - vy가 3이면 2초 뒤 odom.y > 0이고, vy가 -3이면 odom.y < 0이다.
  - SimRobot: move 명령 뒤 tick을 진행하면 odom이 변한다. `STOP` 뒤에는 한 주기 이내에 odom이 고정된다. `reset` 뒤 body.z가 기본값으로 돌아간다. `action 4`를 적용하면 `busyUntil = now + 8700`. 그 사이에 들어온 명령은 마지막 것만 busy가 끝난 뒤 적용된다 (펌웨어와 같은 동작).
- [ ] **Step 2: 실패 확인**: `npx vitest run tests/sim` → FAIL
- [ ] **Step 3: 구현.** IK는 표준 3DOF 해석해(a = atan2, 나머지 둘은 코사인 법칙, 무릎은 아래로 굽힘). 걸음새는 펌웨어 `Robot::update`(258~395줄)의 사인 궤적을 근사한다. 이동 중에는 roll과 yaw를 0으로 둔다 (펌웨어 `move`, 588~636줄). 회피 모드는 시뮬레이터에 장애물이 없으므로 vy 2로 전진, 균형 모드는 평지라서 자세 변화가 없다.
- [ ] **Step 4: 통과 확인**: `npx vitest run tests/sim` → PASS
- [ ] **Step 5: 커밋**: `git commit -am "feat: hexapod kinematics, tripod gait and sim robot model"`

---

### Task 6: UI, 렌더링, 메인 루프 조립

**Files:**
- Create: `src/sim/scene.ts`, `src/ui/bindingWizard.ts`, `src/ui/statusPanel.ts`
- Modify: `src/main.ts`, `index.html`
- Test: `tests/ui/wizardSteps.test.ts` (지정 순서 로직만)

**Interfaces:**
- Consumes: Task 2 전체, Task 3 `Controller`, Task 4 `BleTransport`, `Fanout`, Task 5 `SimRobot`, `SimFrame`.
- Produces:
  ```ts
  export const WIZARD_STEPS: { fn: ControlFunction; prompt: string; skippable: boolean }[]; // REQUIRED_FUNCTIONS는 skippable:false
  export function nextWizardStep(i: number, skipped: boolean): number | 'done';
  export function createScene(canvas: HTMLCanvasElement): { render(f: SimFrame): void; resize(): void };
  ```

- [ ] **Step 1: wizard 테스트 작성**: 단계는 모든 `ControlFunction`을 한 번씩 포함한다. 필수 단계에서 건너뛰기를 시도하면 같은 단계에 머문다. 마지막 단계 다음은 `'done'`.
- [ ] **Step 2: 실패 확인 → 구현 → 통과 확인**: `npx vitest run tests/ui`
- [ ] **Step 3: 화면 구현.**
  - **scene**: 7.6×14 몸체 상자, 다리 마디 3개짜리 원통, 바닥 격자, 몸체를 따라가는 카메라, LED 색 구.
  - **statusPanel**: 연결 상태, 배터리(V), 거리, 모드, "동작 중 (n초)", 경고 배너.
  - **화면 구성**: "로봇 연결" 버튼(BleTransport.connect), "비상 정지" 버튼(`controller.estop`), "버튼 지정" 버튼과 매핑 내보내기/불러오기.
  - **매핑 저장**: localStorage 키 `minihexa.mapping.v1`. 읽기와 쓰기는 try/catch로 감싼다. 기록이 없으면 처음에 지정 화면을 띄운다.
- [ ] **Step 4: main 루프 구현.**
  - `requestAnimationFrame`마다 다음을 실행한다: `navigator.getGamepads()`에서 연결된 첫 패드 → PadSnapshot → `readControls` → `controller.update` → 결과를 `fanout.send`로 전송 → `sim.tick` → `scene.render` → `statusPanel` 갱신.
  - `gamepaddisconnected` 이벤트가 오면 `controller.gamepadLost`. `visibilitychange`(hidden)나 `blur` 이벤트가 오면 `controller.hidden`. 둘 다 결과를 즉시 전송한다. rAF는 탭이 숨겨지면 멈추므로 이벤트에서 직접 보내야 한다.
  - BLE가 끊겼을 때 마지막으로 보낸 이동이 0이 아니었으면 "로봇이 계속 걷고 있을 수 있습니다. 전원을 끄거나 다시 연결하세요" 경고를 표시한다.
- [ ] **Step 5: 수동 확인 (로봇 없이)**: `npm run dev` → Chrome에서 localhost를 연다. 지정 화면 → 스틱으로 시뮬레이터 보행 → 손을 떼면 정지 → 다른 탭으로 전환하면 정지 → 패드 전원을 끄면 정지.
- [ ] **Step 6: 확인**: `npm test && npm run typecheck && npm run build` 모두 성공
- [ ] **Step 7: 커밋**: `git commit -am "feat: UI, binding wizard, 3D scene and main loop"`

---

### Task 7: GitHub Pages 배포 + 실기 검증

**Files:**
- Create: `.github/workflows/pages.yml`, `README.md` (사용법: 주소, Chrome 블루투스 권한, 버튼 지정)

- [ ] **Step 1: 워크플로 작성**: main에 push하면 `npm ci && npm test && npm run build` → `actions/upload-pages-artifact`(dist) → `actions/deploy-pages`.
- [ ] **Step 2: 사용자 확인 후 공개 저장소 생성.** 공개 저장소를 만드는 것은 외부에 공개하는 일이므로, 저장소 이름을 사용자에게 확인받은 뒤 `gh repo create <name> --public --source . --push`를 실행하고 Pages 소스를 GitHub Actions로 설정한다. `git ls-files | grep vendor`가 비어 있는지 먼저 확인한다.
- [ ] **Step 3: 배포 확인**: Actions 실행이 성공하고, Pages 주소가 두 맥의 Chrome에서 열린다.
- [ ] **Step 4: 실기 검증 체크리스트 (사용자와 함께, 결과를 README에 기록)**
  - [ ] Apple Silicon 맥과 Intel 맥(Chrome 150) 각각에서 BLE 연결, 배터리와 거리 표시
  - [ ] 전후좌우 방향이 시뮬레이터와 실기에서 일치하는지 확인 (+y가 앞인지). 다르면 `kinematics.ts`나 `commandToVelocity` 부호를 고친다
  - [ ] 스틱을 놓으면 정지, 탭 전환하면 정지, 패드를 끄면 정지, 비상 정지 버튼
  - [ ] 내장 동작 1~5의 실제 소요 시간을 측정해 `actions.ts`와 비교 (±500ms를 넘으면 수정)
  - [ ] 회피와 균형 모드 켜기와 끄기
  - [ ] 시뮬레이터 보행 속도(`GAIT.cmPerSecAtMax`)를 실기에 맞게 조정
- [ ] **Step 5: 커밋 & 푸시**: `git commit -am "chore: pages deploy and stage-1 verification notes" && git push`
