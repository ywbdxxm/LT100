// LT100P/1 transport + read-only gate. No DOM.
// M3 never sends POSE: sendPose exists for M4 but has no call site here.
import {
  commands,
  parseCalLine,
  parseError,
  parseHello,
  parseLimitsLine,
  parseState,
  poseCommand,
} from "../lt100-protocol.mjs";
import { isSafeQ, toModelQ } from "./machine.mjs";
import { createMockTransport } from "./mock.mjs";

const HELLO_TIMEOUT_MS = 2500;
const FRESH_MS = 300;
const REQUIRED_FEATURES = ["state", "stream", "motion", "cal", "limits"];

// Serial-bridge WS frames can split a line anywhere; never parse a partial tail.
export function feedLines(buffer, chunk) {
  const text = `${buffer ?? ""}${chunk ?? ""}`;
  const parts = text.split(/\r?\n/);
  const rest = parts.pop() ?? "";
  const lines = parts.map((part) => part.trim()).filter(Boolean);
  return { lines, rest };
}

function createStore() {
  let hello = null;
  let state = null;
  let stateAt = 0;
  let lastError = null;
  const cals = [null, null, null];
  const limits = [null, null, null];
  let listener = () => {};

  const reset = () => {
    hello = null;
    state = null;
    stateAt = 0;
    lastError = null;
    cals.fill(null);
    limits.fill(null);
  };

  const feed = (line) => {
    const helloLine = parseHello(line);
    if (helloLine) hello = helloLine;
    const snapshot = parseState(line);
    if (snapshot) {
      state = snapshot;
      stateAt = performance.now();
    }
    const cal = parseCalLine(line);
    if (cal && cal.id >= 1 && cal.id <= 3) cals[cal.id - 1] = cal;
    const limit = parseLimitsLine(line);
    if (limit && limit.id >= 1 && limit.id <= 3) limits[limit.id - 1] = limit;
    const error = parseError(line);
    if (error) lastError = error;
    listener(line);
  };

  return {
    feed,
    reset,
    setListener: (callback) => {
      listener = callback;
    },
    getHello: () => hello,
    getState: () => state,
    getStateAt: () => stateAt,
    getCals: () => cals,
    getLimits: () => limits,
    getLastError: () => lastError,
  };
}

function waitFor(predicate, timeoutMs, message) {  return new Promise((resolve, reject) => {
    const started = performance.now();
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
      } else if (performance.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error(message));
      }
    }, 25);
  });
}

// Mock-only QA seam (fault=online|cal|torque|motion|stale|wrap|q).
function faultState(state, fault) {
  if (!state || !fault) return state;
  const copy = { ...state };
  if (fault === "online") copy.online = 0;
  else if (fault === "torque") copy.torque = 0;
  else if (fault === "motion") copy.mode = "MOTION";
  else if (fault === "stale") copy.age = 999;
  else if (fault === "cal") copy.cal = 6;
  else if (fault === "q") copy.q = [999, 0, 0];
  return copy;
}

