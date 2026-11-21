// LT100 3R planar arm kinematics. Pure functions, angles in degrees.
// qModel1 = 90 is straight up; theta2/theta3 are cumulative (q1+q2, q1+q2+q3).

const DEG = Math.PI / 180;
const EPS = 1e-9;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function unit(deg) {
  const rad = deg * DEG;
  return { x: Math.cos(rad), y: Math.sin(rad) };
}

// Shortest signed difference in degrees, in [-180, 180).
export function wrapDeltaDeg(fromDeg, toDeg) {
  return ((((toDeg - fromDeg) % 360) + 540) % 360) - 180;
}

export function fk(machine, qModel) {
  const { l1, l2, l3 } = machine.links;
  const h = machine.base.shoulder_height;
  const theta = [
    qModel[0],
    qModel[0] + qModel[1],
    qModel[0] + qModel[1] + qModel[2],
  ];
  const shoulder = { x: 0, y: h };
  const u1 = unit(theta[0]);
  const elbow = { x: shoulder.x + l1 * u1.x, y: shoulder.y + l1 * u1.y };
  const u2 = unit(theta[1]);
  const wrist = { x: elbow.x + l2 * u2.x, y: elbow.y + l2 * u2.y };
  const u3 = unit(theta[2]);
  const lamp = { x: wrist.x + l3 * u3.x, y: wrist.y + l3 * u3.y };
  return { shoulder, elbow, wrist, lamp, theta, psi: theta[2] + machine.head.mount_deg };
}

// Both 2R solutions in shoulder-local coordinates, or null if out of reach.
function solve2R(machine, wx, wy) {
  const { l1, l2 } = machine.links;
  const c2 = (wx * wx + wy * wy - l1 * l1 - l2 * l2) / (2 * l1 * l2);
  if (!(c2 >= -1 - EPS && c2 <= 1 + EPS)) return null;
  const a = Math.acos(clamp(c2, -1, 1)) / DEG;
  const phi = Math.atan2(wy, wx) / DEG;
  const off = Math.atan2(l2 * Math.sin(a * DEG), l1 + l2 * Math.cos(a * DEG)) / DEG;
  return [
    { q1: phi - off, q2: a },
    { q1: phi + off, q2: -a },
  ];
}

function inRanges(qModel, safeRanges) {
  return qModel.every(
    (q, i) =>
      Number.isFinite(q) &&
      q >= safeRanges[i].min - EPS &&
      q <= safeRanges[i].max + EPS
  );
}

function success(machine, qModel, reason, q3Clamped) {
  const pose = fk(machine, qModel);
  return { ok: true, qModel, lamp: pose.lamp, psi: pose.psi, q3Clamped, reason };
}

// Wrist-limit fallback, q3 = c fixed. With s = q1+q2, FK gives
//   |P - S - l2*u(s) - l3*u(s+c)| = l1
// so the equation only involves s: no 2R branch choice, no fake roots.
// Every candidate is re-checked through fk() before being returned.
const TARGET_TOL_MM = 0.25;

function probeElbow(machine, target, q3, s) {
  const { l1, l2, l3 } = machine.links;
  const h = machine.base.shoulder_height;
  const us = unit(s);
  const uc = unit(s + q3);
  const ex = target.x - l2 * us.x - l3 * uc.x;
  const ey = target.y - h - l2 * us.y - l3 * uc.y;
  const d = Math.hypot(ex, ey);
  const q1 = Math.atan2(ey, ex) / DEG;
  return { s, value: d - l1, qModel: d < 1e-9 ? null : [q1, s - q1, q3] };
}

function bisectProbe(probe, lo, hi) {
  let a = probe(lo);
  let b = probe(hi);
  if (!Number.isFinite(a.value) || !Number.isFinite(b.value)) return null;
  if (Math.sign(a.value) === Math.sign(b.value)) return null;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    const m = probe(mid);
    if (m.value === 0) return mid;
    if (Math.sign(m.value) === Math.sign(a.value)) {
      lo = mid;
      a = m;
    } else {
      hi = mid;
      b = m;
    }
  }
  return (lo + hi) / 2;
}

// Tangency (full extension) touches zero without a sign change.
function refineProbeMin(probe, lo, hi) {
  const golden = (Math.sqrt(5) - 1) / 2;
  let a = lo;
  let b = hi;
  let c = b - golden * (b - a);
  let d = a + golden * (b - a);
  let fc = Math.abs(probe(c).value);
  let fd = Math.abs(probe(d).value);
  for (let i = 0; i < 40; i++) {
    if (fc <= fd) {
      b = d;
      d = c;
      fd = fc;
      c = b - golden * (b - a);
      fc = Math.abs(probe(c).value);
    } else {
      a = c;
      c = d;
      fc = fd;
      d = a + golden * (b - a);
      fd = Math.abs(probe(d).value);
    }
  }
  return (a + b) / 2;
}

function dedupeAngles(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const out = [];
  for (const value of sorted) {
    if (!out.length || Math.abs(value - out[out.length - 1]) > 0.01) out.push(value);
  }
  return out;
}

