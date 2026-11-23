// LT100P/1 calibration and detection console.
// The page talks to the local serial bridge first, then falls back to Web Serial.
import {
  calClearCommand,
  calComplete,
  calDirCommand,
  calMarkCommand,
  calRefCommand,
  calSplitCommand,
  commands,
  ERROR_LABELS,
  idGetCommand,
  idSetCommand,
  jogCommand,
  formatQ,
  maskCount,
  MODE_LABELS,
  parseCalLine,
  parseError,
  parseHello,
  parseLimitsLine,
  parseLine,
  parseState,
  poseCommand,
  qToRaw,
  rawMoveCommand,
  rawInJoint,
  rawInSafe,
  rawToQ,
  safeQRange,
  safeRange,
  TICKS_PER_DEGREE,
  torqueCommand,
} from "./lt100-protocol.mjs";

const $ = (id) => document.getElementById(id);
const mock = new URLSearchParams(location.search).has("mock");
const autoConnect = new URLSearchParams(location.search).has("auto");
const bridgeUrl = "ws://127.0.0.1:8771/serial";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let transport = null;
let connected = false;
let busy = false;
let tearingDown = false;
let lineBuf = "";
let pending = null;
let hello = null;
let lastState = null;
let lastErr = null;
let cals = [null, null, null];
let limits = [null, null, null];
let calAccumulator = [];
let limitsAccumulator = [];
let selected = 3;
let unloaded = [false, false, false];
let dirSet = [false, false, false];
let seq = 1;
let testTimer = null;
let testTarget = null;
let testNear = 0;
let testDeadline = 0;
let poseTimer = null;
let poseTarget = null;
let posePlan = null;
let poseStep = 0;
let posePhase = "move";
let poseDwellUntil = 0;
let poseDeadline = 0;
let rawMsgUntil = 0;
let logLines = [];

function appendLog(kind, text) {
  logLines.push({
    kind,
    text,
    time: new Date().toLocaleTimeString("zh-CN", { hour12: false }),
  });
  if (logLines.length > 400) logLines.shift();
  renderLog();
}

function renderLog() {
  const el = $("log");
  el.textContent = "";
  for (const item of logLines) {
    const row = document.createElement("div");
    row.className = `log-line ${item.kind}`;
    const time = document.createElement("span");
    time.className = "log-time";
    time.textContent = item.time;
    const mark = document.createElement("span");
    mark.className = "log-mark";
    mark.textContent = item.kind === "tx" ? "›" : item.kind === "rx" ? "‹" : item.kind === "err" ? "!" : "·";
    const text = document.createElement("span");
    text.className = "log-text";
    text.textContent = item.text;
    row.append(time, mark, text);
    el.appendChild(row);
  }
  el.scrollTop = el.scrollHeight;
}

function setNotice(id, text, show = true) {
  const el = $(id);
  el.textContent = text;
  el.hidden = !show;
}

function setWizard(text) {
  $("wizMsg").textContent = text;
}

function setDetectMsg(text) {
  const el = $("detectMsg");
  if (el) el.textContent = text;
}

function nowStamp() {
  return new Date().toLocaleTimeString("zh-CN", { hour12: false });
}

function setTestMsg(text) {
  $("testMsg").textContent = text;
}

function modeLabel(mode) {
  return MODE_LABELS[mode] ?? mode ?? "—";
}

function errorLabel(code) {
  if (!code) return "—";
  return `${code} · ${ERROR_LABELS[code] ?? "未知"}`;
}

function rawInsideSafe(index) {
  const cal = cals[index];
  const raw = lastState?.raw?.[index];
  const range = safeRange(cal);
  return Boolean(range && Number.isFinite(raw) && rawInSafe(range, raw));
}

function offsetRaw(raw, delta) {
  return ((raw + delta) % 4096 + 4096) % 4096;
}

function rawDistance(a, b) {
  const d = Math.abs(a - b) % 4096;
  return Math.min(d, 4096 - d);
}

function safeLabel(range) {
  return range ? `safe ${range.min}..${range.max}${range.wrap ? "（跨 0）" : ""}` : "标定/限位未就绪";
}

function qRangeLabel(cal) {
  const q = safeQRange(cal);
  return q ? `允许 q ${formatQ(q.min)}°..${formatQ(q.max)}°` : "q 范围 —";
}

// A marked travel that crosses 0 is cut at the seam into two executable sides.
// Only the side that still contains the reference pose can be saved.
function splitSide(cal, side) {
  const margin = cal.margin ?? 40;
  const start = side === "LOW" ? 0 : cal.minRaw;
  const end = side === "LOW" ? cal.maxRaw : 4095;
  const span = end - start;
  const containsZero = cal.zeroRaw >= start && cal.zeroRaw <= end;
  const usable = containsZero && cal.zeroRaw - start >= margin &&
    end - cal.zeroRaw >= margin && span > 2 * margin;
  return { side, start, end, span, deg: span / TICKS_PER_DEGREE, containsZero, usable };
}

function setConnected(value, label = "") {
  connected = value;
  const state = $("connState");
  state.classList.toggle("ok", value);
  state.classList.toggle("busy", busy && !value);
  $("connText").textContent = value ? "已连接" : "未连接";
  $("portInfo").textContent = label || (value ? "串口" : "未连接");
  $("connectBtn").disabled = value || busy;
  $("disconnectBtn").disabled = !value || busy;
  updateButtons();
  render();
}

function feed(text) {
  lineBuf += text;
  const parts = lineBuf.split("\n");
  lineBuf = parts.pop() ?? "";
  for (const part of parts) {
    const line = part.replace(/\r$/, "");
    if (line.trim()) handleLine(line);
  }
}

function sendRaw(command, log = true) {
  if (!connected || !transport) throw new Error("未连接");
  if (log) appendLog("tx", command);
  transport.write(`${command}\n`);
}

function request(command, match, timeout = 3000) {
  if (!connected) return Promise.reject(new Error("未连接"));
  if (pending) return Promise.reject(new Error("上一条命令还在等待回复"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (!pending) return;
      pending = null;
      reject(new Error(`${command} 超时`));
    }, timeout);
    pending = {
      command,
      match,
      resolve: (parsed) => {
        clearTimeout(timer);
        pending = null;
        resolve(parsed);
      },
      reject: (error) => {
        clearTimeout(timer);
        pending = null;
        reject(error);
      },
    };
    try {
      sendRaw(command);
    } catch (error) {
      clearTimeout(timer);
      pending = null;
      reject(error);
    }
  });
}

function isOk(parsed, text) {
  return parsed.verb === "OK" && (parsed.args[0] ?? "") === text;
}

function handleLine(line) {
  const parsed = parseLine(line);
  if (!parsed) return;
  if (parsed.verb !== "STATE") appendLog("rx", line);

  if (parsed.verb === "HELLO") {
    hello = parseHello(line);
    render();
  } else if (parsed.verb === "STATE") {
    const state = parseState(line);
    if (state) {
      lastState = state;
      if (state.err) {
        lastErr = { code: state.err, msg: ERROR_LABELS[state.err] ?? "" };
      }
      render();
    }
  } else if (parsed.verb === "CAL") {
    const cal = parseCalLine(line);
    if (cal && cal.id >= 1 && cal.id <= 3) {
      cals[cal.id - 1] = cal;
      calAccumulator.push(cal);
    }
  } else if (parsed.verb === "LIMITS") {
    const limit = parseLimitsLine(line);
    if (limit && limit.id >= 1 && limit.id <= 3) {
      limits[limit.id - 1] = limit;
      limitsAccumulator.push(limit);
    }
  } else if (parsed.verb === "ERR") {
    lastErr = parseError(line);
    appendLog("err", `ERR ${lastErr.code} ${lastErr.msg}`);
    if (testTimer) stopTest(`固件报错：${lastErr.code} ${lastErr.msg}（joint ${lastErr.joint}）`);
    if (poseTimer) stopPoseTest(`固件报错：${lastErr.code} ${lastErr.msg}`);
    if (pending) pending.reject(new Error(`ERR ${lastErr.code} ${lastErr.msg}`));
  }

  if (pending && pending.match(parsed)) pending.resolve(parsed);
}

async function collectCal() {
  cals = [null, null, null];
  calAccumulator = [];
  await request(commands.calStatus, (p) => isOk(p, "cal"));
  render();
}

async function collectLimits() {
  limits = [null, null, null];
  limitsAccumulator = [];
  await request(commands.limits, (p) => isOk(p, "limits"));
  render();
}

async function refreshAll() {
  await request(commands.state, (p) => p.verb === "STATE");
  await collectCal();
  await collectLimits();
}

function openBridge() {
  return new Promise((resolve, reject) => {
    let settled = false;
    const ws = new WebSocket(bridgeUrl);
    ws.binaryType = "arraybuffer";
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch {}
      reject(new Error("串口桥连接超时"));
    }, 1600);

    ws.onopen = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      transport = {
        kind: "bridge",
        write(text) {
          if (ws.readyState !== WebSocket.OPEN) throw new Error("串口桥已断开");
          ws.send(text);
        },
        close() { ws.close(); },
      };
      ws.onmessage = (event) => {
        if (typeof event.data === "string") feed(event.data);
        else feed(new TextDecoder().decode(new Uint8Array(event.data)));
      };
      ws.onclose = () => {
        if (!tearingDown && connected) handleTransportLost("串口桥断开");
      };
      resolve();
    };
    ws.onerror = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error("串口桥未启动"));
    };
    ws.onclose = () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error("串口桥未启动"));
      }
    };
  });
}

async function openWebSerial() {
  if (!navigator.serial) throw new Error("浏览器不支持 Web Serial");
  const port = await navigator.serial.requestPort();
  await port.open({ baudRate: 115200 });
  const writer = port.writable.getWriter();
  const reader = port.readable.getReader();
  const decoder = new TextDecoder();
  transport = {
    kind: "serial",
    write(text) { writer.write(new TextEncoder().encode(text)); },
    close() {
      try { reader.cancel(); } catch {}
      try { writer.releaseLock(); } catch {}
      try { port.close(); } catch {}
    },
  };
  (async () => {
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) feed(decoder.decode(value, { stream: true }));
      }
    } catch (error) {
      if (!tearingDown) appendLog("err", `串口读取中断：${error.message ?? error}`);
    } finally {
      reader.releaseLock?.();
      if (!tearingDown && connected) handleTransportLost("串口断开");
    }
  })();
}

async function openMock() {
  const link = new MockLink(feed);
  window.__lt100Mock = link;  // QA hook: drive raw positions in mock mode
  transport = {
    kind: "mock",
    write(text) { link.write(text); },
    close() { link.close(); },
  };
  $("mockBadge").hidden = false;
  $("portInfo").textContent = "模拟端口（不连硬件）";
}

