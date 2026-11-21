// DOM dashboard for twin.html. Renders only what twin.js derives from
// transport STATE/CAL/LIMITS; no protocol parsing here.
import { isSafeQ } from "./machine.mjs";

const $ = (id) => document.getElementById(id);
const JOINT_NAMES = ["J1 肩", "J2 肘", "J3 腕"];
const fmt = (value, digits = 1) =>
  Number.isFinite(value) ? value.toFixed(digits) : "—";

export function createUi({ onStop, onRetry, onTorque }) {
  const cards = JOINT_NAMES.map((name) => {
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

  const hud = $("hud");
  const gateBox = document.createElement("div");
  hud.append(gateBox);

  const retry = document.createElement("button");
  retry.type = "button";
  retry.textContent = "重试连接";
  retry.hidden = true;
  retry.style.cssText =
    "margin-top:8px;width:100%;padding:5px 8px;border-radius:8px;" +
    "border:1px solid #6a4a2e;background:#241a13;color:#eadfce;" +
    "cursor:pointer;font:inherit;font-size:12px;";
  retry.addEventListener("click", () => onRetry?.());
  hud.append(retry);

  const torque = document.createElement("button");
  torque.type = "button";
  torque.textContent = "上力（保持当前姿态）";
  torque.hidden = true;
  torque.style.cssText = retry.style.cssText;
  torque.addEventListener("click", () => onTorque?.());
  hud.append(torque);

  const el = {
    conn: $("conn"),
    mode: $("mode"),
    volt: $("volt"),
    age: $("age"),
    targetXy: $("target-xy"),
    errorMm: $("error-mm"),
    psi: $("psi"),
    hint: $("hint"),
    stop: $("stop"),
  };
  el.stop.addEventListener("click", () => onStop?.());
  let lastReadOnly = null;

  const renderGate = (gate) => {
    gateBox.replaceChildren();
    const head = document.createElement("div");
    head.className = "line";
    const label = document.createElement("span");
    label.textContent = "门禁";
    const value = document.createElement("b");
    value.textContent = gate.ready ? "就绪" : `缺 ${gate.missing.length} 项`;
    head.append(label, value);
    gateBox.append(head);
    for (const message of gate.missing) {
      const row = document.createElement("div");
      row.className = "line";
      const dot = document.createElement("span");
      dot.textContent = "·";
      const text = document.createElement("b");
      text.textContent = message;
      row.append(dot, text);
      gateBox.append(row);
    }
    if (!gate.ready) {
      const link = document.createElement("a");
      link.className = "gate-link";
      link.href = "servo.html";
      link.textContent = "打开 09 标定台 →";
      gateBox.append(link);
    }
  };

  const update = (view) => {
    if (view.connection !== undefined) el.conn.textContent = view.connection;
    if (view.state) {
      el.mode.textContent = view.state.mode ?? "—";
      el.volt.textContent = Number.isFinite(view.state.v)
        ? `${fmt(view.state.v / 10)} V`
        : "—";
      el.age.textContent = Number.isFinite(view.state.age)
        ? `${view.state.age} ms`
        : "—";
    } else {
      el.mode.textContent = "—";
      el.volt.textContent = "—";
      el.age.textContent = "—";
    }

    cards.forEach((card, i) => {
      card.target.textContent = fmt(view.target?.[i]);
      card.actual.textContent = fmt(view.actual?.[i]);
      const range = view.ranges?.[i];
      if (!range) {
        card.zone.style.width = "0%";
        card.chip.textContent = "不可用";
        card.chip.className = "chip bad";
        return;
      }
      const pad = Math.max(8, (range.max - range.min) * 0.15);
      const lo = range.min - pad;
      const span = range.max + pad - lo;
      card.zone.style.left = `${((range.min - lo) / span) * 100}%`;
      card.zone.style.width = `${((range.max - range.min) / span) * 100}%`;
      const percent = ((view.actual?.[i] - lo) / span) * 100;
      card.marker.style.left = `${Math.min(100, Math.max(0, percent))}%`;
      const safe = isSafeQ(view.actual, view.ranges);
      card.chip.textContent = safe ? "safe" : "越界";
      card.chip.className = `chip ${safe ? "ok" : "bad"}`;
    });

    if (view.readout) {
      el.targetXy.textContent = view.readout.targetXy;
      el.errorMm.textContent = view.readout.errorMm;
      el.psi.textContent = view.readout.psi;
    }
    if (view.gate) renderGate(view.gate);
    if (view.hint !== undefined) el.hint.textContent = view.hint;
    if (view.readOnly !== undefined && view.readOnly !== lastReadOnly) {
      lastReadOnly = view.readOnly;
      el.stop.disabled = view.readOnly;
      el.stop.textContent = "STOP";
      el.stop.style.opacity = view.readOnly ? "0.55" : "1";
      el.stop.style.cursor = view.readOnly ? "not-allowed" : "pointer";
    }
    if (view.retry !== undefined) {
      retry.hidden = !view.retry;
      retry.textContent = view.retry === "retry" ? "重试连接" : "连接串口";
    }
    if (view.torqueAvailable !== undefined) torque.hidden = !view.torqueAvailable;

    // Keep the joint cards clear of a HUD that grew (gate/list/error lines).
    $("joints").style.top = window.matchMedia("(min-width: 681px)").matches
      ? `${hud.offsetTop + hud.offsetHeight + 10}px`
      : "";
  };

  return { update };
}
