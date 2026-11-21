import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  bisectSafeTarget,
  clampJointDrag,
  fk,
  ikHead,
  wrapDeltaDeg,
} from "../../../web/arm/kinematics.mjs";
import { safeModelRanges } from "../../../web/arm/machine.mjs";

const machine = JSON.parse(
  readFileSync(new URL("../../../web/arm/machine.json", import.meta.url), "utf8")
);

// 实板 2026-11-22 02:32（COM4）的 CAL/LIMITS，用于腕限位回归。
const boardCals = [
  { id: 1, minRaw: 3378, maxRaw: 4095, margin: 40, zeroRaw: 3672, zeroQ: 0, sign: 1, valid: true, wrap: false },
  { id: 2, minRaw: 61, maxRaw: 962, margin: 40, zeroRaw: 496, zeroQ: 0, sign: 1, valid: true, wrap: false },
  { id: 3, minRaw: 599, maxRaw: 1983, margin: 40, zeroRaw: 1058, zeroQ: 0, sign: 1, valid: true, wrap: false },
];
const boardLimits = [
  { id: 1, minRaw: 3378, maxRaw: 4095, safeMin: 3418, safeMax: 4055, valid: true, wrap: false },
  { id: 2, minRaw: 61, maxRaw: 962, safeMin: 101, safeMax: 922, valid: true, wrap: false },
  { id: 3, minRaw: 599, maxRaw: 1983, safeMin: 639, safeMax: 1943, valid: true, wrap: false },
];
const boardSafe = safeModelRanges(boardCals, boardLimits, machine);

const wide = [
  { min: -170, max: 170 },
  { min: -170, max: 170 },
  { min: -170, max: 170 },
];

const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

test("FK：参考姿态 [90,0,0]", () => {
  const pose = fk(machine, [90, 0, 0]);
  assert.ok(near(pose.shoulder.x, 0) && near(pose.shoulder.y, 80));
  assert.ok(near(pose.elbow.x, 0) && near(pose.elbow.y, 260));
  assert.ok(near(pose.wrist.x, 0) && near(pose.wrist.y, 440), "腕轴应在 (0,440)");
  assert.ok(near(pose.lamp.x, 0) && near(pose.lamp.y, 530), "灯头应在 (0,530)");
  assert.ok(near(pose.psi, 0), "光束应朝 +x");
  assert.deepEqual(pose.theta, [90, 90, 90]);
});

test("FK：q2=90 时肘在前方", () => {
  const pose = fk(machine, [0, 90, 0]);
  assert.ok(near(pose.elbow.x, 180) && near(pose.elbow.y, 80));
  assert.ok(near(pose.wrist.x, 180) && near(pose.wrist.y, 260));
  assert.ok(near(pose.lamp.x, 180) && near(pose.lamp.y, 350));
  assert.ok(near(pose.psi, 0));
});

test("FK→IK 往返：safe 网格同支误差 < 0.1°", () => {
  const samples = [];
  for (const q1 of [-120, -60, 0, 60, 120]) {
    for (const q2 of [-120, -60, 60, 120]) {
      for (const q3 of [-120, 0, 120]) samples.push([q1, q2, q3]);
    }
  }
  for (const q of samples) {
    const pose = fk(machine, q);
    const res = ikHead(machine, pose.lamp, pose.psi, q, wide);
    assert.equal(res.ok, true, `应可解：${q}`);
    assert.equal(res.q3Clamped, false, `不应夹 q3：${q}`);
    for (let i = 0; i < 3; i++) {
      assert.ok(
        near(res.qModel[i], q[i], 0.1),
        `joint${i + 1}: ${res.qModel[i]} vs ${q[i]}（${q}）`
      );
    }
    assert.ok(dist(res.lamp, pose.lamp) < 1e-6);
  }
});

test("IK 双解：选离当前 q2 更近的一支", () => {
  const pose = fk(machine, [0, 60, 0]);
  const up = ikHead(machine, pose.lamp, pose.psi, [0, 60, 0], wide);
  const down = ikHead(machine, pose.lamp, pose.psi, [0, -60, 0], wide);
  assert.equal(up.ok, true);
  assert.equal(down.ok, true);
  assert.ok(near(up.qModel[1], 60, 0.1), `正向支 q2=${up.qModel[1]}`);
  assert.ok(near(down.qModel[1], -60, 0.1), `反向支 q2=${down.qModel[1]}`);
  assert.ok(dist(up.lamp, pose.lamp) < 1e-6);
  assert.ok(dist(down.lamp, pose.lamp) < 1e-6);
});

test("IK 不可达：r > l1+l2 返回 unreachable 且无 qModel", () => {
  const res = ikHead(machine, { x: 1000, y: 100 }, 0, [0, 0, 0], wide);
  assert.equal(res.ok, false);
  assert.equal(res.reason, "unreachable");
  assert.equal(res.qModel, undefined);
});

test("IK 腕限位：q3 夹紧、保持灯头位置、结果仍 safe", () => {
  const ranges = [
    { min: -170, max: 170 },
    { min: -170, max: 170 },
    { min: -5, max: 5 },
  ];
  const pose = fk(machine, [0, 60, 0]); // q3=0，psi=-30
  // psiLock=-90 → θ3=0，两支的 q3 都超出 [-5,5]，必须走夹紧回退。
  const res = ikHead(machine, pose.lamp, -90, [0, 60, 0], ranges);
  assert.equal(res.ok, true, `应可解：${res.reason}`);
  assert.equal(res.q3Clamped, true);
  assert.equal(res.reason, "q3-clamped");
  assert.ok(near(res.qModel[2], -5, 1e-6), `q3=${res.qModel[2]}`);
  assert.ok(dist(res.lamp, pose.lamp) < 0.5, `灯头偏移 ${dist(res.lamp, pose.lamp)} mm`);
  assert.ok(Math.abs(res.psi - -90) > 10, "光束应偏离锁定方向");
  for (let i = 0; i < 3; i++) {
    assert.ok(res.qModel[i] >= ranges[i].min - 1e-6);
    assert.ok(res.qModel[i] <= ranges[i].max + 1e-6);
  }
});