async function handshake() {
  await request(commands.hello, (p) => p.verb === "HELLO", 2500);
  await request(commands.streamOn, (p) => p.verb === "OK" && p.fields.stream === "on", 2000);
  await request(commands.state, (p) => p.verb === "STATE", 2000);
  await collectCal();
  await collectLimits();
}

async function connect() {
  if (connected || busy) return;
  busy = true;
  updateButtons();
  try {
    lineBuf = "";
    pending = null;
    hello = null;
    lastState = null;
    lastErr = null;
    cals = [null, null, null];
    limits = [null, null, null];
    unloaded = [false, false, false];
    dirSet = [false, false, false];
    if (mock) {
      await openMock();
    } else {
      try {
        await openBridge();
        appendLog("sys", "已连接本机串口桥 ws://127.0.0.1:8771/serial");
      } catch (bridgeError) {
        appendLog("sys", `本机串口桥不可用：${bridgeError.message}；尝试 Web Serial`);
        if (String(bridgeError.message).includes("超时")) {
          appendLog("sys", "桥同一时间只服务一个页面：先关掉其他 LT100 标签，再点连接。");
        }
        await openWebSerial();
        appendLog("sys", "已连接 Web Serial；打开串口可能让板子复位一次");
      }
    }
    setConnected(true, mock ? "模拟端口" : transport.kind === "bridge" ? "本机串口桥 / CP210x" : "CP210x / Web Serial");
    await sleep(mock ? 60 : 300);
    await handshake();
    setPanel("calibrate");
    const onlineMask = lastState?.online ?? 0;
    if (!(onlineMask & (1 << (selected - 1)))) {
      const firstOnline = [1, 2, 3].find((id) => onlineMask & (1 << (id - 1)));
      if (firstOnline) selectJoint(firstOnline);
    }
    setWizard(`已连接：在线 ${maskCount(onlineMask)}/3。先确认关节在线，再按步骤卸力标定。`);
    appendLog("sys", "LT100P/1 握手完成");
  } catch (error) {
    const detail = String(error.message ?? error);
    const wrongFirmware = detail.includes("HELLO 超时") || /^ERR (1|01)\b/.test(detail);
    const hint = wrongFirmware
      ? "没有收到 LT100P/1 握手。确认板子烧的是 09 公版固件；如果烧的是 08，请回应用页打开 08 串口控制台。"
      : `连接失败：${detail}`;
    appendLog("err", hint);
    setNotice("hint", hint);
    await disconnect(false);
  } finally {
    busy = false;
    setConnected(connected, transport?.kind === "mock" ? "模拟端口" : transport?.kind === "bridge" ? "本机串口桥 / CP210x" : transport?.kind === "serial" ? "CP210x / Web Serial" : "");
    updateButtons();
  }
}

function handleTransportLost(reason) {
  if (tearingDown) return;
  stopTest(reason);
  appendLog("err", reason);
  setNotice("hint", reason);
  try { transport?.close(); } catch {}
  transport = null;
  if (pending) pending.reject(new Error(reason));
  pending = null;
  setConnected(false);
}

async function disconnect(manual = true) {
  tearingDown = true;
  stopTest();
  if (poseTimer) stopPoseTest("已断开");
  try {
    if (connected && transport) transport.write("STOP\n");
  } catch {}
  try { transport?.close(); } catch {}
  transport = null;
  connected = false;
  pending = null;
  lineBuf = "";
  if (manual) appendLog("sys", "已断开");
  tearingDown = false;
  setConnected(false, "未连接");
  updateButtons();
}

function computeNow() {
  if (!connected) return "先点「连接串口」。";
  const mode = lastState?.mode;
  if (mode === "ESTOP") return "现在是急停：先点安全条里的 CLEAR 解除。";
  if (mode === "FAULT") return "现在是故障：看状态条的错误码，排除后点 CLEAR。";
  const online = lastState?.online ?? 0;
  if (!(online & (1 << (selected - 1)))) {
    const firstOnline = [1, 2, 3].find((id) => online & (1 << (id - 1)));
    return firstOnline
      ? `ID${selected} 不在线：点 ID${firstOnline} 卡片继续，或检查 12V 和 3P 线。`
      : "三个关节都不在线：检查 12V 5A 电源和 3P 总线。";
  }
  const cal = cals[selected - 1];
  if (cal && cal.hasMin && cal.hasMax && cal.minRaw > cal.maxRaw) {
    return `ID${selected} 的行程跨 0：在下方选保留哪段，再点「确认保留并保存」；另一段将不可达。`;
  }
  if (!unloaded[selected - 1] && !cal?.ref) return "先用手扶住关节，再点步骤 2 的「卸力」。";
  if (!cal?.ref) return "把关节摆到你要当 0° 的位置，q 填 0，点「记录零点」。";
  if (!dirSet[selected - 1] && !cal?.valid) return "用手转一点，看 raw 变大还是变小；选方向后点「确定方向」。";
  if (!cal?.hasMin) return "转到行程的任意一端（别顶死），点「标记一端」。先标哪端都行，但前提是 Z 必须在你要允许的行程内。";
  if (!cal?.hasMax) return "再转到行程的另一端，点「标记另一端」。固件取包含 Z 的那段弧为行程。";
  if (!cal?.valid) return "两端至少相差 80 个 raw，且参考姿态离两端各 ≥40 tick；检查后点底部「CAL SAVE」。注意：Z 在允许行程外时固件会选补弧，能保存但不可用。";
  if (mode === "CAL") return "检查零点、方向和两个端点，没问题就点底部「CAL SAVE · 保存当前关节」。";
  const range = safeRange(cal);
  const raw = lastState?.raw?.[selected - 1];
  if (range && (!Number.isFinite(raw) || !rawInSafe(range, raw))) {
    return `ID${selected} 当前 raw ${Number.isFinite(raw) ? raw : "—"} 不在 ${safeLabel(range)} 内；先用手转回去，再上力或测试。`;
  }
  const selTorque = Boolean(lastState?.torque & (1 << (selected - 1)));
  if (!selTorque) return `ID${selected} 已标定。点左侧 ID${selected} 卡片底部的「上力」，然后去「端点测试」。`;
  if (!calComplete(cals)) {
    const next = [1, 2, 3].find((id) => (online & (1 << (id - 1))) && !cals[id - 1]?.valid);
    return next
      ? `ID${selected} 已上力。去「端点测试」试它，或接着标 ID${next}。`
      : "在线关节都标完了；把还没在线的接上再继续。";
  }
  if (lastState?.torque !== 7) return "三颗都标定有效了：确认每颗 raw 在 safe 区间内，再在各自卡片底部点「上力」。";
  return "三颗已标定并上力。切到「端点测试」，低速把两端各走一遍。";
}

function renderSplitBox(cal) {
  const box = $("splitBox");
  if (!box) return;
  const crossed = Boolean(cal && cal.hasMin && cal.hasMax && cal.minRaw > cal.maxRaw);
  box.hidden = !crossed || !connected;
  if (!crossed) return;
  const low = splitSide(cal, "LOW");
  const high = splitSide(cal, "HIGH");
  const label = (s, name) => {
    const why = s.usable ? " · 可用" : s.containsZero ? " · Z 离接缝太近" : " · 不含 Z，需重定零点";
    return `${name} raw ${s.start}..${s.end}（约 ${formatQ(s.deg)}°）${why}`;
  };
  $("splitLowLabel").textContent = label(low, "低段");
  $("splitHighLabel").textContent = label(high, "高段");
  $("splitLow").disabled = !low.usable;
  $("splitHigh").disabled = !high.usable;
  const pick = low.usable ? "LOW" : high.usable ? "HIGH" : null;
  if (pick === "LOW") $("splitLow").checked = true;
  if (pick === "HIGH") $("splitHigh").checked = true;
  $("splitHint").textContent = pick
    ? `保留后 ${pick === "LOW" ? `${high.start}..${high.end}` : `${low.start}..${low.end}`} 这段不可达；接缝端不是机械端点，手臂会在中途停住。想保留另一段：先在保存前把手臂摆到那段里，回步骤 3 重定零点（CAL REF），再回来选。`
    : `参考姿态 Z 离接缝不足 ${cal.margin ?? 40} tick，两段都不能用：先重新定零点，或换舵盘齿/安装位。`;
  $("splitConfirmBtn").disabled = busy || !pick;
}

