// LT100 A1 interaction: lamp-head drag -> IK -> 20 Hz POSE / STOP.
// Pure helpers are exported for node --test; the DOM part is created lazily
// and never touched at module load.
import {
  bisectSafeTarget,
  clampJointDrag,
  fk,
  ikHead,
  wrapDeltaDeg,
} from "./kinematics.mjs";
import { isSafeQ, toFwQ } from "./machine.mjs";

const DEG_PER_TICK = 360 / 4096;

export function insetModelRanges(ranges, ticks = 2) {
  const inset = ticks * DEG_PER_TICK;
  return ranges.map(({ min, max }) => ({ min: min + inset, max: max - inset }));
}

// Shortest angular step, capped per joint. 179 -> -179 is +2 degrees.
export function limitPoseStep(fromQ, toQ, maxDeg = 25) {
  return toQ.map((target, i) => {
    const delta = wrapDeltaDeg(fromQ[i], target);
    return fromQ[i] + Math.max(-maxDeg, Math.min(maxDeg, delta));
  });
}

// During a drag, mode=MOTION is caused by our own POSE. A stalled main thread
// (unreachable IK scan) can also age STATE; the next refresh catches a real
// frozen bridge. Every other gate item stops the drag immediately.
export function blockingGateItems(missing = [], localGapMs = 0) {
  return missing.filter((item) => {
    const text = String(item);
    if (text.startsWith("mode=MOTION")) return false;
    if (localGapMs > 300 && text.startsWith("STATE 超过")) return false;
    return true;
  });
}

// transport keeps the last ERR for the whole connection; only an ERR that
// arrives after pointerdown may stop the new drag.
export function isNewError(error, baseline) {
  return Boolean(error && error !== baseline);
}

// Ring drag: only the grabbed joint changes, clamped to the inset safe range.
export function jointDragQ(machine, qStart, jointIndex, deltaDeg, safeRanges) {
  if (!Number.isInteger(jointIndex) || jointIndex < 0 || jointIndex > 2) {
    throw new Error("jointDragQ 需要 0..2 的 jointIndex");
  }
  const delta = wrapDeltaDeg(0, deltaDeg);
  const { qModel, clamped } = clampJointDrag(
    machine,
    qStart,
    jointIndex,
    delta,
    safeRanges
  );
  return { qModel, clamped };
}

// One-shot 350 ms alignment; a new drag cancels it via cancel().
export function createAlignment({ onAlign, delay = 350, clock = globalThis }) {
  let timer = null;
  const cancel = () => {
    if (timer !== null) {
      clock.clearTimeout(timer);
      timer = null;
    }
  };
  return {
    schedule(getQ) {
      cancel();
      timer = clock.setTimeout(() => {
        timer = null;
        const q = getQ();
        if (q) onAlign?.(q);
      }, delay);
    },
    cancel,
    isPending: () => timer !== null,
  };
}

export function createPoseStream({ sendPose, stop, hz = 20, clock = globalThis }) {  let timer = null;
  let getQ = null;
  let seq = 0;
  let active = false;
  let stopSent = false;

  const tick = () => {
    if (!active || !getQ) return;
    const q = getQ();
    if (!q) return;
    sendPose(seq, q);
    seq += 1;
  };

  return {
    start(next) {
      getQ = next;
      active = true;
      stopSent = false;
      if (timer === null) timer = clock.setInterval(tick, 1000 / hz);
    },
    stopNow() {
      const wasActive = active;
      active = false;
      getQ = null;
      if (timer !== null) {
        clock.clearInterval(timer);
        timer = null;
      }
      if (wasActive && !stopSent) {
        stopSent = true;
        stop();
      }
    },
    isRunning: () => active,
    get seq() {
      return seq;
    },
  };
}

function matrixMulVec(m, v) {
  const [x, y, z, w] = v;
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12] * w,
    m[1] * x + m[5] * y + m[9] * z + m[13] * w,
    m[2] * x + m[6] * y + m[10] * z + m[14] * w,
    m[3] * x + m[7] * y + m[11] * z + m[15] * w,
  ];
}

