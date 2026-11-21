import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { createTransport, evaluateGate, feedLines } from "../../../web/arm/transport.mjs";
import { safeModelRanges } from "../../../web/arm/machine.mjs";

const machine = JSON.parse(
  readFileSync(new URL("../../../web/arm/machine.json", import.meta.url), "utf8")
);

// 实板 2026-11-22 02:32（COM4）的 CAL/LIMITS。
const CALS = [
  { id: 1, ref: 0, min_set: 1, max_set: 1, zeroRaw: 3672, zeroQ: 0, sign: 1, minRaw: 3378, maxRaw: 4095, margin: 40, valid: true, wrap: false },
  { id: 2, ref: 0, min_set: 1, max_set: 1, zeroRaw: 496, zeroQ: 0, sign: 1, minRaw: 61, maxRaw: 962, margin: 40, valid: true, wrap: false },
  { id: 3, ref: 0, min_set: 1, max_set: 1, zeroRaw: 1058, zeroQ: 0, sign: 1, minRaw: 599, maxRaw: 1983, margin: 40, valid: true, wrap: false },
];
const LIMITS = [
  { id: 1, minRaw: 3378, maxRaw: 4095, safeMin: 3418, safeMax: 4055, wrap: false, valid: true },
  { id: 2, minRaw: 61, maxRaw: 962, safeMin: 101, safeMax: 922, wrap: false, valid: true },
  { id: 3, minRaw: 599, maxRaw: 1983, safeMin: 639, safeMax: 1943, wrap: false, valid: true },
];
const RANGES = safeModelRanges(CALS, LIMITS, machine);
const HELLO = {
  protocol: 1,
  features: ["state", "stream", "motion", "cal", "limits"],
};
const STATE = {
  seq: 0,
  mode: "READY",
  online: 7,
  cal: 7,
  torque: 7,
  err: 2,
  age: 16,
  q: [-12, -8, -35],
  raw: [3535, 957, 660],
  load: [100, 100, 100],
  cur: [20, 20, 20],
  temp: [39, 40, 38],
  v: 120,
};
const NOW = 100000;

const gate = (overrides = {}) =>
  evaluateGate({
    machine,
    hello: HELLO,
    state: STATE,
    stateAt: NOW - 50,
    now: NOW,
    cals: CALS,
    limits: LIMITS,
    ranges: RANGES,
    ...overrides,
  });

test("happy path：六项齐全，遗留 err=2 不拦门禁", () => {
  const result = gate();
  assert.equal(result.ready, true, JSON.stringify(result.missing));
  assert.deepEqual(result.missing, []);
});

test("STATE 新鲜度 300 ms 边界：age 与 now-stateAt", () => {
  assert.equal(gate({ state: { ...STATE, age: 300 }, stateAt: NOW - 300 }).ready, true);
  assert.equal(gate({ state: { ...STATE, age: 301 } }).ready, false);
  assert.equal(gate({ stateAt: NOW - 301 }).ready, false);
});

test("HELLO protocol 必须为 1", () => {
  const result = gate({ hello: { ...HELLO, protocol: 2 } });
  assert.equal(result.ready, false);
  assert.ok(result.missing.some((item) => item.includes("HELLO")));
});

test("HELLO 缺必需 feature 拒绝", () => {
  const result = gate({
    hello: { ...HELLO, features: ["state", "stream", "motion", "cal"] },
  });
  assert.equal(result.ready, false);
  assert.ok(result.missing.some((item) => item.includes("HELLO")));
});

test("未收到 STATE 拒绝", () => {
  const result = gate({ state: null });
  assert.equal(result.ready, false);
  assert.ok(result.missing.some((item) => item.includes("未收到 STATE")));
});

for (const [field, value, needle] of [
  ["online", 0, "online"],
  ["cal", 3, "cal"],
  ["torque", 0, "torque"],
]) {
  test(`missing：${field}=${value}`, () => {
    const result = gate({ state: { ...STATE, [field]: value } });
    assert.equal(result.ready, false);
    assert.ok(result.missing.some((item) => item.includes(needle)));
  });
}

for (const mode of ["MOTION", "FAULT", "CAL", "ESTOP"]) {
  test(`missing：mode=${mode}`, () => {
    const result = gate({ state: { ...STATE, mode } });
    assert.equal(result.ready, false);
    assert.ok(result.missing.some((item) => item.includes("READY")));
  });
}

test("LIMITS wrap=1 拒绝，且 safe 范围不可用", () => {
  const wrapped = LIMITS.map((limit, i) =>
    i === 0 ? { ...limit, wrap: true } : limit
  );
  const result = gate({
    limits: wrapped,
    ranges: safeModelRanges(CALS, wrapped, machine),
  });
  assert.equal(result.ready, false);
  assert.ok(result.missing.some((item) => item.includes("LIMITS")));
  assert.ok(result.missing.some((item) => item.includes("safe 范围")));
});