function render() {
  const state = lastState;
  const online = state?.online ?? 0;
  const calMask = state?.cal ?? 0;
  const torque = state?.torque ?? 0;
  $("stMode").textContent = modeLabel(state?.mode ?? "—");
  $("stOnline").textContent = `${maskCount(online)}/3`;
  $("stCal").textContent = `${maskCount(calMask)}/3`;
  $("stTorque").textContent = `${maskCount(torque)}/3`;
  $("stErr").textContent = state?.err ? errorLabel(state.err) : "—";
  $("stAge").textContent = state ? `${state.age} ms` : "—";
  $("stVolt").textContent = state ? `${(state.v / 10).toFixed(1)} V` : "—";
  $("stErr").parentElement.classList.toggle("error", Boolean(state?.err));

  const safety = $("safetyState");
  if (!connected) {
    safety.textContent = "当前：未连接";
    safety.classList.remove("on");
  } else if (state?.mode === "ESTOP") {
    safety.textContent = "当前：急停已锁存 → 点「解除急停」";
    safety.classList.add("on");
  } else if (state?.mode === "FAULT") {
    safety.textContent = "当前：故障 → 排查后点「解除急停」";
    safety.classList.add("on");
  } else {
    safety.textContent = `当前：${modeLabel(state?.mode ?? "—")}`;
    safety.classList.remove("on");
  }

  const onlineCount = maskCount(online);
  const hintEl = $("hint");
  if (connected && state?.mode === "ESTOP") {
    setNotice("hint", "急停已锁存（ESTOP）：点安全条里的 CLEAR 解除；CLEAR 不会让关节运动。");
  } else if (connected && onlineCount < 3) {
    setNotice("hint", `当前只在线 ${onlineCount}/3：单关节可以标定、上力、做端点测试；三轴不齐不会进入 READY，也不会执行整机 POSE。`);
  } else if (hintEl.textContent.startsWith("当前只在线") || hintEl.textContent.startsWith("急停已锁存")) {
    setNotice("hint", "", false);
  }

  for (let i = 0; i < 3; i++) {
    const id = i + 1;
    const isOnline = Boolean(online & (1 << i));
    const cal = cals[i];
    const limit = limits[i];
    const raw = state?.raw?.[i] ?? null;
    const q = cal?.valid && Number.isFinite(raw) && rawInJoint(cal, raw) ? rawToQ(cal, raw) : null;
    const card = document.querySelector(`.joint-card[data-id="${id}"]`);
    card.classList.toggle("selected", selected === id);
    card.classList.toggle("offline", !isOnline);
    card.querySelector(".joint-pick")?.setAttribute("aria-pressed", selected === id ? "true" : "false");
    const pill = $(`j${id}state`);
    pill.className = "pill";
    if (!isOnline) {
      pill.textContent = "离线";
    } else if (cal?.valid) {
      pill.classList.add("ok");
      pill.textContent = "已标定";
    } else {
      pill.classList.add("warn");
      pill.textContent = "在线 / 未标定";
    }
    $(`j${id}raw`).textContent = isOnline && Number.isFinite(raw) ? String(raw) : "----";
    $(`j${id}q`).textContent = q === null ? "q —" : `q ${formatQ(q)}°`;
    $(`j${id}volt`).textContent = isOnline ? `${(state?.v / 10).toFixed(1)} V` : "—";
    $(`j${id}temp`).textContent = isOnline ? `${state?.temp?.[i] ?? "—"} °C` : "—";
    $(`j${id}load`).textContent = isOnline ? `${state?.load?.[i] ?? "—"}` : "—";
    $(`j${id}cur`).textContent = isOnline ? `${state?.cur?.[i] ?? "—"}` : "—";
    const safe = safeRange(cal);
    const crossed = Boolean(cal && cal.hasMin && cal.hasMax && cal.minRaw > cal.maxRaw);
    const touched = Boolean(cal && (cal.ref || cal.hasMin || cal.hasMax));
    $(`j${id}safe`).textContent = crossed
      ? "行程跨 0：在向导里选保留一段（另一段不可达）"
      : safe
        ? `${qRangeLabel(cal)} · ${safeLabel(safe)} · 端点 raw ${limit?.minRaw ?? cal.minRaw}/${limit?.maxRaw ?? cal.maxRaw}`
        : touched
          ? cal.hasMin && cal.hasMax
            ? "两端已标，但还不合法（看 Z 与端点距离）"
            : cal.hasMin ? "已标一端；还缺另一端" : cal.hasMax ? "已标另一端；还缺一端" : "已记零点，待标端点"
          : "未标定";
    $(`j${id}safe`).classList.toggle("cal", Boolean(safe));
    const jointTorq = Boolean(torque & (1 << i));
    const tqState = $(`j${id}tq`);
    tqState.textContent = isOnline ? (jointTorq ? "开" : "关") : "—";
    tqState.classList.toggle("on", jointTorq);
    const tqBtn = document.querySelector(`[data-torque="${id}"]`);
    if (tqBtn) {
      const modeNow = state?.mode;
      const canOn = isOnline && Boolean(cal?.valid) && rawInsideSafe(i) &&
        modeNow !== "CAL" && modeNow !== "FAULT" && modeNow !== "ESTOP";
      tqBtn.textContent = jointTorq ? "卸力" : "上力";
      tqBtn.disabled = !connected || busy || modeNow === "ESTOP" || (!jointTorq && !canOn);
      tqBtn.title = jointTorq
        ? "卸力：只关输出力矩，不断电；先扶住手臂"
        : canOn
          ? "上力：先把目标设为当前位再使能"
          : "还不能上力：需要在线、标定有效、当前 raw 在 safe 内";
    }
  }

  $("currentJoint").textContent = `ID${selected}`;
  $("currentJoint2") && ($("currentJoint2").textContent = `ID${selected}`);
  $("testJoint").textContent = `ID${selected}`;
  const selectedCal = cals[selected - 1];
  const selectedLimit = limits[selected - 1];
  const selectedOnline = Boolean(online & (1 << (selected - 1)));
  const selectedTorque = Boolean(torque & (1 << (selected - 1)));
  renderSplitBox(selectedCal);
  renderPose();
  renderRawMove();
  // Firmware only allows CAL after an explicit TORQUE OFF (torqueKnown_ starts false),
  // so step 2 must be clicked, not inferred from STATE torque=0.
  const unloadedNow = unloaded[selected - 1] || Boolean(selectedCal?.ref);
  const done = {
    1: selectedOnline,
    2: unloadedNow,
    3: Boolean(selectedCal?.ref),
    "3b": dirSet[selected - 1] || Boolean(selectedCal?.valid),
    4: Boolean(selectedCal?.hasMin),
    5: Boolean(selectedCal?.hasMax),
    6: Boolean(selectedCal?.valid),
    7: Boolean(selectedCal?.valid) && selectedTorque,
  };
  const order = ["1", "2", "3", "3b", "4", "5", "6", "7"];
  const waitingForOtherJoints = Boolean(selectedCal?.valid) && !calComplete(cals);
  const activeKey = waitingForOtherJoints ? null : order.find((key) => !done[key]) ?? null;
  for (const row of document.querySelectorAll(".step-row[data-step]")) {
    row.classList.toggle("done", Boolean(done[row.dataset.step]));
    row.classList.toggle("active", row.dataset.step === activeKey);
  }
  const range = safeRange(selectedCal);
  $("testSafe").textContent = range
    ? `ID${selected} ${qRangeLabel(selectedCal)} · ${safeLabel(range)}（端点 raw ${selectedLimit?.minRaw ?? selectedCal.minRaw}/${selectedLimit?.maxRaw ?? selectedCal.maxRaw}）`
    : "标定/限位未就绪";
  $("testSafe").classList.toggle("cal", Boolean(range));

  const curRaw = state?.raw?.[selected - 1];
  const inTravel = selectedCal?.valid && Number.isFinite(curRaw) && rawInJoint(selectedCal, curRaw);
  const curQ = inTravel ? rawToQ(selectedCal, curRaw) : null;
  $("liveReadout").textContent = range && curQ !== null
    ? `raw ${curRaw} · q ${formatQ(curQ)}° · 零点 raw ${selectedCal.zeroRaw} · ${qRangeLabel(selectedCal)} · ${safeLabel(range)}`
    : (selectedCal?.valid && Number.isFinite(curRaw)
        ? `raw ${curRaw} · 在标定行程外，先卸力推回`
        : (selectedOnline ? `raw ${Number.isFinite(curRaw) ? curRaw : "—"} · 未标定` : "离线"));
  $("testQNow").textContent = curQ === null ? "q —" : `q ${formatQ(curQ)}°`;
  $("testRawNow").textContent = Number.isFinite(curRaw) ? `raw ${curRaw}` : "raw —";
  const slider = $("testSlider");
  const qAllow = testQRange(selectedCal);
  if (qAllow && curQ !== null) {
    slider.min = String(Math.ceil(qAllow.min));
    slider.max = String(Math.floor(qAllow.max));
    if (document.activeElement !== slider) slider.value = String(Math.round(curQ));
  }
  if (!testTimer) {
    const gate = testGateInfo();
    $("testGate").textContent = gate.text;
    $("testGate").classList.toggle("warn", !gate.ok);
  }

  $("fwInfo").textContent = hello
    ? `${hello.fw} · protocol ${hello.protocol} · ${hello.features.join(", ")}`
    : "—";
  $("calInfo").textContent = calComplete(cals)
    ? "3/3 有效"
    : `${cals.filter((cal) => cal?.valid).length}/3 有效`;
  $("torqueInfo").textContent = `${maskCount(torque)}/3`;
  $("errInfo").textContent = lastErr ? errorLabel(lastErr.code) : "—";

  const idIndex = [0, 1, 2].find((i) => online & (1 << i));
  const idButtonOk = connected && !busy && onlineCount === 1 &&
    !["CAL", "MOTION", "ESTOP"].includes(state?.mode);
  $("idNow").textContent = onlineCount === 1 ? `ID ${idIndex + 1}` : "ID —";
  $("idOnline").textContent = `在线 ${onlineCount} 颗`;
  const idHint = $("idHint");
  if (idHint) {
    idHint.textContent = !connected
      ? "未连接：先连接串口。"
      : onlineCount === 0
        ? "读不到舵机：检查 12V 和接线；如果接了两颗以上，可能是同 ID 抢答（出厂都是 ID1），先只接一颗。"
        : onlineCount === 1
          ? "总线上只有一颗，可以读取或改 ID。"
          : `总线上有 ${onlineCount} 颗：ID 工具只允许一颗，请先拔到只剩一颗。`;
  }
  for (const n of [1, 2, 3]) {
    $("idSet" + n).disabled = !idButtonOk || (idIndex + 1 === n);
  }
  $("idReadBtn").disabled = !idButtonOk;

  const detail = $("jointDetail");
  if (detail) {
    detail.textContent = "";
    for (let i = 0; i < 3; i++) {
      const cal = cals[i];
      const range = safeRange(cal);
      const row = document.createElement("div");
      const dt = document.createElement("dt");
      dt.textContent = `ID${i + 1}`;
      const dd = document.createElement("dd");
      dd.textContent = cal?.valid
        ? `已标定 · 零 raw ${cal.zeroRaw}（q ${formatQ(cal.zeroQ)}°） · 方向 ${cal.sign > 0 ? "+1" : "-1"} · 端点 raw ${cal.minRaw}/${cal.maxRaw} · ${qRangeLabel(cal)} · ${safeLabel(range)}`
        : (state && (state.online & (1 << i)) ? "在线，未标定" : "离线");
      row.append(dt, dd);
      detail.append(row);
    }
  }

  const outside = [0, 1, 2]
    .filter((index) => cals[index]?.valid && !rawInsideSafe(index))
    .map((index) => `ID${index + 1}`);
  const rangeWarn = $("rangeWarn");
  if (outside.length) {
    rangeWarn.hidden = false;
    rangeWarn.textContent = `${outside.join("、")} 的当前 raw 在 safe 区间外。先扶住手臂，手动移回安全区，再做 TORQUE ON / 端点测试；固件会拒绝超出 safe 的目标。`;
  } else {
    rangeWarn.hidden = true;
  }

  const s1 = $("s1state");
  s1.textContent = (online & (1 << (selected - 1))) ? "在线" : "离线";
  s1.className = `step-state ${online & (1 << (selected - 1)) ? "done" : ""}`;
  $("refQ").disabled = !connected || busy;
  $("dirSign").disabled = !connected || busy;
  $("nowText").textContent = computeNow();
  updateButtons();
}

