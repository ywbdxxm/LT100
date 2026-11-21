// LT100 machine config: qFw <-> qModel mapping and safe ranges. No DOM.
// qFw comes from STATE.q / CAL STATUS; qModel is the arm-plane angle with
// qModel1 = 90 pointing straight up. Never send qModel as POSE.

import { rawToQ } from "../lt100-protocol.mjs";

function fail(message) {
  throw new Error(`machine.mjs: ${message}`);
}

function isAngleList(value) {
  return Array.isArray(value) && value.length === 3 && value.every(Number.isFinite);
}

function requireCals(cals) {
  if (!Array.isArray(cals) || cals.length !== 3 || cals.some((cal) => !cal || !cal.valid)) {
    fail("CAL STATUS 无效：三关节都需要 valid=1");
  }
}

export async function loadMachine(fetchImpl = globalThis.fetch) {
  const url = new URL("./machine.json", import.meta.url);
  const response = await fetchImpl(url);
  if (!response.ok) fail(`加载 machine.json 失败：HTTP ${response.status}`);
  const machine = await response.json();
  assertMachine(machine);
  return machine;
}

export function assertMachine(machine) {
  if (!machine || typeof machine !== "object") fail("machine 必须是对象");
  if (machine.schema !== 1) fail("schema 必须为 1");
  for (const key of ["l1", "l2", "l3"]) {
    if (!Number.isFinite(machine.links?.[key]) || machine.links[key] <= 0) {
      fail(`links.${key} 必须为正数`);
    }
  }
  if (!Number.isFinite(machine.base?.shoulder_height)) fail("base.shoulder_height 必须有限");
  if (!Number.isFinite(machine.head?.mount_deg)) fail("head.mount_deg 必须有限");
  if (!Array.isArray(machine.joints) || machine.joints.length !== 3) {
    fail("joints 必须为 3 个");
  }
  machine.joints.forEach((joint, index) => {
    if (!Number.isFinite(joint?.model_ref_q)) fail(`joints[${index}].model_ref_q 必须有限`);
  });
}

export function toModelQ(qFw, cals, machine) {
  if (!isAngleList(qFw)) fail("qFw 必须是三个有限角");
  requireCals(cals);
  return qFw.map((q, i) => machine.joints[i].model_ref_q + (q - cals[i].zeroQ));
}

export function toFwQ(qModel, cals, machine) {
  if (!isAngleList(qModel)) fail("qModel 必须是三个有限角");
  requireCals(cals);
  return qModel.map((q, i) => cals[i].zeroQ + (q - machine.joints[i].model_ref_q));
}

// Safe endpoints come from LIMITS (already margin-inset on the board); cal.margin
// is not applied again. Any invalid cal/limit, wrap, or unreadable raw -> null.
export function safeModelRanges(cals, limits, machine) {
  if (!Array.isArray(cals) || cals.length !== 3 || cals.some((cal) => !cal || !cal.valid)) {
    return null;
  }
  if (!Array.isArray(limits) || limits.length !== 3) return null;
  const ranges = [];
  for (let i = 0; i < 3; i++) {
    const limit = limits[i];
    if (!limit || !limit.valid || limit.wrap) return null;
    if (!Number.isFinite(limit.safeMin) || !Number.isFinite(limit.safeMax)) return null;
    const qa = rawToQ(cals[i], limit.safeMin);
    const qb = rawToQ(cals[i], limit.safeMax);
    if (qa === null || qb === null) return null;
    const a = machine.joints[i].model_ref_q + (qa - cals[i].zeroQ);
    const b = machine.joints[i].model_ref_q + (qb - cals[i].zeroQ);
    ranges.push({ min: Math.min(a, b), max: Math.max(a, b) });
  }
  return ranges;
}

export function isSafeQ(qModel, ranges, epsilon = 1e-9) {
  if (!Array.isArray(qModel) || qModel.length !== 3) return false;
  if (!Array.isArray(ranges) || ranges.length !== 3) return false;
  return qModel.every(
    (q, i) =>
      Number.isFinite(q) &&
      q >= ranges[i].min - epsilon &&
      q <= ranges[i].max + epsilon
  );
}