test("LIMITS valid=0 拒绝", () => {
  const invalid = LIMITS.map((limit, i) =>
    i === 1 ? { ...limit, valid: false } : limit
  );
  const result = gate({
    limits: invalid,
    ranges: safeModelRanges(CALS, invalid, machine),
  });
  assert.equal(result.ready, false);
  assert.ok(result.missing.some((item) => item.includes("LIMITS")));
});

test("CAL valid=0 拒绝，且 safe 范围不可用", () => {
  const invalid = CALS.map((cal, i) => (i === 0 ? { ...cal, valid: false } : cal));
  const result = gate({
    cals: invalid,
    ranges: safeModelRanges(invalid, LIMITS, machine),
  });
  assert.equal(result.ready, false);
  assert.ok(result.missing.some((item) => item.includes("CAL")));
  assert.ok(result.missing.some((item) => item.includes("safe 范围")));
});

test("实测 q 越界拒绝", () => {
  const result = gate({ state: { ...STATE, q: [50, 0, 0] } });
  assert.equal(result.ready, false);
  assert.ok(result.missing.some((item) => item.includes("safe")));
});

test("safe 范围为空拒绝", () => {
  const result = gate({ ranges: null });
  assert.equal(result.ready, false);
  assert.ok(result.missing.some((item) => item.includes("safe 范围")));
});

test("feedLines：跨帧切行不提前解析，补齐后只产出一条", () => {
  const full =
    "LIMITS id=1 min=3378 max=4095 safe=3418..4055 wrap=0 valid=1";
  const cut = 17;
  let result = feedLines("", full.slice(0, cut));
  assert.deepEqual(result.lines, []);
  assert.equal(result.rest, full.slice(0, cut));

  result = feedLines(result.rest, `${full.slice(cut)}\r\n`);
  assert.deepEqual(result.lines, [full]);
  assert.equal(result.rest, "");
});

test("feedLines：多行与 CRLF，尾行留在 rest", () => {
  const result = feedLines("", "A\r\nB\nC\r\nD");
  assert.deepEqual(result.lines, ["A", "B", "C"]);
  assert.equal(result.rest, "D");

  const crlf = feedLines("A\r", "\nB\n");
  assert.deepEqual(crlf.lines, ["A", "B"]);
  assert.equal(crlf.rest, "");
});

test("feedLines：不完整尾行不解析", () => {
  const partial = "LIMITS id=1 min=3378";
  const result = feedLines("", partial);
  assert.deepEqual(result.lines, []);
  assert.equal(result.rest, partial);
});

test("重连：清空旧 store 并重新握手", async (t) => {
  const lines = [];
  const transport = createTransport({ mock: true, machine });
  transport.onLine((line) => lines.push(line));
  t.after(() => transport.close());

  await transport.connect();
  assert.equal(lines.filter((line) => line.startsWith("HELLO ")).length, 1);
  assert.equal(lines.filter((line) => line === "OK cal").length, 1);
  assert.equal(lines.filter((line) => line === "OK limits").length, 1);
  assert.ok(transport.getState(), "首次连接应有 STATE");

  transport.close();
  lines.length = 0;

  await transport.connect();
  assert.ok(transport.getHello(), "重连后必须收到新的 HELLO");
  assert.equal(lines.filter((line) => line.startsWith("HELLO ")).length, 1);
  assert.equal(lines.filter((line) => line === "OK cal").length, 1, "重连必须重发 CAL STATUS");
  assert.equal(lines.filter((line) => line === "OK limits").length, 1, "重连必须重发 LIMITS");
  assert.ok(transport.getState(), "重连应有新的 STATE");
});

test("断线：连接后的意外关闭触发 onDisconnect", async (t) => {
  const original = globalThis.WebSocket;
  class FakeWebSocket {
    constructor() {
      this.readyState = 0;
      this.sent = "";
      FakeWebSocket.instance = this;
    }
    send(text) {
      this.sent += text;
    }
    close() {
      this.readyState = 3;
      this.onclose?.();
    }
    open() {
      this.readyState = 1;
      this.onopen?.();
    }
    message(text) {
      this.onmessage?.({ data: text });
    }
  }
  FakeWebSocket.OPEN = 1;
  globalThis.WebSocket = FakeWebSocket;
  t.after(() => {
    globalThis.WebSocket = original;
  });

  const transport = createTransport({ machine });
  let disconnected = 0;
  transport.onDisconnect(() => {
    disconnected += 1;
  });
  const connecting = transport.connect();
  FakeWebSocket.instance.open();
  FakeWebSocket.instance.message(
    "HELLO protocol=1 fw=fake cal=1 features=state,stream,motion,cal,limits\n"
  );
  await connecting;
  assert.equal(disconnected, 0);

  FakeWebSocket.instance.onclose?.();
  assert.equal(disconnected, 1, "意外断开必须通知");
  assert.equal(transport.getHello(), null, "断开后旧数据应清空");

  transport.close();
  assert.equal(disconnected, 1, "主动 close 不应再次通知");
});