function updateButtons() {
  const enabled = connected && !busy;
  $("connectBtn").disabled = connected || busy;
  $("disconnectBtn").disabled = !connected || busy;
  for (const id of ["calClearBtn", "readCalBtn", "readLimitsBtn", "refreshBtn", "stopBtn", "estopBtn", "clearBtn"]) {
    const el = $(id);
    if (!el) continue;
    el.disabled = !enabled;
    // Why a button is grey matters: a disabled control with no hint reads as "broken".
    el.title = enabled
      ? ""
      : !connected
        ? "先点「连接串口」，连上之后这个按钮才能用"
        : "上一条命令还在等回复，稍等一下";
  }
  const selCal = cals[selected - 1];
  const hasEdit = Boolean(selCal?.valid || selCal?.ref || selCal?.hasMin || selCal?.hasMax);
  const modeBlocked = lastState?.mode === "ESTOP" || lastState?.mode === "FAULT";
  const cross0 = Boolean(selCal && selCal.hasMin && selCal.hasMax && selCal.minRaw > selCal.maxRaw);
  $("calSaveBtn").disabled = !enabled || !hasEdit || modeBlocked || cross0;
  if ($("splitConfirmBtn")) {
    $("splitConfirmBtn").disabled = !enabled || !cross0 ||
      (!$("splitLow").checked && !$("splitHigh").checked);
  }
  const torqueOnSelected = Boolean(lastState?.torque & (1 << (selected - 1)));
  const selectedOnline = Boolean(lastState?.online & (1 << (selected - 1)));
  $("torqueOffBtn").disabled = !enabled || !selectedOnline || lastState?.mode === "ESTOP";
  for (const id of ["calRefBtn", "calDirBtn", "markMinBtn", "markMaxBtn"]) {
    const el = $(id);
    if (el) el.disabled = !enabled || !selectedOnline || torqueOnSelected || modeBlocked;
  }
  const state = lastState;
  const selIndex = selected - 1;
  const selValid = Boolean(cals[selIndex]?.valid);
  const selOnline = Boolean(state?.online & (1 << selIndex));
  const canTest = enabled && selValid && selOnline &&
    Boolean(state?.torque & (1 << selIndex)) &&
    Boolean(cals[selIndex] && cals[selIndex].minRaw <= cals[selIndex].maxRaw) &&
    rawInJoint(cals[selIndex], state?.raw?.[selIndex]) &&
    state?.mode !== "CAL" && state?.mode !== "FAULT" && state?.mode !== "ESTOP" &&
    Boolean(safeRange(cals[selIndex])) &&
    !testTimer;
  $("testMinBtn").disabled = !canTest;
  $("testMaxBtn").disabled = !canTest;
  for (const id of ["testQ", "testSpeed", "testGoBtn", "testStepUp", "testStepDown", "testSlider"]) {
    const el = $(id);
    if (el) el.disabled = !canTest;
  }
  $("testStopBtn").disabled = !testTimer;
  $("cmd").disabled = !enabled;
  $("sendBtn").disabled = !enabled;
  renderPose();
}

function selectJoint(id) {
  if (testTimer) stopTest("已切换关节，测试停止");
  if (poseTimer) stopPoseTest("已切换关节，整机测试停止");
  selected = Math.max(1, Math.min(3, id));
  const cal = cals[selected - 1];
  const raw = lastState?.raw?.[selected - 1];
  if (cal?.valid && Number.isFinite(raw)) {
    $("testQ").value = formatQ(rawToQ(cal, raw));
  }
  setWizard(`已选 ID${selected}。先确认在线，再卸力、记录参考姿态、方向、两个端点。`);
  render();
}

async function run(action) {
  if (busy || !connected) return;
  busy = true;
  updateButtons();
  try {
    await action();
  } catch (error) {
    const msg = error.message ?? String(error);
    appendLog("err", msg);
    const mode = lastState?.mode;
    setWizard(
      mode === "ESTOP"
        ? "现在是急停（ESTOP）：先点上方安全条的 CLEAR 解除，再继续保存/标定。CLEAR 不会让关节运动。"
        : mode === "FAULT"
          ? "现在是故障（FAULT）：先看状态条错误码排查，再点 CLEAR 解除。"
          : /ERR 11\b|bad_mode/.test(msg)
            ? "固件拒绝：模式不允许（ERR 11）。上电后要先点步骤 2 的「卸力」，固件收到明确的卸力指令才允许 CAL。"
            : /ERR 8\b|endpoints/.test(msg)
              ? "端点非法（ERR 8）：两端太近，或参考姿态离端点不足 40 tick。行程跨 0 时请在向导下方选保留一段（CAL SPLIT），另一段将不可达。"
              : `操作失败：${msg}`);
  } finally {
    busy = false;
    render();
    updateButtons();
  }
}

function setRailMsg(text, warn = false) {
  const el = $("railMsg");
  if (!el) return;
  el.textContent = text;
  el.classList.toggle("warn", warn);
}

async function doTorqueToggle(id) {
  if (busy || !connected) return;
  const index = id - 1;
  const on = !(lastState?.torque & (1 << index));
  const mode = lastState?.mode;
  if (mode === "ESTOP") {
    setRailMsg("急停锁存：先点「解除急停」再操作扭矩。", true);
    return;
  }
  if (!(lastState?.online & (1 << index))) {
    setRailMsg(`ID${id} 不在线。`, true);
    return;
  }
  if (on) {
    if (mode === "CAL") {
      setRailMsg("标定模式下不能上力：先 CAL SAVE 或 CAL CLEAR。", true);
      return;
    }
    if (mode === "FAULT") {
      setRailMsg("故障状态：先按错误码排查并 CLEAR。", true);
      return;
    }
    if (!cals[index]?.valid) {
      setRailMsg(`ID${id} 还没有有效标定。`, true);
      return;
    }
    if (!rawInsideSafe(index)) {
      setRailMsg(`ID${id} 当前 raw 在 safe 外：先扶住移回安全区再上力。`, true);
      return;
    }
  }
  if (testTimer) stopTest("已停止测试");
  busy = true;
  updateButtons();
  try {
    await request(torqueCommand(id, on), (p) => p.verb === "OK" && p.fields.torque === (on ? "on" : "off"));
    if (!on) unloaded[index] = true;
    await refreshAll();
    setRailMsg(`ID${id} ${on ? "已上力" : "已卸力"}。`);
    if (selected === id) {
      setWizard(on ? `ID${id} 已上力。切到「测试」低速试走。` : `ID${id} 已卸力。扶住手臂再移动。`);
    }
    setTestMsg(`ID${id} ${on ? "已上力" : "已卸力"}。`);
  } catch (error) {
    setRailMsg(`ID${id} ${on ? "上力" : "卸力"}失败：${error.message}`, true);
  } finally {
    busy = false;
    render();
    updateButtons();
  }
}

async function doTorqueOff() {
  if (busy || !connected) return;
  if (testTimer) stopTest("已停止测试");
  busy = true;
  updateButtons();
  try {
    await request(torqueCommand(selected, false), (p) => p.verb === "OK" && p.fields.torque === "off");
    unloaded[selected - 1] = true;
    await refreshAll();
    setRailMsg(`ID${selected} 已卸力（明确关力矩）。`);
    setWizard(`ID${selected} 已卸力。扶住手臂，移动到参考姿态，填 q 后点 CAL REF。`);
    setTestMsg(`ID${selected} 已卸力。`);
  } catch (error) {
    setRailMsg(`ID${selected} 卸力失败：${error.message}`, true);
  } finally {
    busy = false;
    render();
    updateButtons();
  }
}

async function doCalRef() {
  await run(async () => {
    const q = Number($("refQ").value);
    if (!Number.isFinite(q)) throw new Error("参考姿态 q 必须是数字");
    await request(calRefCommand(selected, q), (p) => isOk(p, "cal_ref"));
    await collectCal();
    setWizard(`ID${selected} 参考姿态已记录（q=${formatQ(q)}）。选方向后点 CAL DIR。`);
  });
}

async function doCalDir() {
  await run(async () => {
    const sign = Number($("dirSign").value);
    await request(calDirCommand(selected, sign), (p) => isOk(p, "cal_dir"));
    dirSet[selected - 1] = true;
    await collectCal();
    setWizard(`ID${selected} 方向已设为 ${sign > 0 ? "+1" : "-1"}。现在移到行程的任意一端，点「标记一端」。`);
  });
}

async function doMark(which) {
  await run(async () => {
    await request(calMarkCommand(selected, which), (p) => p.verb === "OK" && (p.args[0] === "cal_min" || p.args[0] === "cal_max"));
    await collectCal();
    await collectLimits();
    const cal = cals[selected - 1];
    if (cal && cal.hasMin && cal.hasMax && cal.minRaw > cal.maxRaw) {
      setWizard(`ID${selected} 的行程跨 0。默认角度模式不能跨 0，请在下方选保留哪一段，再点确认保存；接缝另一侧将不可达。`);
    } else {
      setWizard(`ID${selected} 已记录${which === "MIN" ? "一端" : "另一端"}。${which === "MIN" ? "再移到行程的另一端，点「标记另一端」。两端顺序随意。" : "检查安全区后，点下方「CAL SAVE · 保存当前关节」。Z 在允许行程外时固件会选补弧，能保存但不可用。"}`);
    }
  });
}

async function doSplitConfirm() {
  const side = $("splitLow").checked ? "LOW" : "HIGH";
  await run(async () => {
    // A stored calibration can show the split box right after boot, when the
    // firmware has not yet seen a TORQUE OFF this session. Send it explicitly
    // so CAL SPLIT is allowed (and the arm is unloaded before saving).
    await request(torqueCommand(selected, false), (p) => p.verb === "OK" && p.fields.torque === "off");
    unloaded[selected - 1] = true;
    await request(calSplitCommand(selected, side), (p) => isOk(p, "cal_split"));
    await collectCal();
    await request(commands.calSave, (p) => isOk(p, "cal_saved"));
    await refreshAll();
    const kept = cals[selected - 1];
    setWizard(`ID${selected} 已保留 raw ${kept.minRaw}..${kept.maxRaw} 并保存；接缝另一侧不可达，接缝端不是机械端点。`);
  });
}

async function doCalSave() {
  await run(async () => {
    await request(commands.calSave, (p) => isOk(p, "cal_saved"));
    await refreshAll();
    setWizard(calComplete(cals)
      ? "标定已保存，三关节有效；现在可以 TORQUE ON。"
      : "标定已保存，但还有关节未完整；继续标定其他关节。");
  });
}

// Two-step confirm inside the page instead of window.confirm(): browsers silently
// return false once dialogs are suppressed, which made the button look dead.
let clearArmed = false;
let clearArmTimer = 0;

function disarmCalClear() {
  clearArmed = false;
  clearTimeout(clearArmTimer);
  const el = $("calClearBtn");
  if (!el) return;
  el.textContent = "清除全部标定（CAL CLEAR all）";
  el.classList.remove("armed");
}

async function doCalClear() {
  if (!clearArmed) {
    clearArmed = true;
    const el = $("calClearBtn");
    if (el) {
      el.textContent = "再点一次确认：清除三关节标定";
      el.classList.add("armed");
    }
    appendLog("sys", "确认中：5 秒内再点一次才会发 CAL CLEAR all");
    setWizard("再点一次「清除全部标定」才会真的执行；清完三个关节都要重标，POSE 会被拒绝。");
    clearArmTimer = setTimeout(disarmCalClear, 5000);
    return;
  }
  disarmCalClear();
  appendLog("sys", "发送 CAL CLEAR all");
  await run(async () => {
    await request(calClearCommand(0), (p) => isOk(p, "cal_cleared"));
    unloaded = [false, false, false];
    dirSet = [false, false, false];
    await refreshAll();
    setPanel("calibrate");
    appendLog("sys", "固件已确认清除：三关节 valid=0，需要重新标定");
    setWizard("标定已清除；需要重新标定三个关节。");
  });
}

