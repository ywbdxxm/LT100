import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  assertMachine,
  isSafeQ,
  loadMachine,
  safeModelRanges,
  toFwQ,
  toModelQ,
} from "../../../web/arm/machine.mjs";
import { safeQRange } from "../../../web/lt100-protocol.mjs";

const machine = JSON.parse(
  readFileSync(new URL("../../../web/arm/machine.json", import.meta.url), "utf8")
);

const TICKS_PER_DEGREE = 4096 / 360;

// 实板 2026-11-22 02:32（COM4 读回）：ID1/ID2/ID3 完整 CAL + LIMITS。
// 另一组 servo-basic.md §4.3 文档样例（3396/3851）作为第二台机器的边界测试。
function cal(overrides = {}) {
  return {
    id: 1,
    minRaw: 3378,
    maxRaw: 4095,
    margin: 40,
    zeroRaw: 3672,
    zeroQ: 0,
    sign: 1,
    valid: true,
    wrap: false,
    ...overrides,
  };
}

const calsZero = [
  cal({ id: 1 }),
  cal({ id: 2, minRaw: 61, maxRaw: 962, zeroRaw: 496 }),
  cal({ id: 3, minRaw: 599, maxRaw: 1983, zeroRaw: 1058 }),
];

const limits = [
  { id: 1, minRaw: 3378, maxRaw: 4095, safeMin: 3418, safeMax: 4055, wrap: false, valid: true },
  { id: 2, minRaw: 61, maxRaw: 962, safeMin: 101, safeMax: 922, wrap: false, valid: true },
  { id: 3, minRaw: 599, maxRaw: 1983, safeMin: 639, safeMax: 1943, wrap: false, valid: true },
];

test("machine.json 通过校验并给出参考姿态", () => {
  assertMachine(machine);
  assert.deepEqual(machine.joints.map((joint) => joint.model_ref_q), [90, 0, 0]);
  assert.equal(machine.head.mount_deg, -90);
});

test("loadMachine 读取并校验 machine.json", async () => {
  let requested;
  const fetchImpl = async (url) => {
    requested = url;
    return { ok: true, status: 200, json: async () => machine };
  };
  const loaded = await loadMachine(fetchImpl);
  assert.equal(loaded.id, "lt100");
  assert.match(String(requested), /\/machine\.json$/);
});

test("loadMachine 拒绝无效 machine", async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ...machine, joints: [] }),
  });
  await assert.rejects(() => loadMachine(fetchImpl), /joints/);
});

test("zeroQ=0：qModel1 = qFw1 + 90 且可逆", () => {
  assert.deepEqual(toModelQ([0, 0, 0], calsZero, machine), [90, 0, 0]);
  assert.deepEqual(toModelQ([10, -5, 20], calsZero, machine), [100, -5, 20]);
  assert.deepEqual(toFwQ([90, 0, 0], calsZero, machine), [0, 0, 0]);
  assert.deepEqual(toFwQ([100, -5, 20], calsZero, machine), [10, -5, 20]);
});

test("zeroQ1=90：同一物理姿态下映射为恒等", () => {
  const cals = [cal({ id: 1, zeroQ: 90 }), calsZero[1], calsZero[2]];
  assert.deepEqual(toModelQ([90, 0, 0], cals, machine), [90, 0, 0]);
  assert.deepEqual(toModelQ([100, 5, -5], cals, machine), [100, 5, -5]);
  assert.deepEqual(toFwQ([100, 5, -5], cals, machine), [100, 5, -5]);
  // 同一物理姿态：zeroQ=0 时 qFw=10 ↔ zeroQ=90 时 qFw=100，模型角都应是 100。
  assert.deepEqual(
    toModelQ([10, 0, 0], calsZero, machine),
    toModelQ([100, 0, 0], cals, machine)
  );
});

test("无效标定拒绝换算", () => {
  const bad = [{ ...calsZero[0], valid: false }, calsZero[1], calsZero[2]];
  assert.throws(() => toModelQ([0, 0, 0], bad, machine), /valid/);
  assert.throws(() => toFwQ([90, 0, 0], bad, machine), /valid/);
});

test("safeModelRanges：实板三关节端点换算并升序", () => {
  const ranges = safeModelRanges(calsZero, limits, machine);
  assert.ok(ranges, "实板 fixture 应给出范围");
  const qMin = 90 + (3418 - 3672) / TICKS_PER_DEGREE;
  const qMax = 90 + (4055 - 3672) / TICKS_PER_DEGREE;
  assert.ok(Math.abs(ranges[0].min - qMin) < 1e-9, `min=${ranges[0].min}`);
  assert.ok(Math.abs(ranges[0].max - qMax) < 1e-9, `max=${ranges[0].max}`);
  assert.ok(Math.abs(qMin - 67.676) < 0.01 && Math.abs(qMax - 123.664) < 0.01);
  assert.ok(ranges[1].min < ranges[1].max);
  assert.ok(Math.abs(ranges[1].min - (101 - 496) / TICKS_PER_DEGREE) < 1e-9);
  assert.ok(Math.abs(ranges[2].min - (639 - 1058) / TICKS_PER_DEGREE) < 1e-9);
});