function solveQ3Fixed(machine, target, q3, currentQ2, safeRanges) {
  const step = 0.5;
  const probe = (s) => probeElbow(machine, target, q3, s);

  const samples = [];
  for (let s = -180; s <= 180 + 1e-9; s += step) samples.push(probe(s));

  const roots = [];
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1];
    const b = samples[i];
    if (a.value === 0) roots.push(a.s);
    if (Math.sign(a.value) !== Math.sign(b.value)) {
      const root = bisectProbe(probe, a.s, b.s);
      if (root !== null) roots.push(root);
    }
  }

  for (let i = 1; i < samples.length - 1; i++) {
    const prev = Math.abs(samples[i - 1].value);
    const cur = Math.abs(samples[i].value);
    const next = Math.abs(samples[i + 1].value);
    if (cur <= prev && cur <= next && cur < 5) {
      roots.push(refineProbeMin(probe, samples[i - 1].s, samples[i + 1].s));
    }
  }

  let best = null;
  for (const s of dedupeAngles(roots)) {
    const qModel = probe(s).qModel;
    if (!qModel || !inRanges(qModel, safeRanges)) continue;
    const pose = fk(machine, qModel);
    const err = Math.hypot(pose.lamp.x - target.x, pose.lamp.y - target.y);
    if (err > TARGET_TOL_MM) continue;
    const score = Math.abs(wrapDeltaDeg(currentQ2, qModel[1]));
    if (!best || score < best.score) best = { qModel, score };
  }
  return best ? best.qModel : null;
}

export function ikHead(machine, lampTarget, psiLock, currentQModel, safeRanges) {
  if (!Array.isArray(safeRanges) || safeRanges.length !== 3) {
    throw new Error("ikHead 需要三关节 safeRanges");
  }
  if (
    !lampTarget ||
    !Number.isFinite(lampTarget.x) ||
    !Number.isFinite(lampTarget.y) ||
    !Number.isFinite(psiLock)
  ) {
    return { ok: false, q3Clamped: false, reason: "unreachable" };
  }

  const { l3 } = machine.links;
  const h = machine.base.shoulder_height;
  const theta3 = psiLock - machine.head.mount_deg;
  const t3 = unit(theta3);
  const wx = lampTarget.x - l3 * t3.x;
  const wy = lampTarget.y - h - l3 * t3.y;
  const solutions = solve2R(machine, wx, wy);
  const currentQ2 = Number.isFinite(currentQModel?.[1]) ? currentQModel[1] : 0;

  let candidates = [];
  if (solutions) {
    candidates = solutions
      .map((sol) => [sol.q1, sol.q2, theta3 - (sol.q1 + sol.q2)])
      .sort(
        (a, b) =>
          Math.abs(wrapDeltaDeg(currentQ2, a[1])) - Math.abs(wrapDeltaDeg(currentQ2, b[1]))
      );
    for (let i = 0; i < candidates.length; i++) {
      if (inRanges(candidates[i], safeRanges)) {
        return success(machine, candidates[i], i === 0 ? "safe" : "branch", false);
      }
    }
  }

  const range = safeRanges[2];
  let q3Targets = [];
  if (solutions) {
    const desired = candidates[0][2];
    if (desired < range.min - EPS || desired > range.max + EPS) {
      q3Targets = [clamp(desired, range.min, range.max)];
    }
  } else {
    // P1: no 2R solution, q3 is unknown -> try both safe ends.
    q3Targets = [range.min, range.max];
  }

  let best = null;
  for (const q3 of q3Targets) {
    const qModel = solveQ3Fixed(machine, lampTarget, q3, currentQ2, safeRanges);
    if (!qModel) continue;
    const score = Math.abs(wrapDeltaDeg(currentQ2, qModel[1]));
    if (!best || score < best.score) best = { qModel, score };
  }
  if (best) return success(machine, best.qModel, "q3-clamped", true);
  return { ok: false, q3Clamped: false, reason: "unreachable" };
}

export function clampJointDrag(machine, qStart, jointIndex, deltaDeg, safeRanges) {
  const range = safeRanges?.[jointIndex];
  if (!range) throw new Error("clampJointDrag 需要该关节的 safe 范围");
  const target = qStart[jointIndex] + deltaDeg;
  const value = clamp(target, range.min, range.max);
  const qModel = [...qStart];
  qModel[jointIndex] = value;
  return { qModel, clamped: value !== target };
}

// Last safe lamp point on the segment fromLamp -> toLamp (16 bisections).
export function bisectSafeTarget(machine, fromLamp, toLamp, psiLock, currentQModel, safeRanges) {
  let best = ikHead(machine, fromLamp, psiLock, currentQModel, safeRanges);
  if (!best.ok) return { ok: false };
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 16; i++) {
    const mid = (lo + hi) / 2;
    const lamp = {
      x: fromLamp.x + (toLamp.x - fromLamp.x) * mid,
      y: fromLamp.y + (toLamp.y - fromLamp.y) * mid,
    };
    const res = ikHead(machine, lamp, psiLock, best.qModel, safeRanges);
    if (res.ok) {
      best = res;
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return { ok: true, lamp: best.lamp, qModel: best.qModel };
}