async function doStop() {
  if (testTimer) stopTest("已停止");
  if (poseTimer) stopPoseTest("已停止");
  await run(async () => {
    await request(commands.stop, (p) => isOk(p, "stop"));
    await refreshAll();
    setWizard("已 STOP：原地停住，可继续操作。");
  });
}

async function doEstop() {
  if (testTimer) stopTest();
  if (poseTimer) stopPoseTest();
  await run(async () => {
    await request(commands.estop, (p) => isOk(p, "estop"));
    await refreshAll();
    setWizard("已 ESTOP（锁存）。检查现场后点 CLEAR。");
  });
}

async function doClear() {
  await run(async () => {
    await request(commands.clear, (p) => isOk(p, "clear") || isOk(p, "cleared"));
    await refreshAll();
    setWizard("已 CLEAR；若仍有离线舵机，POSE 仍会被拒绝。");
  });
}

function testGateInfo() {
  const state = lastState;
  const index = selected - 1;
  const cal = cals[index];
  if (!state) return { ok: false, text: "还没有收到板子状态。" };
  if (!(state.online & (1 << index))) {
    return { ok: false, text: `ID${selected} 不在线：查 12V、3P 线和 ID。` };
  }
  if (cal && cal.hasMin && cal.hasMax && cal.minRaw > cal.maxRaw) {
    return { ok: false, text: `ID${selected} 的行程跨 0 且还没选保留段：回「标定」页，在向导下方选一段并保存。` };
  }
  if (!cal?.valid) {
    return { ok: false, text: `ID${selected} 还没有有效标定：回「标定」页完成并保存。` };
  }
  const raw = state.raw?.[index];
  if (Number.isFinite(raw) && !rawInJoint(cal, raw)) {
    return { ok: false, text: `ID${selected} 当前 raw ${raw} 在标定行程外：先卸力，把手臂推回行程内，再上力。` };
  }
  if (state.mode === "CAL") {
    return { ok: false, text: "当前在标定模式：先「CAL SAVE」保存，才能测试。" };
  }
  if (state.mode === "FAULT" || state.mode === "ESTOP") {
    return { ok: false, text: `当前是 ${state.mode}：先按错误码排查并 CLEAR。` };
  }
  if (!(state.torque & (1 << index))) {
    return { ok: false, text: `ID${selected} 还没上力：点左侧卡片底部的「上力」。` };
  }
  if (!safeRange(cal)) {
    return { ok: false, text: "安全区未就绪：检查两个端点和 margin。" };
  }
  return { ok: true, text: `ID${selected} 已就绪：可以点下面的按钮试走。` };
}

function testReady() {
  const state = lastState;
  const cal = cals[selected - 1];
  const range = safeRange(cal);
  if (!state || !cal?.valid || !(state.online & (1 << (selected - 1))) ||
      !(state.torque & (1 << (selected - 1))) || !range) {
    setTestMsg("这个关节需要在线、标定有效、已上力，才能测试。");
    return null;
  }
  const raw = state.raw?.[selected - 1];
  if (!Number.isFinite(raw) || !rawInJoint(cal, raw)) {
    setTestMsg(`ID${selected} 当前 raw ${Number.isFinite(raw) ? raw : "—"} 在标定行程外：先卸力，把手臂推回行程内，再上力。`);
    return null;
  }
  if (state.mode === "CAL" || state.mode === "FAULT" || state.mode === "ESTOP") {
    setTestMsg(`当前模式 ${state.mode}，不能运动。先保存标定 / 解除急停。`);
    return null;
  }
  return range;
}

function testSpeedValue() {
  const value = Number($("testSpeed").value);
  return Number.isFinite(value) ? Math.max(1, Math.min(52, value)) : 10;
}

const TEST_INSET_DEG = 10;
const POSE_INSET_DEG = 10;

// The test targets stay 10 degrees inside the safe edges: the shoulder can sag
// past a target placed on the edge under gravity and leave the calibrated
// travel. Keep the full safe range for LIMITS; this inset is test-only.
function testQRange(cal) {
  const safe = safeQRange(cal);
  if (!safe) return null;
  const min = safe.min + TEST_INSET_DEG;
  const max = safe.max - TEST_INSET_DEG;
  return min <= max ? { min, max } : null;
}

function startTestRaw(targetRaw, label) {
  if (testTimer) return;
  if (poseTimer) {
    setTestMsg("整机测试运行中：先停止整机测试，再做单关节测试。");
    return;
  }
  const range = testReady();
  if (!range) return;
  const speed = testSpeedValue();
  if (!Number.isFinite(targetRaw) || !rawInSafe(range, targetRaw)) {
    setTestMsg(`目标 raw ${targetRaw} 不在 ${safeLabel(range)} 内，已拒绝。`);
    return;
  }
  // JOG q is sent with 0.1 deg precision (~0.57 raw), so keep one raw tick
  // inside the safe edge; otherwise rounding can land 1 tick outside and the
  // firmware correctly rejects it with ERR 10.
  const safeSpan = range.wrap
    ? 4096 - range.min + range.max
    : range.max - range.min;
  const distance = ((Math.round(targetRaw) - range.min) % 4096 + 4096) % 4096;
  const clamped = Math.min(Math.max(distance, 1), Math.max(1, safeSpan - 1));
  targetRaw = (range.min + clamped) % 4096;
  lastErr = null;
  testTarget = { index: selected - 1, raw: targetRaw, label, speed };
  testNear = 0;
  const distanceTicks = rawDistance(lastState?.raw?.[selected - 1] ?? targetRaw, targetRaw);
  const travelMs = (distanceTicks / (speed * TICKS_PER_DEGREE)) * 1000;
  testDeadline = Date.now() + Math.max(8000, travelMs * 2 + 3000);
  setTestMsg(`ID${selected} 正以 ${speed}°/s 去${label}（raw ${targetRaw}）…`);
  testTimer = setInterval(testTick, 100);
  updateButtons();
}

function startTest(which) {
  const range = testReady();
  if (!range) return;
  // Gravity-loaded joints (the shoulder) can sag past a target placed on the
  // safe edge. Leave TEST_INSET_DEG of room so the settle stays inside the safe
  // range, not just inside the travel.
  const inset = Math.round(TEST_INSET_DEG * TICKS_PER_DEGREE);
  const safeSpan = range.wrap
    ? 4096 - range.min + range.max
    : range.max - range.min;
  const step = Math.min(inset, Math.max(1, Math.floor((safeSpan - 2) / 2)));
  startTestRaw(
    which === "MIN" ? offsetRaw(range.min, step) : offsetRaw(range.max, -step),
    ` safe ${which} 内侧 ${TEST_INSET_DEG}°`
  );
}

function startTestQ(q, label) {
  const cal = cals[selected - 1];
  const qRange = testQRange(cal);
  if (!qRange) {
    setTestMsg("安全区太窄，无法留出 5° 测试余量。");
    return;
  }
  if (q < qRange.min - 1e-6 || q > qRange.max + 1e-6) {
    setTestMsg(`测试目标需离安全边界至少 ${TEST_INSET_DEG}°（允许 ${formatQ(qRange.min)}°..${formatQ(qRange.max)}°），已拒绝。`);
    return;
  }
  const raw = qToRaw(cal, q);
  if (raw === null) {
    setTestMsg("目标角度无效：这个关节标定不完整。");
    return;
  }
  startTestRaw(raw, label ?? ` q ${formatQ(q)}°`);
}

function testStep(delta) {
  const cal = cals[selected - 1];
  const qAllow = testQRange(cal);
  const raw = lastState?.raw?.[selected - 1];
  if (!qAllow || !Number.isFinite(raw) || !rawInJoint(cal, raw)) {
    setTestMsg("这个关节当前不在标定行程内，不能步进测试。");
    return;
  }
  const current = rawToQ(cal, raw);
  const lo = qAllow.min;
  const hi = qAllow.max;
  const target = Math.min(Math.max(current + delta, lo), hi);
  $("testQ").value = formatQ(target);
  startTestQ(target, ` q ${formatQ(target)}°`);
}

function testTick() {
  if (!connected || !lastState || !testTarget) {
    stopTest("连接/状态丢失");
    return;
  }
  if (Date.now() > testDeadline) {
    stopTest("超时，已 STOP");
    return;
  }
  // Do not gate on lastErr here: STATE.err is sticky (it reports the last
  // error ever seen), and a stale value would abort every new test.
  const q = rawToQ(cals[testTarget.index], testTarget.raw);
  if (q === null) {
    stopTest("当前关节标定无效，已 STOP");
    return;
  }
  try {
    sendRaw(jogCommand(seq++, testTarget.index + 1, q, testTarget.speed ?? 10, 20), false);
  } catch (error) {
    stopTest(`发送失败：${error.message}`);
    return;
  }
  const raw = lastState.raw?.[testTarget.index];
  if (Number.isFinite(raw) && rawDistance(raw, testTarget.raw) <= 8) {
    testNear++;
  } else {
    testNear = 0;
  }
  if (testNear >= 3) {
    stopTest(`ID${testTarget.index + 1} 已到 raw ${raw}，已 STOP`);
  }
}

function stopTest(message = "") {
  const index = testTarget?.index;
  if (testTimer) {
    clearInterval(testTimer);
    testTimer = null;
  }
  testTarget = null;
  testNear = 0;
  // Safety stop: the firmware writes the present pose back as the target for
  // every online joint, so the tested joint cannot keep running to a stale
  // target. The test's JOG commands themselves only touch the selected joint.
  if (connected) {
    try { sendRaw(commands.stop); } catch {}
  }
  if (message) {
    const raw = index !== undefined ? lastState?.raw?.[index] : null;
    const cal = index !== undefined ? cals[index] : null;
    if (cal?.valid && Number.isFinite(raw) && rawInJoint(cal, raw)) {
      const current = rawToQ(cal, raw);
      setTestMsg(`${message}（现在 q ${formatQ(current)}°）`);
      $("testQ").value = formatQ(current);
    } else if (cal?.valid && Number.isFinite(raw)) {
      setTestMsg(`${message}（当前 raw ${raw} 在标定行程外）`);
    } else {
      setTestMsg(message);
    }
  }
  updateButtons();
}

function setPoseMsg(text) {
  const el = $("poseMsg");
  if (el) el.textContent = text;
}

function poseSpeedValue() {
  const value = Number($("poseSpeed")?.value);
  return Number.isFinite(value) ? Math.max(1, Math.min(52, value)) : 10;
}

function poseQList() {
  return [0, 1, 2].map((i) => {
    const cal = cals[i];
    const raw = lastState?.raw?.[i];
    return cal?.valid && Number.isFinite(raw) && rawInJoint(cal, raw)
      ? rawToQ(cal, raw)
      : null;
  });
}