export function createTransport({
  url = "ws://127.0.0.1:8771/serial",
  mock = false,
  machine,
  fault = null,
} = {}) {
  if (!machine) throw new Error("createTransport 需要 machine（几何/参考角）");
  const activeFault = mock ? fault : null;
  const store = createStore();
  const inner = mock ? createMockTransport(machine) : null;

  let socket = null;
  let connected = false;
  let handshaked = false;
  let rxBuffer = "";
  let closing = false;
  let disconnectNotified = false;
  let disconnectListener = () => {};

  const send = (line) => {
    if (inner) {
      inner.send(line);
      return;
    }
    if (socket && socket.readyState === WebSocket.OPEN) socket.send(`${line}\n`);
  };

  const handshake = () => {
    if (handshaked) return;
    handshaked = true;
    send("STREAM ON");
    send(commands.state);
    send(commands.calStatus);
    send(commands.limits);
  };

  const onWireLine = (line) => {
    store.feed(line);
    if (store.getHello()) handshake();
  };

  const openSocket = () =>
    new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      let settled = false;
      let opened = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        closing = true;
        try {
          ws.close();
        } catch {}
        reject(
          new Error(
            "连接超时：串口桥可能被其他页面占用（先关闭 09 标定台/其他 LT100 标签再试）"
          )
        );
      }, HELLO_TIMEOUT_MS);
      ws.onopen = () => {
        settled = true;
        opened = true;
        clearTimeout(timer);
        resolve(ws);
      };
      ws.onerror = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(
          new Error(
            "无法连接本机串口桥：请确认 serial-bridge 已启动，且没有其他页面占用"
          )
        );
      };
      ws.onclose = () => {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          reject(new Error("串口桥关闭了连接：可能被 09 标定台等页面占用"));
          return;
        }
        if (opened && !closing && !disconnectNotified) {
          disconnectNotified = true;
          connected = false;
          socket = null;
          store.reset();
          handshaked = false;
          rxBuffer = "";
          disconnectListener();
        }
      };
      ws.onmessage = (event) => {
        const { lines, rest } = feedLines(
          rxBuffer,
          typeof event.data === "string" ? event.data : ""
        );
        rxBuffer = rest;
        for (const line of lines) onWireLine(line);
      };
    });

  const connect = async () => {
    if (connected) return;
    store.reset();
    handshaked = false;
    rxBuffer = "";
    closing = false;
    disconnectNotified = false;
    if (inner) {
      inner.onLine(onWireLine);
      await inner.connect();
      connected = true;
      send("HELLO");
    } else {
      socket = await openSocket();
      connected = true;
      send("HELLO");
    }
    try {
      await waitFor(
        () => store.getHello(),
        HELLO_TIMEOUT_MS,
        "HELLO 超时：桥已连上但固件无响应（先关闭 09 标定台/其他 LT100 标签再试）"
      );
    } catch (error) {
      close();
      throw error;
    }
  };

  const close = () => {
    connected = false;
    handshaked = false;
    rxBuffer = "";
    if (inner) inner.close();
    if (socket) {
      closing = true;
      try {
        socket.close();
      } catch {}
      socket = null;
    }
  };

  const getState = () => faultState(store.getState(), activeFault);
  const getStateAt = () =>
    activeFault === "stale" ? performance.now() - 2000 : store.getStateAt();
  const getCals = () => {
    const cals = store.getCals();
    if (activeFault !== "cal") return cals;
    return cals.map((cal) => (cal ? { ...cal, valid: false } : cal));
  };
  const getLimits = () => {
    const limits = store.getLimits();
    if (activeFault !== "wrap") return limits;
    return limits.map((limit, i) => (i === 0 && limit ? { ...limit, wrap: true } : limit));
  };

  return {
    connect,
    close,
    send,
    onLine: (callback) => store.setListener(callback),
    onDisconnect: (callback) => {
      disconnectListener = callback;
    },
    sendPose: (seq, q, speed = 25, acc = 20) => send(poseCommand(seq, q, speed, acc)),
    stop: () => send(commands.stop),
    getHello: () => store.getHello(),
    getState,
    getStateAt,
    getCals,
    getLimits,
    getLastError: () => store.getLastError(),
  };
}

// Pure read-only gate. `stateAt` and `now` share one clock (performance.now).
export function evaluateGate({
  machine,
  hello,
  state,
  stateAt,
  now,
  cals,
  limits,
  ranges,
}) {
  const missing = [];

  const featuresOk =
    hello &&
    hello.protocol === 1 &&
    REQUIRED_FEATURES.every((feature) => hello.features?.includes(feature));
  if (!featuresOk) missing.push("HELLO 缺失或协议/功能不匹配");

  if (!state) {
    missing.push("未收到 STATE");
  } else {
    if (state.online !== 7) missing.push("online≠7：三关节未全部在线");
    if (state.cal !== 7) missing.push("cal≠7：三关节未全部标定");
    if (state.torque !== 7) missing.push("torque≠7：力矩未开启");
    if (state.mode !== "READY") missing.push(`mode=${state.mode}，不是 READY`);
    if (!(state.age <= FRESH_MS)) {
      missing.push(`STATE age=${state.age} ms 过期（>${FRESH_MS}）`);
    }
    if (!Number.isFinite(stateAt) || !(now - stateAt <= FRESH_MS)) {
      missing.push(`STATE 超过 ${FRESH_MS} ms 未更新`);
    }
  }

  const calsOk =
    Array.isArray(cals) && cals.length === 3 && cals.every((cal) => cal?.valid);
  if (!calsOk) missing.push("CAL STATUS 无效");
  const limitsOk =
    Array.isArray(limits) &&
    limits.length === 3 &&
    limits.every((limit) => limit?.valid && !limit.wrap);
  if (!limitsOk) missing.push("LIMITS 无效或 wrap=1");
  if (!Array.isArray(ranges) || ranges.length !== 3) missing.push("safe 范围不可用");

  if (state && calsOk && Array.isArray(ranges) && ranges.length === 3) {
    let model = null;
    try {
      model = toModelQ(state.q, cals, machine);
    } catch {
      model = null;
    }
    if (!model || !isSafeQ(model, ranges)) missing.push("实测 q 不在 safe 内");
  }

  return { ready: missing.length === 0, missing };
}
