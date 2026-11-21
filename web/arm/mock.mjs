// Mock LT100P/1 firmware for twin.html?mock=1. No serial, no hardware.
// CAL/LIMITS are the real board values read 2026-11-22 (COM4); geometry comes
// from machine.json so mock and model cannot drift apart.
import { parseLine } from "../lt100-protocol.mjs";
import { safeModelRanges } from "./machine.mjs";

export const MOCK_CALS = [
  { id: 1, ref: 0, min_set: 1, max_set: 1, zeroRaw: 3672, zeroQ: 0, sign: 1, minRaw: 3378, maxRaw: 4095, margin: 40, valid: true, wrap: false },
  { id: 2, ref: 0, min_set: 1, max_set: 1, zeroRaw: 496, zeroQ: 0, sign: 1, minRaw: 61, maxRaw: 962, margin: 40, valid: true, wrap: false },
  { id: 3, ref: 0, min_set: 1, max_set: 1, zeroRaw: 1058, zeroQ: 0, sign: 1, minRaw: 599, maxRaw: 1983, margin: 40, valid: true, wrap: false },
];

export const MOCK_LIMITS = [
  { id: 1, minRaw: 3378, maxRaw: 4095, safeMin: 3418, safeMax: 4055, wrap: false, valid: true },
  { id: 2, minRaw: 61, maxRaw: 962, safeMin: 101, safeMax: 922, wrap: false, valid: true },
  { id: 3, minRaw: 599, maxRaw: 1983, safeMin: 639, safeMax: 1943, wrap: false, valid: true },
];

// Demo-only offset from the reference pose, so ghost and beam are visible.
const DEMO_OFFSET = [-12, -8, -35];

const TICKS_PER_DEGREE = 4096 / 360;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function calLine(cal) {
  return `CAL id=${cal.id} ref=${cal.ref} min_set=${cal.min_set} max_set=${cal.max_set} ` +
    `zero_raw=${cal.zeroRaw} zero_q=${cal.zeroQ} sign=${cal.sign} min=${cal.minRaw} ` +
    `max=${cal.maxRaw} margin=${cal.margin} valid=1 wrap=0`;
}

function limitsLine(limit) {
  return `LIMITS id=${limit.id} min=${limit.minRaw} max=${limit.maxRaw} ` +
    `safe=${limit.safeMin}..${limit.safeMax} wrap=0 valid=1`;
}

export function createMockTransport(machine) {
  const REF = machine.joints.map((joint) => joint.model_ref_q);
  const SAFE_MODEL = safeModelRanges(MOCK_CALS, MOCK_LIMITS, machine);
  if (!SAFE_MODEL) throw new Error("mock: 实板 CAL/LIMITS 与 machine 不兼容");

  let onLine = () => {};
  let connected = false;
  let streaming = false;
  let torque = 7;
  let stateSeq = 0;
  let timer = null;
  let target = null;
  const actual = REF.map((value, i) =>
    clamp(value + DEMO_OFFSET[i], SAFE_MODEL[i].min, SAFE_MODEL[i].max)
  );

  const emit = (line) => queueMicrotask(() => onLine(line));

  const stateLine = () => {
    const q = actual.map((value, i) => value - REF[i]);
    const raw = q.map((value, i) => {
      const cal = MOCK_CALS[i];
      return ((cal.zeroRaw + cal.sign * value * TICKS_PER_DEGREE) % 4096 + 4096) % 4096 | 0;
    });
    return `STATE seq=${stateSeq} mode=READY online=7 cal=7 torque=${torque} err=0 age=16 ` +
      `q=${q.map((value) => value.toFixed(1)).join(",")} raw=${raw.join(",")} ` +
      `load=100,100,100 cur=20,20,20 v=120 t=39,40,38`;
  };

  const tick = () => {
    if (target) {
      let moving = false;
      for (let i = 0; i < 3; i++) {
        const delta = target[i] - actual[i];
        if (Math.abs(delta) > 0.01) moving = true;
        const step = Math.max(-2.5, Math.min(2.5, delta));
        actual[i] = clamp(actual[i] + step, SAFE_MODEL[i].min, SAFE_MODEL[i].max);
      }
      if (!moving) target = null;
    }
    if (streaming) emit(stateLine());
  };

  const send = (line) => {
    const parsed = parseLine(line);
    if (!parsed) return;
    switch (parsed.verb) {
      case "HELLO":
        emit("HELLO protocol=1 fw=0.1.0-mock cal=1 features=state,stream,motion,cal,limits");
        break;
      case "STREAM":
        streaming = parsed.args[0] === "ON";
        emit(`OK stream=${streaming ? "on" : "off"}`);
        if (streaming) emit(stateLine());
        break;
      case "STATE":
        emit(stateLine());
        break;
      case "CAL":
        if (parsed.args[0] === "STATUS") {
          MOCK_CALS.forEach((cal) => emit(calLine(cal)));
          emit("OK cal");
        }
        break;
      case "LIMITS":
        MOCK_LIMITS.forEach((limit) => emit(limitsLine(limit)));
        emit("OK limits");
        break;
      case "POSE": {
        const values = String(parsed.fields.q ?? "").split(",").map(Number);
        if (values.length !== 3 || !values.every(Number.isFinite)) break;
        if (torque !== 7) {
          emit(`ERR code=11 seq=${parsed.fields.seq ?? 0} joint=0 msg=bad_mode`);
          break;
        }
        const model = values.map((value, i) => value + REF[i]);
        const bad = model.findIndex(
          (value, i) =>
            value < SAFE_MODEL[i].min - 1e-9 || value > SAFE_MODEL[i].max + 1e-9
        );
        if (bad >= 0) {
          emit(`ERR code=10 seq=${parsed.fields.seq ?? 0} joint=${bad + 1} msg=outside_safe`);
          break;
        }
        target = model;
        const seq = Number(parsed.fields.seq);
        if (Number.isFinite(seq)) stateSeq = seq;
        break;
      }
      case "STOP":
        target = null;
        break;
      case "TORQUE":
        torque = parsed.args[1] === "ON" ? 7 : 0;
        if (torque !== 7) target = null;
        emit(`OK torque=${torque ? "on" : "off"}`);
        emit(stateLine());
        break;
      default:
        break;
    }
  };

  return {
    connect: async () => {
      if (connected) return;
      connected = true;
      timer = setInterval(tick, 100);
    },
    close: () => {
      connected = false;
      streaming = false;
      target = null;
      clearInterval(timer);
      timer = null;
    },
    send,
    onLine: (callback) => {
      onLine = callback;
    },
    get state() {
      return { actual: [...actual], target: target ? [...target] : null, torque };
    },
  };
}