function buildPosePlan() {
  if (!cals.every((cal) => cal?.valid)) {
    return { ok: false, text: "还有关节没有有效标定：先在「标定」页完成三颗并保存。" };
  }
  const ref = cals.map((cal) => cal.zeroQ);
  const plan = [{ target: ref.slice(), label: "回参考姿态" }];
  for (let i = 0; i < 3; i++) {
    const range = safeQRange(cals[i]);
    if (!range) return { ok: false, text: `ID${i + 1} 的安全区未就绪。` };
    if (ref[i] < range.min - 1e-6 || ref[i] > range.max + 1e-6) {
      return { ok: false, text: `ID${i + 1} 的参考姿态 q ${formatQ(ref[i])}° 不在允许范围 ${formatQ(range.min)}°..${formatQ(range.max)}°。` };
    }
    if (range.max - range.min <= 2 * POSE_INSET_DEG) {
      return { ok: false, text: `ID${i + 1} 的 safe 区间太窄，留不出 ${POSE_INSET_DEG}° 测试余量。` };
    }
    const lo = range.min + POSE_INSET_DEG;
    const hi = range.max - POSE_INSET_DEG;
    const toMin = ref.slice();
    toMin[i] = lo;
    plan.push({ target: toMin, label: `ID${i + 1} → safe MIN 内侧 ${POSE_INSET_DEG}°` });
    const toMax = ref.slice();
    toMax[i] = hi;
    plan.push({ target: toMax, label: `ID${i + 1} → safe MAX 内侧 ${POSE_INSET_DEG}°` });
    plan.push({ target: ref.slice(), label: "回参考姿态" });
  }
  return { ok: true, ref, plan };
}

function poseGateInfo() {
  const state = lastState;
  if (!connected) return { ok: false, text: "先连接串口。" };
  if (!state) return { ok: false, text: "还没有收到板子状态。" };
  if (state.mode === "CAL") return { ok: false, text: "当前在标定模式：先 CAL SAVE 或 CAL CLEAR。" };
  if (state.mode === "FAULT" || state.mode === "ESTOP") {
    return { ok: false, text: `当前是 ${state.mode}：先按错误码排查并 CLEAR。` };
  }
  if (state.mode === "MOTION" && !poseTimer) {
    return { ok: false, text: "正在运动：先按停止，再开始整机测试。" };
  }
  if ((state.online & 7) !== 7) return { ok: false, text: "三颗没有全部在线：查 12V、3P 线和 ID。" };
  if ((state.cal & 7) !== 7) return { ok: false, text: "还有关节没有有效标定：先在「标定」页完成三颗并保存。" };
  if ((state.torque & 7) !== 7) return { ok: false, text: "还有关节没上力：三颗都点「上力」后再做整机测试。" };
  const built = buildPosePlan();
  if (!built.ok) return built;
  for (let i = 0; i < 3; i++) {
    const raw = state.raw?.[i];
    const safe = safeRange(cals[i]);
    if (!Number.isFinite(raw) || !rawInSafe(safe, raw)) {
      return { ok: false, text: `ID${i + 1} 当前 raw ${Number.isFinite(raw) ? raw : "—"} 不在 ${safeLabel(safe)} 内：先卸力推回，再上力。` };
    }
  }
  return {
    ok: true,
    ...built,
    text: `三关节已就绪：将以 ${poseSpeedValue()}°/s 跑 ${built.plan.length} 步（每关节扫到 safe 两端，各内缩 ${POSE_INSET_DEG}°）。`,
  };
}

function renderPose() {
  if (!$("poseGate")) return;
  const gate = poseGateInfo();
  $("poseGate").textContent = poseTimer ? "整机测试运行中…" : gate.text;
  const safeText = [0, 1, 2].map((i) => {
    const q = safeQRange(cals[i]);
    return q ? `ID${i + 1} ${formatQ(q.min)}..${formatQ(q.max)}°` : `ID${i + 1} —`;
  }).join(" · ");
  $("poseSafe").textContent = `允许 q：${safeText}`;
  const qs = poseQList();
  $("poseQNow").textContent = `q ${qs.map((q) => (q === null ? "—" : formatQ(q))).join(", ")}`;
  const step = posePlan?.[poseStep];
  const idleTarget = gate.plan?.[0]?.target;
  $("poseTargetLabel").textContent = step
    ? `第 ${poseStep + 1}/${posePlan.length} 步 · 目标 q ${step.target.map(formatQ).join(", ")}`
    : idleTarget
      ? `参考姿态 q ${idleTarget.map(formatQ).join(", ")}`
      : "目标 q —";
  $("poseGoBtn").disabled = !gate.ok || Boolean(poseTimer) || Boolean(testTimer) || busy;
  $("poseStopBtn").disabled = !poseTimer;
  $("poseSpeed").disabled = Boolean(poseTimer) || !gate.ok;
}

function poseBeginStep(index) {
  poseStep = index;
  const step = posePlan[index];
  poseTarget = step.target.slice();
  posePhase = "move";
  const qs = poseQList();
  const distance = Math.max(...qs.map((q, i) => (q === null ? 180 : Math.abs(q - poseTarget[i]))));
  poseDeadline = Date.now() + Math.max(5000, (distance / poseSpeedValue()) * 1000 * 1.8 + 3000);
  setPoseMsg(`第 ${index + 1}/${posePlan.length} 步：${step.label}…`);
}

function advancePoseStep() {
  if (poseStep + 1 >= posePlan.length) {
    stopPoseTest(`整机测试完成：${posePlan.length} 步全部到位，已回参考姿态并 STOP`);
    return false;
  }
  poseBeginStep(poseStep + 1);
  return true;
}

function startPoseTest() {
  if (poseTimer || testTimer || busy || !connected) return;
  const gate = poseGateInfo();
  if (!gate.ok) {
    setPoseMsg(gate.text);
    return;
  }
  posePlan = gate.plan;
  poseStep = 0;
  posePhase = "move";
  lastErr = null;
  poseBeginStep(0);
  poseTimer = setInterval(poseTick, 100);
  poseTick();
  updateButtons();
}

function poseTick() {
  if (!connected || !posePlan || !poseTarget || !lastState) {
    stopPoseTest("连接/状态丢失，已 STOP");
    return;
  }
  if (lastState.mode === "FAULT" || lastState.mode === "ESTOP" || lastState.mode === "CAL") {
    stopPoseTest(`当前 ${lastState.mode}，已 STOP`);
    return;
  }
  if (posePhase === "dwell" && Date.now() >= poseDwellUntil) {
    if (!advancePoseStep()) return;
  }
  try {
    // POSE is a streaming command: the firmware faults after 300 ms without a
    // new one, so keep resending at 10 Hz until the step is reached.
    sendRaw(poseCommand(seq++, poseTarget, poseSpeedValue(), 20), false);
  } catch (error) {
    stopPoseTest(`发送失败：${error.message}`);
    return;
  }
  const qs = poseQList();
  const err = Math.max(...qs.map((q, i) => (q === null ? 99 : Math.abs(q - poseTarget[i]))));
  if (err <= 1.5) {
    if (posePhase === "move") {
      posePhase = "dwell";
      poseDwellUntil = Date.now() + 500;
      setPoseMsg(`第 ${poseStep + 1}/${posePlan.length} 步：${posePlan[poseStep].label} 已到位，停留 0.5s`);
    }
    return;
  }
  if (Date.now() > poseDeadline) {
    stopPoseTest(`第 ${poseStep + 1} 步超时，已 STOP`);
    return;
  }
  setPoseMsg(`第 ${poseStep + 1}/${posePlan.length} 步：${posePlan[poseStep].label} · 最大偏差 ${formatQ(err)}°`);
}

function stopPoseTest(message = "") {
  if (poseTimer) {
    clearInterval(poseTimer);
    poseTimer = null;
  }
  const wasRunning = Boolean(posePlan);
  posePlan = null;
  poseStep = 0;
  posePhase = "move";
  poseDwellUntil = 0;
  poseTarget = null;
  if (connected && wasRunning) {
    try { sendRaw(commands.stop, false); } catch {}
  }
  if (message) {
    setPoseMsg(message);
    appendLog("sys", message);
  }
  updateButtons();
  renderPose();
}

function setRawMsg(text, holdMs = 0) {
  const el = $("rawMsg");
  if (el) el.textContent = text;
  rawMsgUntil = holdMs ? Date.now() + holdMs : 0;
}

function singleServoInfo() {
  const state = lastState;
  if (!connected) return { ok: false, text: "先连接串口。" };
  if (!state) return { ok: false, text: "还没有收到板子状态。" };
  const mask = state.online & 7;
  if (mask === 0) return { ok: false, text: "读不到舵机：检查 12V 和接线。" };
  if ((mask & (mask - 1)) !== 0) {
    return { ok: false, text: `总线上有 ${maskCount(mask)} 颗舵机：安装定位只允许接一颗。` };
  }
  const index = [0, 1, 2].find((i) => mask & (1 << i));
  const cal = cals[index];
  const hasRecord = Boolean(cal?.ref || cal?.hasMin || cal?.hasMax);
  const torqueOn = Boolean(state.torque & (1 << index));
  const modeOk = !["CAL", "MOTION", "FAULT", "ESTOP"].includes(state.mode);
  return {
    ok: true, id: index + 1, index, cal, hasRecord, torqueOn, modeOk,
    raw: state.raw?.[index],
  };
}

function renderRawMove() {
  if (!$("rawNow")) return;
  const info = singleServoInfo();
  const onlineCount = maskCount(lastState?.online ?? 0);
  $("rawNow").textContent = info.ok && Number.isFinite(info.raw) ? `raw ${info.raw}` : "raw —";
  $("rawHint").textContent = !info.ok
    ? info.text
    : `ID${info.id} · ${info.hasRecord ? "已有标定记录" : "未标定"} · 扭矩${info.torqueOn ? "开" : "关"}`;
  const editable = info.ok && info.modeOk && !info.hasRecord;
  $("rawTarget").disabled = !editable;
  $("rawSpeed").disabled = !editable;
  $("rawGoBtn").disabled = !editable || !info.torqueOn || busy;
  $("rawCenterBtn").disabled = !editable || !info.torqueOn || busy;
  $("rawTorqueOn").disabled = !info.ok || info.torqueOn || !info.modeOk || busy;
  $("rawTorqueOff").disabled = !info.ok || !info.torqueOn || busy;
  if (info.ok && Date.now() > rawMsgUntil) {
    if (info.hasRecord && info.modeOk) {
      setRawMsg(`ID${info.id} 已有标定记录：先去「标定」页 CAL CLEAR，或用「测试」页 JOG。`);
    } else if (!info.modeOk) {
      setRawMsg(`当前模式 ${lastState?.mode}，不能做安装定位。`);
    } else if (info.torqueOn) {
      setRawMsg("可以输入目标 raw；上力后舵机会保持当前位置，再走目标。");
    } else {
      setRawMsg("先点「上力」，固件会把目标设为当前位姿，避免上力瞬间跳动。");
    }
  }
  if (!info.ok && onlineCount !== 1) rawMsgUntil = 0;
}

