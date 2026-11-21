import { isSafeQ, loadMachine, safeModelRanges, toModelQ } from "./arm/machine.mjs";
import { fk } from "./arm/kinematics.mjs";
import { createScene } from "./arm/scene.mjs";
import { createRig } from "./arm/model.mjs";
import { createMockTransport } from "./arm/mock.mjs";
import {
  parseCalLine,
  parseError,
  parseHello,
  parseLimitsLine,
  parseState,
} from "./lt100-protocol.mjs";

const $ = (id) => document.getElementById(id);
const query = new URLSearchParams(location.search);
const mockMode = query.get("mock") === "1";

const VIEWS = {
  front: { pos: [0, 300, 1180], target: [0, 250, 0] },
  side: { pos: [1180, 300, 10], target: [0, 250, 0] },
  iso: { pos: [900, 520, 1150], target: [180, 230, 0] },
};

const state = {
  machine: null,
  target: [],
  cals: [],
  limits: [],
  ranges: null,
  actual: [],
  cards: [],
  transport: null,
};

const fmt = (value, digits = 1) =>
  Number.isFinite(value) ? value.toFixed(digits) : "—";

function showFatal(message) {
  const box = $("fatal");
  box.textContent = message;
  box.hidden = false;
  document.body.dataset.error = "1";
}

function buildCards() {
  const names = ["J1 肩", "J2 肘", "J3 腕"];
  return names.map((name) => {
    const card = document.createElement("div");
    card.className = "joint";
    card.innerHTML =
      `<div class="joint-head"><span>${name}</span><span class="chip" data-chip>—</span></div>` +
      `<div class="line"><span>目标</span><b data-target>—</b></div>` +
      `<div class="line"><span>实际</span><b data-actual>—</b></div>` +
      `<div class="bar"><span class="zone" data-zone></span><i class="marker" data-marker></i></div>`;
    $("joints").append(card);
    return {
      chip: card.querySelector("[data-chip]"),
      target: card.querySelector("[data-target]"),
      actual: card.querySelector("[data-actual]"),
      zone: card.querySelector("[data-zone]"),
      marker: card.querySelector("[data-marker]"),
    };
  });
}

function updateCards() {
  state.cards.forEach((card, i) => {
    card.target.textContent = fmt(state.target[i]);
    card.actual.textContent = fmt(state.actual[i]);
    const range = state.ranges?.[i];
    if (!range) {
      card.zone.style.width = "0%";
      card.chip.textContent = "不可用";
      card.chip.className = "chip bad";
      return;
    }
    const pad = Math.max(8, (range.max - range.min) * 0.15);
    const lo = range.min - pad;
    const hi = range.max + pad;
    const span = hi - lo;
    card.zone.style.left = `${((range.min - lo) / span) * 100}%`;
    card.zone.style.width = `${((range.max - range.min) / span) * 100}%`;
    const percent = ((state.actual[i] - lo) / span) * 100;
    card.marker.style.left = `${Math.min(100, Math.max(0, percent))}%`;
    const safe = isSafeQ(state.actual, state.ranges);
    card.chip.textContent = safe ? "safe" : "越界";
    card.chip.className = `chip ${safe ? "ok" : "bad"}`;
  });
}

function updateReadout() {
  const targetPose = fk(state.machine, state.target);
  const actualPose = fk(state.machine, state.actual);
  $("target-xy").textContent = `${fmt(targetPose.lamp.x)}, ${fmt(targetPose.lamp.y)} mm`;
  const error = Math.hypot(
    targetPose.lamp.x - actualPose.lamp.x,
    targetPose.lamp.y - actualPose.lamp.y
  );
  $("error-mm").textContent = `${fmt(error, 2)} mm`;
  $("psi").textContent = `${fmt(targetPose.psi)}°`;
}

async function boot() {
  state.machine = await loadMachine();
  state.target = state.machine.joints.map((joint) => joint.model_ref_q);
  state.actual = [...state.target];
  state.cards = buildCards();

  let scene;
  try {
    scene = createScene($("stage"), state.machine);
  } catch (error) {
    showFatal(`WebGL 不可用：${error.message}。请换用支持 WebGL 的浏览器或设备。`);
    return;
  }

  const solid = createRig(state.machine);
  const ghost = createRig(state.machine, { ghost: true, beam: true });
  scene.scene.add(solid.group, ghost.group);
  solid.setPose(state.target);
  ghost.setPose(state.actual);

  const refreshRanges = () => {
    state.ranges = safeModelRanges(state.cals, state.limits, state.machine);
    updateCards();
  };

  const onLine = (line) => {
    if (parseHello(line)) {
      $("conn").textContent = "已连接（mock）";
      return;
    }
    const cal = parseCalLine(line);
    if (cal && cal.id >= 1 && cal.id <= 3) {
      state.cals[cal.id - 1] = cal;
      refreshRanges();
      return;
    }
    const limit = parseLimitsLine(line);
    if (limit && limit.id >= 1 && limit.id <= 3) {
      state.limits[limit.id - 1] = limit;
      refreshRanges();
      return;
    }
    const snapshot = parseState(line);
    if (snapshot) {
      $("mode").textContent = snapshot.mode;
      $("volt").textContent = `${fmt(snapshot.v / 10)} V`;
      $("age").textContent = `${snapshot.age ?? "—"} ms`;
      if (state.cals.length === 3 && state.cals.every((item) => item?.valid)) {
        state.actual = toModelQ(snapshot.q, state.cals, state.machine);
        ghost.setPose(state.actual);
        updateReadout();
        updateCards();
      }
      return;
    }
    const error = parseError(line);
    if (error) $("hint").textContent = `ERR ${error.code} ${error.msg}`;
  };

  if (mockMode) {
    const transport = createMockTransport(state.machine);
    state.transport = transport;
    transport.onLine(onLine);
    await transport.connect();
    transport.send("HELLO");
    transport.send("STREAM ON");
    transport.send("CAL STATUS");
    transport.send("LIMITS");
    transport.send("STATE");
  } else {
    $("conn").textContent = "未连接（M2 仅 mock）";
    $("hint").textContent =
      "M2 是 mock 版本：打开 twin.html?mock=1&auto 查看孪生；真板只读连接在 M3。";
  }

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
    const nextNarrow = (stage.clientWidth || 1) / (stage.clientHeight || 1) < 0.7;
    if (nextNarrow !== narrow) applyView(currentView);
  });

  $("stop").addEventListener("click", () => {
    state.transport?.send("STOP");
    $("hint").textContent = "已发送 STOP";
  });

  updateCards();
  updateReadout();

  const loop = () => {
    if (!document.hidden) scene.render();
    requestAnimationFrame(loop);
  };
  loop();
  requestAnimationFrame(() => {
    document.body.dataset.ready = "1";
  });
}

window.addEventListener("error", (event) => showFatal(`脚本错误：${event.message}`));
window.addEventListener("unhandledrejection", (event) => {
  showFatal(`未处理异常：${event.reason?.message ?? event.reason}`);
});

boot().catch((error) => showFatal(`初始化失败：${error.message}`));