function pointerRay(camera, canvas, event) {
  const rect = canvas.getBoundingClientRect();
  const ndcX = ((event.clientX - rect.left) / (rect.width || 1)) * 2 - 1;
  const ndcY = -((event.clientY - rect.top) / (rect.height || 1)) * 2 + 1;
  camera.updateMatrixWorld();
  const p = matrixMulVec(camera.projectionMatrixInverse.elements, [ndcX, ndcY, 0.5, 1]);
  const invW = p[3] || 1;
  const cam = [p[0] / invW, p[1] / invW, p[2] / invW, 1];
  const world = matrixMulVec(camera.matrixWorld.elements, cam);
  const origin = [
    camera.matrixWorld.elements[12],
    camera.matrixWorld.elements[13],
    camera.matrixWorld.elements[14],
  ];
  const dir = [world[0] - origin[0], world[1] - origin[1], world[2] - origin[2]];
  const length = Math.hypot(dir[0], dir[1], dir[2]) || 1;
  return {
    origin,
    dir: [dir[0] / length, dir[1] / length, dir[2] / length],
  };
}

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

function planeHit(ray, normal) {
  const denom = dot(ray.dir, normal);
  if (Math.abs(denom) < 0.2) return null;
  const t = -dot(ray.origin, normal) / denom;
  if (!(t > 0)) return null;
  return {
    x: ray.origin[0] + t * ray.dir[0],
    y: ray.origin[1] + t * ray.dir[1],
    z: ray.origin[2] + t * ray.dir[2],
  };
}

function hitsSphere(ray, sphere) {
  const oc = [
    ray.origin[0] - sphere.center.x,
    ray.origin[1] - sphere.center.y,
    ray.origin[2] - sphere.center.z,
  ];
  const b = dot(oc, ray.dir);
  const c = dot(oc, oc) - sphere.radius * sphere.radius;
  const disc = b * b - c;
  if (disc < 0) return false;
  const root = Math.sqrt(disc);
  return -b - root > 0 || -b + root > 0;
}