async function doRawTorque(on) {
  const info = singleServoInfo();
  if (!info.ok) {
    setRawMsg(info.text, 4000);
    return;
  }
  await run(async () => {
    await request(torqueCommand(info.id, on),
      (p) => p.verb === "OK" && p.fields.torque === (on ? "on" : "off"));
    await refreshAll();
    setRawMsg(on
      ? `ID${info.id} 已上力；目标已先设为当前 raw ${info.raw}。输入目标后点「去这个 raw」。`
      : `ID${info.id} 已卸力（不断电），可以手动转动。`, 4000);
  });
}

async function doRawMove(targetRaw) {
  const info = singleServoInfo();
  if (!info.ok) {
    setRawMsg(info.text, 4000);
    return;
  }
  if (info.hasRecord) {
    setRawMsg(`ID${info.id} 已有标定记录：先去「标定」页 CAL CLEAR，或用「测试」页 JOG。`, 4000);
    return;
  }
  if (!info.torqueOn) {
    setRawMsg(`ID${info.id} 还没上力：先点「上力」。`, 4000);
    return;
  }
  const value = Number(targetRaw ?? $("rawTarget").value);
  if (!Number.isInteger(value) || value < 0 || value > 4095) {
    setRawMsg("目标 raw 必须是 0..4095 的整数。", 4000);
    return;
  }
  const speed = Number($("rawSpeed").value);
  await run(async () => {
    await request(rawMoveCommand(info.id, value, speed, 20), (p) => isOk(p, "raw"));
    setRawMsg(`ID${info.id} 正以 ${speed}°/s 去 raw ${value}…（没有 safe 范围保护）`, 4000);
  });
}

async function doIdRead() {
  if (busy || !connected) return;
  busy = true;
  updateButtons();
  try {
    const reply = await request(idGetCommand, (p) => p.verb === "ID", 1500);
    const value = Number(reply.fields.value);
    $("idMsg").textContent = Number.isFinite(value)
      ? `当前舵机 ID = ${value}。要改就选下面的目标 ID。`
      : `读取返回异常：${reply.text}`;
  } catch (error) {
    $("idMsg").textContent = `读取失败：${error.message ?? error}`;
  } finally {
    busy = false;
    render();
  }
}

async function doIdSet(n) {
  if (busy || !connected) return;
  busy = true;
  updateButtons();
  try {
    $("idMsg").textContent = `正在写入 ID${n}…`;
    await request(idSetCommand(n),
      (p) => p.verb === "OK" && p.fields.id_set === String(n), 3000);
    await refreshAll();
    selectJoint(n);
    $("idMsg").textContent = `已设为 ID${n}，并读回验证通过。贴好标签再换下一颗。`;
  } catch (error) {
    $("idMsg").textContent = `写入失败：${error.message ?? error}`;
  } finally {
    busy = false;
    render();
  }
}

async function doRefresh() {
  await run(async () => {
    setDetectMsg("正在刷新…");
    await refreshAll();
    setDetectMsg(`已刷新 · ${nowStamp()}`);
    setWizard("状态、标定、限位已刷新。");
  });
}

function setPanel(name) {
  for (const tab of document.querySelectorAll("#calTabs [data-panel]")) {
    const active = tab.dataset.panel === name;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", active ? "true" : "false");
  }
  for (const panel of ["calibrate", "inspect", "test", "assign"]) {
    const el = $(`panel-${panel}`);
    if (el) el.hidden = panel !== name;
  }
  if (name === "inspect") {
    if (!connected) {
      setDetectMsg("未连接：先点上方「连接串口」，这里才有数据。");
    } else if (!busy) {
      setDetectMsg("正在刷新…");
      refreshAll()
        .then(() => setDetectMsg(`已刷新 · ${nowStamp()}`))
        .catch((error) => setDetectMsg(`刷新失败：${error.message ?? error}`));
    }
  }
}

function bind() {
  for (const card of document.querySelectorAll(".joint-card")) {
    const pick = card.querySelector(".joint-pick");
    pick?.addEventListener("click", () => selectJoint(Number(card.dataset.id)));
    pick?.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        selectJoint(Number(card.dataset.id));
      }
    });
  }
  for (const btn of document.querySelectorAll("[data-torque]")) {
    btn.addEventListener("click", () => doTorqueToggle(Number(btn.dataset.torque)));
  }
  for (const tab of document.querySelectorAll("#calTabs [data-panel]")) {
    tab.addEventListener("click", () => setPanel(tab.dataset.panel));
  }
  $("connectBtn").addEventListener("click", connect);
  $("disconnectBtn").addEventListener("click", () => disconnect(true));
  $("torqueOffBtn").addEventListener("click", doTorqueOff);
  $("calRefBtn").addEventListener("click", doCalRef);
  $("calDirBtn").addEventListener("click", doCalDir);
  $("markMinBtn").addEventListener("click", () => doMark("MIN"));
  $("markMaxBtn").addEventListener("click", () => doMark("MAX"));
  $("calSaveBtn").addEventListener("click", doCalSave);
  $("splitConfirmBtn").addEventListener("click", doSplitConfirm);
  $("calClearBtn")?.addEventListener("click", doCalClear);
  $("idReadBtn").addEventListener("click", doIdRead);
  $("rawGoBtn").addEventListener("click", () => doRawMove());
  $("rawCenterBtn").addEventListener("click", () => {
    $("rawTarget").value = "2048";
    doRawMove(2048);
  });
  $("rawTorqueOn").addEventListener("click", () => doRawTorque(true));
  $("rawTorqueOff").addEventListener("click", () => doRawTorque(false));
  for (const n of [1, 2, 3]) {
    $("idSet" + n).addEventListener("click", () => doIdSet(n));
  }
  $("refreshBtn").addEventListener("click", doRefresh);
  $("readCalBtn").addEventListener("click", () => run(async () => {
    await collectCal();
    setDetectMsg(`已读标定 · ${nowStamp()}：${cals.filter((cal) => cal?.valid).length}/3 有效`);
  }));
  $("readLimitsBtn").addEventListener("click", () => run(async () => {
    await collectLimits();
    setDetectMsg(`已读限位 · ${nowStamp()}：${limits.filter((limit) => limit?.valid).length}/3 有效`);
  }));
  $("stopBtn").addEventListener("click", doStop);
  $("estopBtn").addEventListener("click", doEstop);
  $("clearBtn").addEventListener("click", doClear);
  $("testMinBtn").addEventListener("click", () => startTest("MIN"));
  $("testMaxBtn").addEventListener("click", () => startTest("MAX"));
  $("testGoBtn").addEventListener("click", () => {
    const q = Number($("testQ").value);
    if (!Number.isFinite(q)) {
      setTestMsg("目标 q 必须是数字。");
      return;
    }
    startTestQ(q);
  });
  $("testStepUp").addEventListener("click", () => testStep(5));
  $("testStepDown").addEventListener("click", () => testStep(-5));
  $("poseGoBtn").addEventListener("click", startPoseTest);
  $("poseStopBtn").addEventListener("click", () => stopPoseTest("已停止整机测试"));
  $("testSlider").addEventListener("input", () => {
    $("testQ").value = $("testSlider").value;
  });
  $("testSlider").addEventListener("change", () => {
    const q = Number($("testSlider").value);
    if (Number.isFinite(q)) startTestQ(q);
  });
  $("testStopBtn").addEventListener("click", () => stopTest("已停止测试"));
  $("clearLog").addEventListener("click", () => { logLines = []; renderLog(); });
  $("sendForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const command = $("cmd").value.trim();
    if (!command || !connected) return;
    try { sendRaw(command); } catch (error) { appendLog("err", error.message); }
    $("cmd").value = "";
  });
  for (const chip of document.querySelectorAll(".chip[data-cmd]")) {
    chip.addEventListener("click", () => {
      if (!connected) return;
      try { sendRaw(chip.dataset.cmd); } catch (error) { appendLog("err", error.message); }
    });
  }
  window.addEventListener("beforeunload", () => { try { transport?.close(); } catch {} });
}

class MockLink {
  constructor(emit) {
    this.emit = emit;
    this.stream = false;
    this.state = {
      mode: "UNCAL",
      online: 7,
      torque: 0,
      err: 0,
      raw: [2048, 2048, 2048],
      target: [null, null, null],
      load: [100, 100, 100],
      cur: [20, 20, 20],
      temp: [27, 27, 27],
      v: 120,
      lastPose: 0,
    };
    this.cals = [1, 2, 3].map((id) => ({
      id,
      ref: 0,
      hasMin: 0,
      hasMax: 0,
      zeroRaw: 2048,
      zeroQ: 0,
      sign: 1,
      minRaw: 0,
      maxRaw: 4095,
      margin: 40,
      valid: false,
    }));
    this.timer = setInterval(() => this.tick(), 100);
  }

  close() { clearInterval(this.timer); }

  write(text) {
    for (const line of String(text).split(/\r?\n/)) {
      if (line.trim()) this.handle(line.trim());
    }
  }

  emitLine(line) { this.emit(`${line}\n`); }

  calMask() {
    return this.cals.reduce((mask, cal, i) => mask | (cal.valid ? 1 << i : 0), 0);
  }

  emitState() {
    const q = this.cals.map((cal, i) => (cal.valid ? rawToQ(cal, this.state.raw[i]) : 0));
    this.emitLine(
      `STATE seq=1 mode=${this.state.mode} online=${this.state.online} cal=${this.calMask()} torque=${this.state.torque} ` +
      `err=${this.state.err} age=0 q=${q.map((v) => formatQ(v)).join(",")} ` +
      `raw=${this.state.raw.join(",")} load=${this.state.load.join(",")} ` +
      `cur=${this.state.cur.join(",")} v=${this.state.v} t=${this.state.temp.join(",")}`
    );
  }

  ok(args) { this.emitLine(`OK ${args}`); }
  err(code, joint = 0) { this.state.err = code; this.emitLine(`ERR code=${code} seq=0 joint=${joint} msg=${ERROR_LABELS[code] ?? "error"}`); }

  geomValid(cal) {
    const span = ((cal.maxRaw - cal.minRaw) % 4096 + 4096) % 4096;
    const zeroOnArc = ((cal.zeroRaw - cal.minRaw) % 4096 + 4096) % 4096;
    return Boolean(cal.ref && cal.hasMin && cal.hasMax && cal.minRaw !== cal.maxRaw &&
      span > 2 * cal.margin && zeroOnArc >= cal.margin && zeroOnArc <= span - cal.margin);
  }

  validCal(cal) {
    return this.geomValid(cal) && cal.minRaw <= cal.maxRaw;
  }

