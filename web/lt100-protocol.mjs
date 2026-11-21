// LT100P/1 pure protocol helpers. No DOM, no transport.
// Used by the calibration/detection page and by node --test.

export const PROTOCOL_VERSION = 1;
export const TICKS_PER_DEGREE = 4096 / 360;

export const MODE_LABELS = {
  BOOT: "BOOT",
  UNCAL: "未标定",
  CAL: "标定中",
  READY: "就绪",
  MOTION: "运动中",
  FAULT: "故障",
  ESTOP: "急停",
};

export const ERROR_LABELS = {
  1: "未知命令",
  2: "参数错误",
  3: "范围错误",
  5: "行过长",
  6: "舵机离线",
  7: "无 ACK",
  8: "端点非法",
  9: "未标定",
  10: "超出安全区",
  11: "模式不允许",
  12: "忙",
  13: "协议版本不匹配",
  14: "存储失败",
  15: "过温",
  16: "掉压",
  17: "失联",
  18: "内部错误",
};

function toNumber(value, fallback = null) {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toList(value) {
  if (!value) return [];
  return value.split(",").map((part) => toNumber(part, 0));
}

export function parseLine(line) {
  const text = String(line ?? "").trim();
  if (!text) return null;
  const match = text.match(/^(\S+)(?:\s+(.*))?$/);
  if (!match) return null;
  const verb = match[1].toUpperCase();
  const fields = {};
  const args = [];
  const rest = match[2] ?? "";
  for (const token of rest.split(/\s+/)) {
    if (!token) continue;
    const eq = token.indexOf("=");
    if (eq > 0) {
      fields[token.slice(0, eq)] = token.slice(eq + 1);
    } else {
      args.push(token);
    }
  }
  return { verb, args, fields, text };
}

export function parseHello(line) {
  const p = parseLine(line);
  if (!p || p.verb !== "HELLO") return null;
  return {
    protocol: toNumber(p.fields.protocol),
    fw: p.fields.fw ?? "",
    cal: toNumber(p.fields.cal),
    features: (p.fields.features ?? "").split(",").filter(Boolean),
  };
}

export function parseState(line) {
  const p = parseLine(line);
  if (!p || p.verb !== "STATE") return null;
  return {
    seq: toNumber(p.fields.seq, 0),
    mode: p.fields.mode ?? "",
    online: toNumber(p.fields.online, 0),
    cal: toNumber(p.fields.cal, 0),
    torque: toNumber(p.fields.torque, 0),
    err: toNumber(p.fields.err, 0),
    age: toNumber(p.fields.age, 0),
    q: toList(p.fields.q),
    raw: toList(p.fields.raw),
    load: toList(p.fields.load),
    cur: toList(p.fields.cur),
    temp: toList(p.fields.t),
    v: toNumber(p.fields.v, 0),
  };
}

export function parseError(line) {
  const p = parseLine(line);
  if (!p || p.verb !== "ERR") return null;
  return {
    code: toNumber(p.fields.code, 0),
    seq: toNumber(p.fields.seq, 0),
    joint: toNumber(p.fields.joint, 0),
    msg: p.fields.msg ?? "",
  };
}

export function parseCalLine(line) {
  const p = parseLine(line);
  if (!p || p.verb !== "CAL") return null;
  return {
    id: toNumber(p.fields.id),
    ref: toNumber(p.fields.ref, 0),
    hasMin: toNumber(p.fields.min_set, 0),
    hasMax: toNumber(p.fields.max_set, 0),
    zeroRaw: toNumber(p.fields.zero_raw, 0),
    zeroQ: toNumber(p.fields.zero_q, 0),
    sign: toNumber(p.fields.sign, 1),
    minRaw: toNumber(p.fields.min, 0),
    maxRaw: toNumber(p.fields.max, 0),
    margin: toNumber(p.fields.margin, 0),
    valid: toNumber(p.fields.valid, 0) === 1,
  };
}

export function parseLimitsLine(line) {
  const p = parseLine(line);
  if (!p || p.verb !== "LIMITS") return null;
  const safe = String(p.fields.safe ?? "").split("..");
  return {
    id: toNumber(p.fields.id),
    minRaw: toNumber(p.fields.min, 0),
    maxRaw: toNumber(p.fields.max, 0),
    safeMin: toNumber(safe[0], 0),
    safeMax: toNumber(safe[1], 0),
    valid: toNumber(p.fields.valid, 0) === 1,
  };
}

export function rawToQ(cal, raw) {
  if (!cal || !cal.valid || !Number.isFinite(raw)) return null;
  return cal.zeroQ + cal.sign * (raw - cal.zeroRaw) / TICKS_PER_DEGREE;
}

export function qToRaw(cal, q) {
  if (!cal || !cal.valid || !Number.isFinite(q)) return null;
  return Math.round(cal.zeroRaw + cal.sign * (q - cal.zeroQ) * TICKS_PER_DEGREE);
}

export function safeRange(cal) {
  if (!cal || !cal.valid) return null;
  return { min: cal.minRaw + cal.margin, max: cal.maxRaw - cal.margin };
}

export function calComplete(cals) {
  return Array.isArray(cals) && cals.length === 3 &&
    cals.every((cal) => Boolean(cal && cal.valid));
}

export function endpointPose(state, cals, jointIndex, targetRaw) {
  if (!state || !Array.isArray(cals) || jointIndex < 0 || jointIndex > 2) {
    return null;
  }
  const q = [];
  for (let i = 0; i < 3; i++) {
    if (i === jointIndex) {
      const angle = rawToQ(cals[i], targetRaw);
      if (angle === null) return null;
      q.push(angle);
      continue;
    }
    if (Number.isFinite(state.q[i])) {
      q.push(state.q[i]);
    } else if (cals[i]?.valid && Number.isFinite(state.raw[i])) {
      q.push(rawToQ(cals[i], state.raw[i]));
    } else {
      return null;
    }
  }
  return q;
}

export function formatQ(q) {
  if (!Number.isFinite(q)) return "—";
  const value = Math.abs(q) < 0.05 ? 0 : Math.round(q * 10) / 10;
  return value.toFixed(1);
}

export function poseCommand(seq, q, speed = 10, acc = 20) {
  if (!Array.isArray(q) || q.length !== 3 || q.some((v) => !Number.isFinite(v))) {
    throw new Error("POSE requires three finite q values");
  }
  return `POSE seq=${seq} q=${q.map(formatQ).join(",")} speed=${speed} acc=${acc}`;
}

export const commands = {
  hello: "HELLO",
  state: "STATE",
  streamOn: "STREAM ON",
  streamOff: "STREAM OFF",
  calStatus: "CAL STATUS",
  calSave: "CAL SAVE",
  limits: "LIMITS",
  stop: "STOP",
  estop: "ESTOP",
  clear: "CLEAR",
  torqueAllOn: "TORQUE all ON",
  torqueAllOff: "TORQUE all OFF",
};

export function torqueCommand(id, on) {
  return `TORQUE ${id === 0 ? "all" : id} ${on ? "ON" : "OFF"}`;
}

export function calRefCommand(id, q) {
  return `CAL REF ${id} ${formatQ(q)}`;
}

export function calDirCommand(id, sign) {
  return `CAL DIR ${id} ${sign < 0 ? "-1" : "+1"}`;
}

export function calMarkCommand(id, which) {
  return `CAL MARK ${id} ${which === "MIN" ? "MIN" : "MAX"}`;
}

export function calClearCommand(id) {
  return `CAL CLEAR ${id === 0 ? "all" : id}`;
}

export function maskCount(mask) {
  let count = 0;
  for (let i = 0; i < 3; i++) if (mask & (1 << i)) count++;
  return count;
}