export function createInteraction({
  canvas,
  camera,
  controls,
  rig,
  machine,
  transport,
  safeRanges,
  onTarget,
  onStop,
  onAlign,
  onStatus,
  onPose,
  onStopSent,
}) {
  let ranges = safeRanges ?? null;
  let inset = ranges ? insetModelRanges(ranges) : null;
  let latest = { gate: null, actual: null, state: null, error: null };
  let dragging = false;
  let mode = null;
  let jointIndex = null;
  let qStart = null;
  let aStart = 0;
  let pointerId = null;
  let psiLock = 0;
  let sentQ = null;
  let lastValidLamp = null;
  let lastSeq = null;
  let staleSeqFrames = 0;
  let lastUpdateAt = 0;
  let dragStartSeq = 0;
  let dragError = null;

  const yaw = ((machine.base?.yaw_deg ?? 0) * Math.PI) / 180;
  const cosYaw = Math.cos(yaw);
  const sinYaw = Math.sin(yaw);
  const planeNormal = [sinYaw, 0, cosYaw];
  const toArm = (point) => ({
    x: cosYaw * point.x - sinYaw * point.z,
    y: point.y,
  });
  const angleDeg = (point, center) =>
    (Math.atan2(point.y - center.y, point.x - center.x) * 180) / Math.PI;
  const planeCenter = (world) => {
    camera.updateMatrixWorld();
    const m = camera.matrixWorld.elements;
    const cam = [m[12], m[13], m[14]];
    const d = [world.x - cam[0], world.y - cam[1], world.z - cam[2]];
    if (Math.abs(d[2]) < 1e-6) return toArm(world);
    const t = -cam[2] / d[2];
    return toArm({
      x: cam[0] + t * d[0],
      y: cam[1] + t * d[1],
      z: 0,
    });
  };
  const pickRing = (point) => {
    let best = null;
    for (const ring of rig.getJointRings()) {
      // Hit distance uses the ring center as the user sees it (projected along
      // the view to Z=0); the pivot center still drives the drag angle.
      const hitCenter = planeCenter(ring.center);
      const distance = Math.hypot(point.x - hitCenter.x, point.y - hitCenter.y);
      if (
        distance >= 10 &&
        distance <= ring.radius + 10 &&
        (!best || distance < best.distance)
      ) {
        best = {
          index: ring.index,
          center: toArm(ring.center),
          distance,
        };
      }
    }
    return best;
  };

  const stream = createPoseStream({
    sendPose: (seq, q) => {
      let qFw;
      try {
        qFw = toFwQ(q, transport.getCals(), machine);
      } catch (error) {
        stopDrag(`标定不可用：${error.message}`);
        return;
      }
      transport.sendPose(seq, qFw, 25, 20);
      onPose?.(seq, q);
    },
    stop: () => {
      transport.stop();
      onStopSent?.();
    },
  });

  const align = createAlignment({
    onAlign: (q) => {
      if (!dragging) onAlign?.(q);
    },
  });

  const clearAlign = () => align.cancel();

  const scheduleAlign = () => {
    align.schedule(() =>
      latest.actual ? [...latest.actual] : sentQ ? [...sentQ] : null
    );
  };

  const detach = () => {
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    window.removeEventListener("pointercancel", onPointerCancel);
    window.removeEventListener("blur", onBlur);
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("pagehide", onPageHide);
    window.removeEventListener("keydown", onKeyDown);
  };

  const stopDrag = (reason) => {
    if (!dragging) return;
    dragging = false;
    mode = null;
    jointIndex = null;
    qStart = null;
    pointerId = null;
    detach();
    controls.enabled = true;
    stream.stopNow();
    rig.setMarker(null);
    rig.setRingActive(null);
    onStop?.(reason);
    scheduleAlign();
  };

  const onPointerDown = (event) => {
    if (event.button !== 0 || dragging || !event.isPrimary) return;
    if (!latest.gate?.ready) {
      onStatus?.("门禁未通过，不能拖动");
      return;
    }
    if (!ranges || !inset) {
      onStatus?.("safe 范围不可用，不能拖动");
      return;
    }
    const ray = pointerRay(camera, canvas, event);
    if (Math.abs(dot(ray.dir, planeNormal)) < 0.2) {
      onStatus?.("相机太侧切：请转到正视（侧视不可拖）");
      return;
    }
    const point = planeHit(ray, planeNormal);
    if (!point) return;
    const armPoint = toArm(point);
    const ring = pickRing(armPoint);
    if (!ring && !hitsSphere(ray, rig.getPickSphere())) return;

    dragging = true;
    mode = ring ? "joint" : "lamp";
    jointIndex = ring ? ring.index : null;
    qStart = rig.getPose();
    aStart = ring ? angleDeg(armPoint, ring.center) : 0;
    pointerId = event.pointerId;
    clearAlign();
    controls.enabled = false;
    sentQ = [...qStart];
    psiLock = fk(machine, sentQ).psi;
    lastValidLamp = fk(machine, sentQ).lamp;
    lastSeq = latest.state?.seq ?? null;
    staleSeqFrames = 0;
    dragStartSeq = stream.seq;
    dragError = latest.error;
    rig.setMarker(null);
    rig.setRingActive(jointIndex);
    stream.start(() => sentQ);
    onStatus?.(
      ring ? `拖动 J${ring.index + 1}：松手停止` : "拖动中：松手停止"
    );
    onTarget?.([...sentQ]);
    event.preventDefault();

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerCancel);
    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("keydown", onKeyDown);
  };

  const applyTarget = (nextQ, result) => {
    const stepped = limitPoseStep(sentQ, nextQ);
    if (!isSafeQ(stepped, inset)) return false;
    sentQ = stepped;
    lastValidLamp = fk(machine, sentQ).lamp;
    rig.setMarker(null);
    onTarget?.([...sentQ]);
    if (result?.q3Clamped) onStatus?.("腕到限位：灯头已倾斜，灯头中心保持");
    return true;
  };

  const onPointerMove = (event) => {
    if (!dragging) return;
    if (pointerId !== null && event.pointerId !== pointerId) return;
    const ray = pointerRay(camera, canvas, event);
    const point = planeHit(ray, planeNormal);
    if (!point) return;
    const lamp = toArm(point);

    if (mode === "joint") {
      const ring = rig.getJointRings()[jointIndex];
      if (!ring) return;
      const center = toArm(ring.center);
      const aNow = angleDeg(lamp, center);
      const result = jointDragQ(
        machine,
        qStart,
        jointIndex,
        wrapDeltaDeg(aStart, aNow),
        inset
      );
      const stepped = limitPoseStep(sentQ, result.qModel);
      if (!isSafeQ(stepped, inset)) return;
      sentQ = stepped;
      rig.setRingActive(jointIndex);
      onTarget?.([...sentQ]);
      if (result.clamped) onStatus?.(`J${jointIndex + 1} 到限位`);
      return;
    }

    const reach =
      machine.links.l1 + machine.links.l2 + machine.links.l3;
    if (Math.hypot(lamp.x, lamp.y - machine.base.shoulder_height) > reach + 1) {
      rig.setMarker({ x: lamp.x, y: lamp.y });
      onStatus?.("不可达：模型停在边界");
      return;
    }

    const result = ikHead(machine, lamp, psiLock, sentQ, inset);
    if (result.ok && applyTarget(result.qModel, result)) return;

    const fallback = bisectSafeTarget(
      machine,
      lastValidLamp,
      lamp,
      psiLock,
      sentQ,
      inset
    );
    if (fallback.ok) applyTarget(fallback.qModel, null);
    rig.setMarker({ x: lamp.x, y: lamp.y });
    onStatus?.("不可达：模型停在边界");
  };

  const onPointerUp = () => stopDrag("松手");
  const onPointerCancel = () => stopDrag("指针取消");
  const onBlur = () => stopDrag("窗口失焦");
  const onVisibility = () => {
    if (document.hidden) stopDrag("页面隐藏");
  };
  const onPageHide = () => stopDrag("页面关闭");
  const onKeyDown = (event) => {
    if (event.key === "Escape") stopDrag("Esc");
  };

  const stopNow = (reason = "STOP") => {
    if (dragging) {
      stopDrag(reason);
      return;
    }
    transport.stop();
    onStopSent?.();
    onStop?.(reason);
  };

  const update = ({ gate, actual, state, error, ranges: nextRanges }) => {
    latest = { gate, actual, state, error };
    if (nextRanges) {
      ranges = nextRanges;
      inset = insetModelRanges(nextRanges);
    }
    if (!dragging) return;
    const now = performance.now();
    const gap = lastUpdateAt ? now - lastUpdateAt : 0;
    lastUpdateAt = now;
    if (!gate) {
      stopDrag("门禁状态丢失");
      return;
    }
    const blocking = blockingGateItems(gate.missing, gap);
    if (blocking.length > 0) {
      stopDrag(`门禁失效：${blocking[0]}`);
      return;
    }
    if (isNewError(error, dragError)) {
      stopDrag(`固件 ERR ${error.code} ${error.msg}`);
      return;
    }
    if (ranges && Array.isArray(actual) && actual.length === 3 && !isSafeQ(actual, ranges)) {
      stopDrag("实测 q 出 safe，请回标定台检查");
      return;
    }
    if (state && stream.seq > dragStartSeq) {
      if (state.seq !== lastSeq) {
        lastSeq = state.seq;
        staleSeqFrames = 0;
      } else {
        staleSeqFrames += 1;
        if (staleSeqFrames >= 3) {
          stopDrag("目标未被接受（STATE.seq 不前进）");
        }
      }
    }
  };

  const dispose = () => {
    stopDrag("dispose");
    clearAlign();
    canvas.removeEventListener("pointerdown", onPointerDown);
  };

  canvas.addEventListener("pointerdown", onPointerDown);

  return {
    update,
    stopNow,
    isDragging: () => dragging,
    dispose,
  };
}