test("边界回退：从安全点到不可达点返回最后一个 safe 点", () => {
  const pose = fk(machine, [0, 60, 0]);
  const far = { x: 1000, y: 400 };
  const direct = ikHead(machine, far, pose.psi, [0, 60, 0], wide);
  assert.equal(direct.ok, false);

  const res = bisectSafeTarget(machine, pose.lamp, far, pose.psi, [0, 60, 0], wide);
  assert.equal(res.ok, true);
  assert.ok(res.qModel, "应返回 qModel");
  assert.ok(res.lamp, "应返回 lamp");
  for (let i = 0; i < 3; i++) {
    assert.ok(res.qModel[i] >= -170 && res.qModel[i] <= 170);
  }
  assert.ok(dist(res.lamp, far) > dist(res.lamp, pose.lamp), "应停在边界，不是起点");
});

test("腕限位回归 P0：q3 夹紧后灯头必须在 0.25 mm 内到达目标", () => {
  assert.ok(boardSafe);
  const pose = fk(machine, [90, 0, 80]);
  const res = ikHead(machine, pose.lamp, 80, [90, 0, 0], boardSafe);
  assert.equal(res.ok, true);
  assert.equal(res.q3Clamped, true);
  assert.ok(near(res.qModel[2], boardSafe[2].max, 1e-6), `q3=${res.qModel[2]}`);
  assert.ok(dist(fk(machine, res.qModel).lamp, pose.lamp) <= 0.25);
  for (let i = 0; i < 3; i++) {
    assert.ok(res.qModel[i] >= boardSafe[i].min - 1e-6);
    assert.ok(res.qModel[i] <= boardSafe[i].max + 1e-6);
  }
});

test("腕限位回归 P1：初始 2R 不可达时仍尝试 q3 夹紧", () => {
  const target = { x: -160, y: 418 };
  const res = ikHead(machine, target, 100, [90, 0, 0], boardSafe);
  assert.equal(res.ok, true, `reason=${res.reason}`);
  assert.equal(res.q3Clamped, true);
  assert.ok(near(res.qModel[2], boardSafe[2].max, 1e-6), `q3=${res.qModel[2]}`);
  assert.ok(dist(fk(machine, res.qModel).lamp, target) <= 0.25);
});

test("性质：ok 解都 safe，q3Clamped 解都在 0.25 mm 内", () => {
  let seed = 123456789;
  const rnd = () => {
    seed = (1664525 * seed + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  const pick = (range) => range.min + rnd() * (range.max - range.min);
  let clamped = 0;
  for (let n = 0; n < 200; n++) {
    const q = [pick(boardSafe[0]), pick(boardSafe[1]), pick(boardSafe[2])];
    const pose = fk(machine, q);
    const target = {
      x: pose.lamp.x + (rnd() - 0.5) * 60,
      y: pose.lamp.y + (rnd() - 0.5) * 60,
    };
    const psiLock = pose.psi + (rnd() - 0.5) * 60;
    const current = [q[0] + (rnd() - 0.5) * 20, q[1] + (rnd() - 0.5) * 20, q[2]];
    const res = ikHead(machine, target, psiLock, current, boardSafe);
    if (!res.ok) continue;
    for (let i = 0; i < 3; i++) {
      assert.ok(
        res.qModel[i] >= boardSafe[i].min - 1e-6 &&
          res.qModel[i] <= boardSafe[i].max + 1e-6,
        `sample ${n} joint${i + 1} 越界：${res.qModel[i]}`
      );
    }
    if (res.q3Clamped) {
      clamped++;
      const err = dist(fk(machine, res.qModel).lamp, target);
      assert.ok(err <= 0.25, `sample ${n} 夹紧解灯头偏差 ${err} mm`);
    }
  }
  assert.ok(clamped > 0, "随机样本应至少触发一次 q3 夹紧");
});

test("关节差角跨 ±180° 取最短", () => {
  assert.ok(near(wrapDeltaDeg(179, -179), 2));
  assert.ok(near(wrapDeltaDeg(-179, 179), -2));
  assert.ok(near(wrapDeltaDeg(350, 10), 20));
  assert.ok(near(wrapDeltaDeg(10, 350), -20));
  assert.ok(near(wrapDeltaDeg(10, 40), 30));
});

test("clampJointDrag：夹到 safe 且不改其它关节", () => {
  const ranges = [
    { min: -30, max: 30 },
    { min: -170, max: 170 },
    { min: -5, max: 5 },
  ];

  const hit = clampJointDrag(machine, [0, 10, 0], 0, 100, ranges);
  assert.equal(hit.clamped, true);
  assert.deepEqual(hit.qModel, [30, 10, 0]);

  const free = clampJointDrag(machine, [0, 10, 0], 1, 20, ranges);
  assert.equal(free.clamped, false);
  assert.deepEqual(free.qModel, [0, 30, 0]);

  const low = clampJointDrag(machine, [0, 0, 0], 2, -20, ranges);
  assert.equal(low.clamped, true);
  assert.deepEqual(low.qModel, [0, 0, -5]);
});