test("safeModelRanges：servo-basic 文档样例（另一台机器）", () => {
  const sampleCal = cal({
    id: 1,
    minRaw: 3396,
    maxRaw: 4095,
    margin: 40,
    zeroRaw: 3851,
  });
  const sampleLimits = [
    { id: 1, minRaw: 3396, maxRaw: 4095, safeMin: 3436, safeMax: 4055, wrap: false, valid: true },
    limits[1],
    limits[2],
  ];
  const ranges = safeModelRanges([sampleCal, calsZero[1], calsZero[2]], sampleLimits, machine);
  assert.ok(ranges);
  const qMin = 90 + (3436 - 3851) / TICKS_PER_DEGREE;
  const qMax = 90 + (4055 - 3851) / TICKS_PER_DEGREE;
  assert.ok(Math.abs(ranges[0].min - qMin) < 1e-9);
  assert.ok(Math.abs(ranges[0].max - qMax) < 1e-9);
  assert.ok(Math.abs(qMin - 53.526) < 0.01 && Math.abs(qMax - 107.93) < 0.01);
});

test("safeModelRanges：sign=-1 时端点仍升序", () => {
  const cals = [
    calsZero[0],
    cal({ id: 2, minRaw: 61, maxRaw: 962, zeroRaw: 496, sign: -1 }),
    calsZero[2],
  ];
  const ranges = safeModelRanges(cals, limits, machine);
  assert.ok(ranges);
  const a = -(101 - 496) / TICKS_PER_DEGREE;
  const b = -(922 - 496) / TICKS_PER_DEGREE;
  assert.ok(Math.abs(ranges[1].min - Math.min(a, b)) < 1e-9);
  assert.ok(Math.abs(ranges[1].max - Math.max(a, b)) < 1e-9);
});

test("safeModelRanges：LIMITS safe 优先于 cal 的 margin 推算", () => {
  const wideMargin = [{ ...calsZero[0], margin: 120 }, calsZero[1], calsZero[2]];
  const ranges = safeModelRanges(wideMargin, limits, machine);
  assert.ok(ranges);
  const expectMin = 90 + (3418 - 3672) / TICKS_PER_DEGREE;
  const expectMax = 90 + (4055 - 3672) / TICKS_PER_DEGREE;
  assert.ok(Math.abs(ranges[0].min - expectMin) < 1e-9);
  assert.ok(Math.abs(ranges[0].max - expectMax) < 1e-9);

  // cal 自己的 margin 会推出 3516..3975，与 LIMITS 3436..4055 明显不同；
  // 结果必须是 LIMITS 端点，不能是 safeQRange(cal)。
  const byCal = safeQRange(wideMargin[0]);
  assert.ok(byCal);
  const calMinModel = 90 + (byCal.min - wideMargin[0].zeroQ);
  const calMaxModel = 90 + (byCal.max - wideMargin[0].zeroQ);
  assert.ok(Math.abs(ranges[0].min - calMinModel) > 5);
  assert.ok(Math.abs(ranges[0].max - calMaxModel) > 5);
});

test("safeModelRanges：wrap=1 / valid=0 拒绝", () => {
  const wrapLimits = limits.map((limit, i) => (i === 0 ? { ...limit, wrap: true } : limit));
  assert.equal(safeModelRanges(calsZero, wrapLimits, machine), null);

  const badLimit = limits.map((limit, i) => (i === 1 ? { ...limit, valid: false } : limit));
  assert.equal(safeModelRanges(calsZero, badLimit, machine), null);

  const badCal = [calsZero[0], { ...calsZero[1], valid: false }, calsZero[2]];
  assert.equal(safeModelRanges(badCal, limits, machine), null);
});

test("isSafeQ：含端点，无范围视为不安全", () => {
  const ranges = safeModelRanges(calsZero, limits, machine);
  assert.equal(
    isSafeQ([ranges[0].min, ranges[1].min, ranges[2].min], ranges),
    true
  );
  assert.equal(
    isSafeQ([ranges[0].max, ranges[1].max, ranges[2].max], ranges),
    true
  );
  assert.equal(isSafeQ([ranges[0].max + 0.1, 0, 0], ranges), false);
  assert.equal(isSafeQ([90, 0, 0], null), false);
});