  orient(cal) {
    if (!cal.ref || !cal.hasMin || !cal.hasMax || cal.minRaw === cal.maxRaw) return;
    const span = ((cal.maxRaw - cal.minRaw) % 4096 + 4096) % 4096;
    const zeroOnArc = ((cal.zeroRaw - cal.minRaw) % 4096 + 4096) % 4096;
    if (zeroOnArc > span) {
      const start = cal.minRaw;
      cal.minRaw = cal.maxRaw;
      cal.maxRaw = start;
    }
  }

  tick() {
    const now = Date.now();
    for (let i = 0; i < 3; i++) {
      const target = this.state.target[i];
      if (target === null) continue;
      const delta = target - this.state.raw[i];
      if (Math.abs(delta) <= 4) {
        this.state.raw[i] = target;
        this.state.target[i] = null;
      } else {
        this.state.raw[i] += Math.sign(delta) * 8;
      }
    }
    if (this.state.mode === "MOTION" && now - this.state.lastPose > 300) {
      this.state.mode = "READY";
      this.state.err = 17;
      this.err(17);
    }
    if (this.stream || this.state.mode === "MOTION") this.emitState();
  }

  handle(line) {
    const p = parseLine(line);
    if (!p) return;
    const args = p.args;
    if (p.verb === "HELLO") {
      this.emitLine("HELLO protocol=1 fw=0.1.0-mock cal=1 features=state,stream,motion,jog,raw,cal,limits,split");
    } else if (p.verb === "STATE") {
      this.emitState();
    } else if (p.verb === "STREAM") {
      this.stream = args[0]?.toUpperCase() === "ON";
      this.ok(`stream=${this.stream ? "on" : "off"}`);
    } else if (p.verb === "TORQUE") {
      const id = args[0] === "all" ? 0 : Number(args[0]);
      const on = args[1]?.toUpperCase() === "ON";
      if (this.state.mode === "ESTOP" || (on && (this.state.mode === "FAULT" || this.state.mode === "CAL"))) {
        this.err(11, id);
        return;
      }
      const bit = id === 0 ? 7 : 1 << (id - 1);
      if (on) this.state.torque |= bit; else this.state.torque &= ~bit;
      if (!on && this.state.mode === "MOTION") this.state.mode = "READY";
      this.ok(`torque=${on ? "on" : "off"}`);
      this.emitState();
    } else if (p.verb === "CAL") {
      this.handleCal(args);
    } else if (p.verb === "LIMITS") {
      for (const cal of this.cals) {
        const safe = safeRange(cal) ?? { min: 0, max: 0 };
        this.emitLine(
          `LIMITS id=${cal.id} min=${cal.minRaw} max=${cal.maxRaw} ` +
          `safe=${safe.min}..${safe.max} valid=${cal.valid ? 1 : 0}`
        );
      }
      this.ok("limits");
    } else if (p.verb === "POSE") {
      this.handlePose(p);
    } else if (p.verb === "JOG") {
      this.handleJog(p);
    } else if (p.verb === "RAW") {
      const id = Number(p.fields.id);
      const raw = Number(p.fields.raw);
      const mask = this.state.online & 7;
      if (!id || id < 1 || id > 3) {
        this.err(2, id || 0);
        return;
      }
      if (mask !== (1 << (id - 1))) {
        this.err(mask === 0 ? 6 : 12, id);
        return;
      }
      const cal = this.cals[id - 1];
      if (cal.ref || cal.hasMin || cal.hasMax) {
        this.err(11, id);
        return;
      }
      if (!(this.state.torque & (1 << (id - 1)))) {
        this.err(11, id);
        return;
      }
      if (!Number.isInteger(raw) || raw < 0 || raw > 4095) {
        this.err(2, id);
        return;
      }
      this.state.raw[id - 1] = raw;
      this.ok("raw");
      this.emitState();
    } else if (p.verb === "STOP") {
      if (this.state.mode === "FAULT" || this.state.mode === "ESTOP") {
        this.err(11);
        return;
      }
      this.state.mode = "READY";
      this.state.target = [null, null, null];
      this.ok("stop");
      this.emitState();
    } else if (p.verb === "ESTOP") {
      this.state.mode = "ESTOP";
      this.state.target = [null, null, null];
      this.ok("estop");
      this.emitState();
    } else if (p.verb === "CLEAR") {
      if (this.state.mode === "FAULT" || this.state.mode === "ESTOP") {
        this.state.mode = this.calMask() === 7 ? "READY" : "UNCAL";
        this.state.err = 0;
        this.ok("cleared");
      } else {
        this.ok("clear");
      }
      this.emitState();
    } else {
      this.err(1);
    }
  }

  handleCal(args) {
    const sub = args[0]?.toUpperCase();
    const id = Number(args[1]);
    if (sub === "STATUS") {
      for (const cal of this.cals) {
        this.emitLine(
          `CAL id=${cal.id} ref=${cal.ref} min_set=${cal.hasMin} max_set=${cal.hasMax} ` +
          `zero_raw=${cal.zeroRaw} zero_q=${formatQ(cal.zeroQ)} sign=${cal.sign} ` +
          `min=${cal.minRaw} max=${cal.maxRaw} margin=${cal.margin} valid=${cal.valid ? 1 : 0}`
        );
      }
      this.ok("cal");
      return;
    }
    if (sub === "SAVE") {
      if (this.state.mode === "MOTION" || this.state.mode === "FAULT" || this.state.mode === "ESTOP") {
        this.err(11);
        return;
      }
      for (const cal of this.cals) cal.valid = this.validCal(cal);
      this.state.mode = this.calMask() === 7 ? "READY" : "UNCAL";
      if (this.calMask() === 7) this.state.raw = [2048, 2048, 2048];
      this.ok("cal_saved");
      this.emitState();
      return;
    }
    if (sub === "CLEAR") {
      if (this.state.mode === "MOTION" || this.state.mode === "FAULT" || this.state.mode === "ESTOP") {
        this.err(11);
        return;
      }
      const targets = args[1] === "all" ? this.cals : this.cals.filter((cal) => cal.id === id);
      for (const cal of targets) {
        Object.assign(cal, { ref: 0, hasMin: 0, hasMax: 0, minRaw: 0, maxRaw: 4095, valid: false });
      }
      this.state.mode = this.calMask() === 7 ? "READY" : "UNCAL";
      this.ok("cal_cleared");
      this.emitState();
      return;
    }
    if (!id || id < 1 || id > 3) {
      this.err(2);
      return;
    }
    const cal = this.cals[id - 1];
    const bit = 1 << (id - 1);
    if (this.state.torque & bit) {
      this.err(11, id);
      return;
    }
    if (sub === "REF") {
      cal.zeroRaw = this.state.raw[id - 1];
      cal.zeroQ = Number(args[2]) || 0;
      cal.ref = 1;
      this.orient(cal);
      this.state.mode = "CAL";
      this.ok("cal_ref");
      this.emitState();
    } else if (sub === "DIR") {
      cal.sign = args[2] === "-1" ? -1 : 1;
      this.state.mode = "CAL";
      this.ok("cal_dir");
      this.emitState();
    } else if (sub === "MARK") {
      const isMin = args[2]?.toUpperCase() === "MIN";
      const raw = this.state.raw[id - 1];
      const next = { ...cal, [isMin ? "minRaw" : "maxRaw"]: raw, [isMin ? "hasMin" : "hasMax"]: 1 };
      this.orient(next);
      if (next.hasMin && next.hasMax && !this.geomValid(next)) {
        this.err(8, id);
        return;
      }
      Object.assign(cal, next);
      this.state.mode = "CAL";
      this.ok(isMin ? "cal_min" : "cal_max");
      this.emitState();
    } else if (sub === "SPLIT") {
      const side = args[2]?.toUpperCase();
      if (!(cal.hasMin && cal.hasMax) || cal.minRaw <= cal.maxRaw) {
        this.err(8, id);
        return;
      }
      const start = side === "LOW" ? 0 : cal.minRaw;
      const end = side === "LOW" ? cal.maxRaw : 4095;
      if (cal.zeroRaw - start < cal.margin || end - cal.zeroRaw < cal.margin) {
        this.err(8, id);
        return;
      }
      cal.minRaw = start;
      cal.maxRaw = end;
      this.state.mode = "CAL";
      this.ok("cal_split");
      this.emitState();
    } else {
      this.err(1);
    }
  }

  handleJog(p) {
    const id = Number(p.fields.id);
    const q = Number(p.fields.q);
    if (!id || id < 1 || id > 3 || !Number.isFinite(q)) {
      this.err(2, id || 0);
      return;
    }
    if (this.state.mode === "CAL" || this.state.mode === "FAULT" || this.state.mode === "ESTOP") {
      this.err(11, id);
      return;
    }
    if (!(this.state.torque & (1 << (id - 1)))) {
      this.err(11, id);
      return;
    }
    const cal = this.cals[id - 1];
    if (!cal.valid) {
      this.err(9, id);
      return;
    }
    if (!rawInJoint(cal, this.state.raw[id - 1])) {
      this.err(10, id);
      return;
    }
    const raw = qToRaw(cal, q);
    if (raw === null || !rawInSafe(safeRange(cal), raw)) {
      this.err(10, id);
      return;
    }
    this.state.target[id - 1] = raw;
    this.state.lastPose = Date.now();
    this.state.mode = "MOTION";
    this.ok("jog");
    this.emitState();
  }

  handlePose(p) {
    if (this.state.mode === "CAL" || this.state.mode === "FAULT" || this.state.mode === "ESTOP") {
      this.err(11);
      return;
    }
    if (this.calMask() !== 7 || this.state.torque !== 7) {
      this.err(9);
      return;
    }
    const q = String(p.fields.q ?? "").split(",").map(Number);
    if (q.length !== 3 || q.some((v) => !Number.isFinite(v))) {
      this.err(2);
      return;
    }
    const target = [];
    for (let i = 0; i < 3; i++) {
      const raw = Math.round(this.cals[i].zeroRaw + this.cals[i].sign * (q[i] - this.cals[i].zeroQ) * (4096 / 360));
      const safe = safeRange(this.cals[i]);
      if (!safe || raw < safe.min || raw > safe.max) {
        this.err(10, i + 1);
        return;
      }
      target.push(raw);
    }
    this.state.target = target;
    this.state.mode = "MOTION";
    this.state.lastPose = Date.now();
    this.state.err = 0;
  }
}

bind();
if (mock) {
  $("mockBadge").hidden = false;
  $("mockBadge").title =
    "这是 ?mock=1 的模拟页面，不连硬件；要看真机请打开不带 mock 的 servo.html，再点「连接串口」";
  appendLog("sys", "模拟模式：?mock=1，不连硬件；点「连接串口」进入模拟");

  if (autoConnect) setTimeout(connect, 250);
}
render();
