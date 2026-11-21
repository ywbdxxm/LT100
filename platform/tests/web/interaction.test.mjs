import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  blockingGateItems,
  createAlignment,
  createPoseStream,
  insetModelRanges,
  isNewError,
  limitPoseStep,
} from "../../../web/arm/interaction.mjs";
import { safeModelRanges, toFwQ } from "../../../web/arm/machine.mjs";
import { MOCK_CALS, MOCK_LIMITS } from "../../../web/arm/mock.mjs";
import { formatQ, qToRaw } from "../../../web/lt100-protocol.mjs";

const machine = JSON.parse(
  readFileSync(new URL("../../../web/arm/machine.json", import.meta.url), "utf8")
);
const RANGES = safeModelRanges(MOCK_CALS, MOCK_LIMITS, machine);

const clock = () => {
  let timer = null;
  let interval = null;
  let nextId = 0;
  return {
    setInterval(callback, ms) {
      timer = callback;
      interval = ms;
      return ++nextId;
    },
    clearInterval() {
      timer = null;
    },
    fire(times) {
      for (let i = 0; i < times; i += 1) timer?.();
    },
    period: () => interval,
  };
};

test("blockingGateItems：拖动中允许自家 MOTION，其余缺项照停", () => {
  assert.deepEqual(blockingGateItems(["mode=MOTION，不是 READY"]), []);
  assert.deepEqual(blockingGateItems(["mode=FAULT，不是 READY"]), [
    "mode=FAULT，不是 READY",
  ]);
  assert.deepEqual(
    blockingGateItems(["mode=MOTION，不是 READY", "torque≠7：力矩未开启"]),
    ["torque≠7：力矩未开启"]
  );
  assert.deepEqual(blockingGateItems(), []);
  const stale = "STATE 超过 300 ms 未更新";
  assert.deepEqual(blockingGateItems([stale], 50), [stale]);
  assert.deepEqual(blockingGateItems([stale], 400), []);
});

const timeoutClock = () => {
  let timer = null;
  let delay = null;
  return {
    setTimeout(callback, ms) {
      timer = callback;
      delay = ms;
      return 1;
    },
    clearTimeout() {
      timer = null;
    },
    fire() {
      timer?.();
    },
    delay: () => delay,
  };
};

test("isNewError：拖动前旧 ERR 不拦，拖动中新 ERR 才停", () => {
  const old = { code: 17, msg: "LinkLost" };
  assert.equal(isNewError(old, old), false);
  assert.equal(isNewError({ code: 17, msg: "LinkLost" }, old), true);
  assert.equal(isNewError(null, old), false);
  assert.equal(isNewError(null, null), false);
  assert.equal(isNewError(old, null), true);
});

test("createAlignment：350 ms 后对齐，重按（cancel）取消", () => {
  const fake = timeoutClock();
  const fired = [];
  const align = createAlignment({ onAlign: (q) => fired.push(q), clock: fake });
  align.schedule(() => [90, 0, 0]);
  assert.equal(fake.delay(), 350);
  fake.fire();
  assert.deepEqual(fired, [[90, 0, 0]]);

  align.schedule(() => [80, 10, -5]);
  align.cancel();
  fake.fire();
  assert.deepEqual(fired, [[90, 0, 0]], "取消后不得对齐");

  align.schedule(() => [70, 20, -10]);
  fake.fire();
  assert.deepEqual(fired.at(-1), [70, 20, -10]);
});

test("insetModelRanges：2 tick 内缩后 formatQ/qToRaw 仍在真实 safe 内", () => {
  const inset = insetModelRanges(RANGES);
  const step = 2 * (360 / 4096);
  assert.equal(inset.length, 3);
  const base = machine.joints.map((joint) => joint.model_ref_q);
  for (let i = 0; i < 3; i += 1) {
    assert.ok(Math.abs(inset[i].min - (RANGES[i].min + step)) < 1e-12);
    assert.ok(Math.abs(inset[i].max - (RANGES[i].max - step)) < 1e-12);
    for (const q of [inset[i].min, inset[i].max]) {
      const qFw = toFwQ(base.map((v, j) => (j === i ? q : v)), MOCK_CALS, machine)[i];
      const raw = qToRaw(MOCK_CALS[i], Number(formatQ(qFw)));
      assert.ok(
        raw >= MOCK_LIMITS[i].safeMin && raw <= MOCK_LIMITS[i].safeMax,
        `j${i + 1} q=${q} -> raw=${raw} 超出 ${MOCK_LIMITS[i].safeMin}..${MOCK_LIMITS[i].safeMax}`
      );
    }
  }
});

test("insetModelRanges：不修改输入，ticks=0 原样返回", () => {
  const before = structuredClone(RANGES);
  assert.deepEqual(insetModelRanges(RANGES, 0), before);
  assert.deepEqual(RANGES, before);
});

test("limitPoseStep：179→-179 走 +2°，逐关节 25° 截断", () => {
  const step = limitPoseStep([179, 0, 0], [-179, 60, -60]);
  assert.ok(Math.abs(step[0] - 181) < 1e-9);
  assert.equal(step[1], 25);
  assert.equal(step[2], -25);
  const back = limitPoseStep([0, 0, 0], [10, -10, 0], 5);
  assert.deepEqual(back, [5, -5, 0]);
});

test("createPoseStream：20 Hz、stopNow 先停表后只发一次 STOP、之后零 POSE", () => {
  const fake = clock();
  const poses = [];
  const stops = [];
  const stream = createPoseStream({
    sendPose: (seq, q) => poses.push({ seq, q }),
    stop: () => stops.push(1),
    clock: fake,
  });
  stream.start(() => [90, 0, 0]);
  assert.equal(fake.period(), 50);
  fake.fire(20);
  assert.equal(poses.length, 20);
  assert.equal(poses[0].seq, 0);
  assert.equal(poses[19].seq, 19);

  stream.stopNow();
  assert.equal(stops.length, 1);
  fake.fire(10);
  assert.equal(poses.length, 20, "STOP 后不得再发 POSE");
  stream.stopNow();
  assert.equal(stops.length, 1, "重复 stopNow 不得重复 STOP");
});

test("createPoseStream：未 start 时 stopNow 不发 STOP", () => {
  const stops = [];
  const stream = createPoseStream({
    sendPose: () => {},
    stop: () => stops.push(1),
    clock: clock(),
  });
  stream.stopNow();
  assert.equal(stops.length, 0);
});

test("createPoseStream：停止后可重新开始，seq 继续递增", () => {
  const fake = clock();
  const poses = [];
  const stream = createPoseStream({
    sendPose: (seq) => poses.push(seq),
    stop: () => {},
    clock: fake,
  });
  stream.start(() => [0, 0, 0]);
  fake.fire(2);
  stream.stopNow();
  stream.start(() => [0, 0, 0]);
  fake.fire(2);
  assert.deepEqual(poses, [0, 1, 2, 3]);
});
