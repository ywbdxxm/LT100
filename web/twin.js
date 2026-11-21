import { loadMachine, safeModelRanges, toModelQ } from "./arm/machine.mjs";
import { fk } from "./arm/kinematics.mjs";
import { createScene } from "./arm/scene.mjs";
import { createRig } from "./arm/model.mjs";
import { createTransport, evaluateGate } from "./arm/transport.mjs";
import { createUi } from "./arm/ui.mjs";
import { createInteraction } from "./arm/interaction.mjs";

const $ = (id) => document.getElementById(id);
const query = new URLSearchParams(location.search);
const mockMode = query.get("mock") === "1";
const fault = query.get("fault");
const bridgeUrl = query.get("url") ?? "ws://127.0.0.1:8771/serial";

const VIEWS = {
  front: { pos: [0, 300, 1180], target: [0, 250, 0] },
  side: { pos: [1180, 300, 10], target: [0, 250, 0] },
  iso: { pos: [900, 520, 1150], target: [180, 230, 0] },
};

const DEFAULT_HINT =
  "拖动灯头：按在灯罩上拖动；松手 / Esc / STOP 停止。实体=已发目标，冷色=实际。";

const state = {
  machine: null,
  target: [],
  actual: [],
  ranges: null,
  solid: null,
  ghost: null,
  transport: null,
  ui: null,
  interaction: null,
  connection: "未连接",
  connectError: "",
  phase: "idle",
  retry: "connect",
  hint: DEFAULT_HINT,
  dragHint: "",
  holdUntil: 0,
};

const fmt = (value, digits = 1) =>
  Number.isFinite(value) ? value.toFixed(digits) : "—";

function showFatal(message) {
  const box = $("fatal");
  box.textContent = message;
  box.hidden = false;
  document.body.dataset.error = "1";
}

function readout(machine, target, actual) {
  const targetPose = fk(machine, target);
  const actualPose = fk(machine, actual);
  return {
    targetXy: `${fmt(targetPose.lamp.x)}, ${fmt(targetPose.lamp.y)} mm`,
    errorMm: `${fmt(
      Math.hypot(
        targetPose.lamp.x - actualPose.lamp.x,
        targetPose.lamp.y - actualPose.lamp.y
      ),
      2
    )} mm`,
    psi: `${fmt(targetPose.psi)}°`,
  };
}

function refresh() {
  const { machine, transport } = state;
  if (!machine || !transport) return;

  const hello = transport.getHello();
  const snapshot = transport.getState();
  const stateAt = transport.getStateAt();
  const cals = transport.getCals();
  const limits = transport.getLimits();
  const ranges = safeModelRanges(cals, limits, machine);
  state.ranges = ranges;

  if (snapshot && cals.length === 3 && cals.every((cal) => cal?.valid)) {
    try {
      state.actual = toModelQ(snapshot.q, cals, machine);
    } catch {}
  }
  if (!mockMode && !state.interaction?.isDragging() && performance.now() >= state.holdUntil) {
    state.target = [...state.actual];
  }

  state.solid?.setPose(state.target);
  state.ghost?.setPose(state.actual);

  let gate = evaluateGate({
    machine,
    hello,
    state: snapshot,
    stateAt,
    now: performance.now(),
    cals,
    limits,
    ranges,
  });
  if (state.phase === "idle") gate = { ready: false, missing: ["未连接串口"] };

  const error = transport.getLastError();
  state.interaction?.update({
    gate,
    actual: state.actual,
    state: snapshot,
    error,
    ranges,
  });

  let hint = state.hint;
  if (state.phase === "idle") {
    hint = "默认不自动连接：点「连接串口」开始。";
  } else if (state.phase === "connecting") {
    hint = "正在连接串口…";
  } else if (state.connectError) {
    hint = `连接失败：${state.connectError}`;
  } else if (state.phase === "disconnected") {
    hint = "串口桥断开，请点重试连接";
  } else if (error) {
    hint = `固件 ERR ${error.code} ${error.msg}`;
  } else if (state.dragHint) {
    hint = state.dragHint;
  } else if (gate.ready) {
    hint = "门禁通过 · 可拖动灯头（松手 STOP）";
  } else if (snapshot) {
    hint = `门禁未通过（缺 ${gate.missing.length} 项）：${gate.missing[0]}`;
  }

  const calsOk = cals.length === 3 && cals.every((cal) => cal?.valid);
  const torqueAvailable = Boolean(
    snapshot && snapshot.online === 7 && calsOk && snapshot.torque !== 7
  );

  state.ui.update({
    connection: state.connection,
    state: snapshot,
    target: state.target,
    actual: state.actual,
    ranges,
    gate,
    readout: snapshot
      ? readout(machine, state.target, state.actual)
      : { targetXy: "—", errorMm: "—", psi: "—" },
    readOnly: state.phase !== "connected",
    torqueAvailable,
    hint,
    retry: state.retry,
  });
}

async function connectBridge() {
  state.phase = "connecting";
  state.connection = "连接中…";
  state.connectError = "";
  state.retry = false;
  refresh();
  try {
    await state.transport.connect();
    state.phase = "connected";
    state.connection = mockMode ? "已连接（mock）" : "已连接（真板）";
    state.dragHint = "";
    state.hint = DEFAULT_HINT;
  } catch (error) {
    state.phase = "failed";
    state.connectError = error.message;
    state.connection = "连接失败（桥被占用或未启动）";
    state.retry = "retry";
    state.dragHint = "";
  }
  refresh();
}

async function boot() {
  state.machine = await loadMachine();
  state.target = state.machine.joints.map((joint) => joint.model_ref_q);
  state.actual = [...state.target];
  state.ui = createUi({
    onStop: () => state.interaction?.stopNow("STOP 按钮"),
    onRetry: () => connectBridge(),
    onTorque: () => {
      state.transport?.send("TORQUE all ON");
      refresh();
    },
  });
  $("mode-badge").textContent = mockMode ? "mock" : "real";

  let scene;
  try {
    scene = createScene($("stage"), state.machine);
  } catch (error) {
    showFatal(`WebGL 不可用：${error.message}。请换用支持 WebGL 的浏览器或设备。`);
    return;
  }

  state.solid = createRig(state.machine);
  state.ghost = createRig(state.machine, { ghost: true, beam: true });
  scene.scene.add(state.solid.group, state.ghost.group);
  state.solid.setPose(state.target);
  state.ghost.setPose(state.actual);

  state.transport = createTransport({
    url: bridgeUrl,
    mock: mockMode,
    machine: state.machine,
    fault,
  });
  state.transport.onLine(() => refresh());
  state.transport.onDisconnect(() => {
    state.phase = "disconnected";
    state.connection = "连接断开";
    state.connectError = "";
    state.hint = "串口桥断开，请点重试连接";
    state.retry = "retry";
    state.dragHint = "";
    refresh();
  });

  // Read-only QA hook: TX targets / STOP timestamps; no business logic reads it.
  window.__lt100Twin = {
    poses: [],
    stops: [],
    target: () => [...state.target],
    actual: () => [...state.actual],
    safe: () => state.ranges,
    snapshot: () => state.transport?.getState() ?? null,
    lampScreen: () =>
      state.solid.getLampScreen(
        scene.camera,
        $("stage").clientWidth,
        $("stage").clientHeight
      ),
    marker: () => state.solid.isMarkerVisible(),
    clear() {
      this.poses.length = 0;
      this.stops.length = 0;
    },
  };

  state.interaction = createInteraction({
    canvas: $("stage"),
    camera: scene.camera,
    controls: scene.controls,
    rig: state.solid,
    machine: state.machine,
    transport: state.transport,
    safeRanges: null,
    onTarget: (q) => {
      state.target = q;
      state.solid.setPose(q);
    },
    onStop: (reason) => {
      state.holdUntil = performance.now() + 350;
      state.dragHint = `已停止：${reason}`;
    },
    onAlign: (q) => {
      state.target = [...q];
      state.solid.setPose(q);
    },
    onStatus: (text) => {
      state.dragHint = text;
    },
    onPose: (seq, q) => {
      window.__lt100Twin?.poses.push({ seq, q: [...q], at: performance.now() });
    },
    onStopSent: () => {
      window.__lt100Twin?.stops.push({ at: performance.now() });
    },
  });

  let currentView = "iso";
  let narrow = false;
  const applyView = (name) => {
    const view = VIEWS[name];
    if (!view) return;
    currentView = name;
    const stage = $("stage");
    const aspect = (stage.clientWidth || 1) / (stage.clientHeight || 1);
    narrow = aspect < 0.7;
    const scale = narrow ? 1.35 : 1;
    const [tx, ty, tz] = view.target;
    scene.camera.position.set(
      tx + (view.pos[0] - tx) * scale,
      ty + (view.pos[1] - ty) * scale,
      tz + (view.pos[2] - tz) * scale
    );
    scene.controls.target.set(tx, ty, tz);
    scene.controls.update();
    document
      .querySelectorAll("[data-view]")
      .forEach((other) => other.classList.toggle("on", other.dataset.view === name));
  };

  document.querySelectorAll("[data-view]").forEach((button) => {
    button.addEventListener("click", () => applyView(button.dataset.view));
  });
  applyView(currentView);

  window.addEventListener("resize", () => {
    const stage = $("stage");
    const nextNarrow =
      (stage.clientWidth || 1) / (stage.clientHeight || 1) < 0.7;
    if (nextNarrow !== narrow) applyView(currentView);
  });

  const loop = () => {
    if (!document.hidden) scene.render();
    requestAnimationFrame(loop);
  };
  loop();
  refresh();
  if (mockMode && query.get("auto") !== null) {
    await connectBridge();
  }
  setInterval(refresh, 200);

  requestAnimationFrame(() => {
    document.body.dataset.ready = "1";
  });
}

window.addEventListener("error", (event) => showFatal(`脚本错误：${event.message}`));
window.addEventListener("unhandledrejection", (event) => {
  showFatal(`未处理异常：${event.reason?.message ?? event.reason}`);
});

boot().catch((error) => showFatal(`初始化失败：${error.message}`));
