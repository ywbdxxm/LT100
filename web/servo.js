// LT100P/1 calibration and detection console.
// The page talks to the local serial bridge first, then falls back to Web Serial.
import {
  calClearCommand,
  calComplete,
  calDirCommand,
  calMarkCommand,
  calRefCommand,
  commands,
  endpointPose,
  ERROR_LABELS,
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
  rawToQ,
  safeRange,
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
let selected = 1;
let seq = 1;
let testTimer = null;
let testTarget = null;
let testNear = 0;
let testDeadline = 0;
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
  return Boolean(range && Number.isFinite(raw) && raw >= range.min && raw <= range.max);
}

function allInsideSafe() {
  return [0, 1, 2].every((index) => rawInsideSafe(index));
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
    if (testTimer) stopTest(`固件报错：${lastErr.code} ${lastErr.msg}`);
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
    if (mock) {
      await openMock();
    } else {
      try {
        await openBridge();
        appendLog("sys", "已连接本机串口桥 ws://127.0.0.1:8771/serial");
      } catch (bridgeError) {
        appendLog("sys", `本机串口桥不可用：${bridgeError.message}；尝试 Web Serial`);
        await openWebSerial();
        appendLog("sys", "已连接 Web Serial；打开串口可能让板子复位一次");
      }
    }
    setConnected(true, mock ? "模拟端口" : transport.kind === "bridge" ? "本机串口桥 / CP210x" : "CP210x / Web Serial");
    await sleep(mock ? 60 : 300);
    await handshake();
    setWizard("已连接；先确认三个关节在线，再按步骤卸力标定。");
    appendLog("sys", "LT100P/1 握手完成");
  } catch (error) {
    appendLog("err", `连接失败：${error.message ?? error}`);
    setNotice("hint", `连接失败：${error.message ?? error}`);
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

  for (let i = 0; i < 3; i++) {
    const id = i + 1;
    const isOnline = Boolean(online & (1 << i));
    const cal = cals[i];
    const limit = limits[i];
    const raw = state?.raw?.[i] ?? null;
    const q = cal?.valid && Number.isFinite(raw) ? rawToQ(cal, raw) : null;
    const card = document.querySelector(`.joint-card[data-id="${id}"]`);
    card.classList.toggle("selected", selected === id);
    card.classList.toggle("offline", !isOnline);
    card.setAttribute("aria-pressed", selected === id ? "true" : "false");
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
    const touched = Boolean(cal && (cal.ref || cal.hasMin || cal.hasMax));
    $(`j${id}safe`).textContent = safe
      ? `safe raw ${safe.min}..${safe.max} · MIN/MAX ${limit?.minRaw ?? cal.minRaw}/${limit?.maxRaw ?? cal.maxRaw}`
      : touched
        ? `已标 ${cal.hasMin ? "MIN" : ""}${cal.hasMax ? "MAX" : ""}；还缺 ${!cal.hasMin ? "MIN" : ""}${!cal.hasMax ? " MAX" : ""}`
        : "未标定";
    $(`j${id}safe`).classList.toggle("cal", Boolean(safe));
  }

  $("currentJoint").textContent = `ID${selected}`;
  $("currentJoint2").textContent = `ID${selected}`;
  $("testJoint").textContent = `ID${selected}`;
  const selectedCal = cals[selected - 1];
  const selectedLimit = limits[selected - 1];
  const selectedOnline = Boolean(online & (1 << (selected - 1)));
  const selectedTorque = Boolean(torque & (1 << (selected - 1)));
  const done = {
    1: selectedOnline,
    2: Boolean(selectedCal?.ref),
    3: Boolean(selectedCal?.ref),
    "3b": Boolean(selectedCal?.ref),
    4: Boolean(selectedCal?.hasMin),
    5: Boolean(selectedCal?.hasMax),
    6: Boolean(selectedCal?.valid),
    7: Boolean(selectedCal?.valid) && selectedTorque,
  };
  for (const row of document.querySelectorAll(".step-row[data-step]")) {
    row.classList.toggle("done", Boolean(done[row.dataset.step]));
    row.classList.toggle("active", row.dataset.step === "1" && !selectedOnline);
  }
  const range = safeRange(selectedCal);
  $("testSafe").textContent = range
    ? `ID${selected} safe raw ${range.min}..${range.max}（MIN/MAX ${selectedLimit?.minRaw ?? selectedCal.minRaw}/${selectedLimit?.maxRaw ?? selectedCal.maxRaw}）`
    : "标定/限位未就绪";
  $("testSafe").classList.toggle("cal", Boolean(range));

  $("fwInfo").textContent = hello
    ? `${hello.fw} · protocol ${hello.protocol} · ${hello.features.join(", ")}`
    : "—";
  $("calInfo").textContent = calComplete(cals)
    ? "3/3 有效"
    : `${cals.filter((cal) => cal?.valid).length}/3 有效`;
  $("torqueInfo").textContent = `${maskCount(torque)}/3`;
  $("errInfo").textContent = lastErr ? errorLabel(lastErr.code) : "—";

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
  updateButtons();
}

function updateButtons() {
  const enabled = connected && !busy;
  $("connectBtn").disabled = connected || busy;
  $("disconnectBtn").disabled = !connected || busy;
  for (const id of ["torqueOffBtn", "calSaveBtn", "calClearBtn", "readCalBtn", "readLimitsBtn", "refreshBtn", "stopBtn", "estopBtn", "clearBtn"]) {
    const el = $(id);
    if (el) el.disabled = !enabled;
  }
  const torqueOnSelected = Boolean(lastState?.torque & (1 << (selected - 1)));
  for (const id of ["calRefBtn", "calDirBtn", "markMinBtn", "markMaxBtn"]) {
    const el = $(id);
    if (el) el.disabled = !enabled || torqueOnSelected;
  }
  const canTorqueOn = enabled && calComplete(cals) && lastState?.mode !== "CAL" && allInsideSafe();
  $("torqueOnBtn").disabled = !canTorqueOn;
  const state = lastState;
  const canTest = enabled && calComplete(cals) &&
    state?.online === 7 && state?.torque === 7 && allInsideSafe() &&
    state?.mode !== "CAL" && state?.mode !== "FAULT" && state?.mode !== "ESTOP" &&
    Boolean(safeRange(cals[selected - 1])) &&
    !testTimer;
  $("testMinBtn").disabled = !canTest;
  $("testMaxBtn").disabled = !canTest;
  $("testStopBtn").disabled = !testTimer;
  $("cmd").disabled = !enabled;
  $("sendBtn").disabled = !enabled;
}

function selectJoint(id) {
  selected = Math.max(1, Math.min(3, id));
  setWizard(`已选 ID${selected}。先确认在线，再卸力、记录参考姿态、方向、MIN/MAX。`);
  render();
}

async function run(action) {
  if (busy || !connected) return;
  busy = true;
  updateButtons();
  try {
    await action();
  } catch (error) {
    appendLog("err", error.message ?? String(error));
    setWizard(`操作失败：${error.message ?? error}`);
  } finally {
    busy = false;
    render();
    updateButtons();
  }
}

async function doTorqueOff() {
  await run(async () => {
    await request(torqueCommand(selected, false), (p) => p.verb === "OK" && p.fields.torque === "off");
    await refreshAll();
    setWizard(`ID${selected} 已卸力。扶住手臂，移动到参考姿态，填 q 后点 CAL REF。`);
  });
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
    await collectCal();
    setWizard(`ID${selected} 方向已设为 ${sign > 0 ? "+1" : "-1"}。现在移到 raw 较小端点，点 MARK MIN。`);
  });
}

async function doMark(which) {
  await run(async () => {
    await request(calMarkCommand(selected, which), (p) => p.verb === "OK" && (p.args[0] === "cal_min" || p.args[0] === "cal_max"));
    await collectCal();
    await collectLimits();
    setWizard(`ID${selected} 已记录 ${which}。${which === "MIN" ? "再移到 raw 较大端点，点 MARK MAX。" : "检查安全区和 valid，再 CAL SAVE。"}`);
  });
}

async function doCalSave() {
  await run(async () => {
    await request(commands.calSave, (p) => isOk(p, "cal_saved"));
    await refreshAll();
    setWizard(calComplete(cals) ? "标定已保存，三关节有效；现在可以 TORQUE ON。" : "标定已保存，但还有关节未完整；继续标定其他关节。");
  });
}

async function doCalClear() {
  if (!confirm("清除全部标定？这会让固件进入未标定状态，POSE 会被拒绝。")) return;
  await run(async () => {
    await request(calClearCommand(0), (p) => isOk(p, "cal_cleared"));
    await refreshAll();
    setWizard("标定已清除；需要重新标定三个关节。");
  });
}

async function doTorqueOn() {
  await run(async () => {
    if (!allInsideSafe()) {
      throw new Error("有关节当前 raw 在 safe 外；先手动移回安全区再上力");
    }
    await request(commands.torqueAllOn, (p) => p.verb === "OK" && p.fields.torque === "on");
    await refreshAll();
    setWizard("三关节已上力。先做低速端点测试，确认不撞、不夹线、不超温。");
  });
}

async function doStop() {
  if (testTimer) stopTest("已停止");
  await run(async () => {
    await request(commands.stop, (p) => isOk(p, "stop"));
    await refreshAll();
    setWizard("已 STOP；保持最后目标。");
  });
}

async function doEstop() {
  if (testTimer) stopTest();
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

function startTest(which) {
  if (testTimer) return;
  const state = lastState;
  const cal = cals[selected - 1];
  const range = safeRange(cal);
  if (!state || !calComplete(cals) || state.online !== 7 || state.torque !== 7 || !range) {
    setTestMsg("需要三关节在线、标定完整、扭矩 ON，才能做端点测试。");
    return;
  }
  if (state.mode === "CAL" || state.mode === "FAULT" || state.mode === "ESTOP") {
    setTestMsg(`当前模式 ${state.mode}，不能 POSE。先保存标定 / CLEAR。`);
    return;
  }
  const targetRaw = which === "MIN" ? range.min : range.max;
  if (!confirm(`ID${selected} 将以 10°/s 移到 safe ${which}（raw ${targetRaw}）。先扶住手臂，随时 STOP。继续？`)) return;
  lastErr = null;
  testTarget = { index: selected - 1, raw: targetRaw, which };
  testNear = 0;
  testDeadline = Date.now() + 15000;
  setTestMsg(`ID${selected} 向 safe ${which}（raw ${targetRaw}）低速移动...`);
  testTimer = setInterval(testTick, 50);
  updateButtons();
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
  if (lastErr?.code) {
    stopTest(`固件错误 ${lastErr.code}，已 STOP`);
    return;
  }
  const q = endpointPose(lastState, cals, testTarget.index, testTarget.raw);
  if (!q) {
    stopTest("无法构造目标 q，已 STOP");
    return;
  }
  try {
    sendRaw(poseCommand(seq++, q, 10, 20), false);
  } catch (error) {
    stopTest(`发送失败：${error.message}`);
    return;
  }
  const raw = lastState.raw?.[testTarget.index];
  if (Number.isFinite(raw) && Math.abs(raw - testTarget.raw) <= 8) {
    testNear++;
  } else {
    testNear = 0;
  }
  if (testNear >= 3) {
    stopTest(`ID${testTarget.index + 1} 已到 raw ${raw}，已 STOP`);
  }
}

function stopTest(message = "") {
  if (testTimer) {
    clearInterval(testTimer);
    testTimer = null;
  }
  testTarget = null;
  testNear = 0;
  if (connected) {
    try { sendRaw(commands.stop); } catch {}
  }
  if (message) setTestMsg(message);
  updateButtons();
}

async function doRefresh() {
  await run(async () => {
    await refreshAll();
    setWizard("状态、标定、限位已刷新。");
  });
}

function bind() {
  for (const card of document.querySelectorAll(".joint-card")) {
    card.addEventListener("click", () => selectJoint(Number(card.dataset.id)));
  }
  $("connectBtn").addEventListener("click", connect);
  $("disconnectBtn").addEventListener("click", () => disconnect(true));
  $("torqueOffBtn").addEventListener("click", doTorqueOff);
  $("calRefBtn").addEventListener("click", doCalRef);
  $("calDirBtn").addEventListener("click", doCalDir);
  $("markMinBtn").addEventListener("click", () => doMark("MIN"));
  $("markMaxBtn").addEventListener("click", () => doMark("MAX"));
  $("calSaveBtn").addEventListener("click", doCalSave);
  $("calClearBtn")?.addEventListener("click", doCalClear);
  $("torqueOnBtn").addEventListener("click", doTorqueOn);
  $("refreshBtn").addEventListener("click", doRefresh);
  $("readCalBtn").addEventListener("click", () => run(collectCal));
  $("readLimitsBtn").addEventListener("click", () => run(collectLimits));
  $("stopBtn").addEventListener("click", doStop);
  $("estopBtn").addEventListener("click", doEstop);
  $("clearBtn").addEventListener("click", doClear);
  $("testMinBtn").addEventListener("click", () => startTest("MIN"));
  $("testMaxBtn").addEventListener("click", () => startTest("MAX"));
  $("testStopBtn").addEventListener("click", () => stopTest("已停止端点测试"));
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
      `STATE seq=1 mode=${this.state.mode} online=7 cal=${this.calMask()} torque=${this.state.torque} ` +
      `err=${this.state.err} age=0 q=${q.map((v) => formatQ(v)).join(",")} ` +
      `raw=${this.state.raw.join(",")} load=${this.state.load.join(",")} ` +
      `cur=${this.state.cur.join(",")} v=${this.state.v} t=${this.state.temp.join(",")}`
    );
  }

  ok(args) { this.emitLine(`OK ${args}`); }
  err(code, joint = 0) { this.state.err = code; this.emitLine(`ERR code=${code} seq=0 joint=${joint} msg=${ERROR_LABELS[code] ?? "error"}`); }

  validCal(cal) {
    return Boolean(cal.ref && cal.hasMin && cal.hasMax && cal.maxRaw - cal.minRaw > 2 * cal.margin &&
      cal.zeroRaw >= cal.minRaw + cal.margin && cal.zeroRaw <= cal.maxRaw - cal.margin);
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
      this.emitLine("HELLO protocol=1 fw=0.1.0-mock cal=1 features=state,stream,motion,cal,limits");
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
      this.state.mode = "CAL";
      this.ok("cal_ref");
      this.emitState();
    } else if (sub === "DIR") {
      cal.sign = args[2] === "-1" ? -1 : 1;
      this.state.mode = "CAL";
      this.ok("cal_dir");
      this.emitState();
    } else if (sub === "MARK") {
      const raw = args[2]?.toUpperCase() === "MIN" ? 1300 : 2300;
      this.state.raw[id - 1] = raw;
      if (args[2]?.toUpperCase() === "MIN") {
        cal.minRaw = raw;
        cal.hasMin = 1;
      } else {
        cal.maxRaw = raw;
        cal.hasMax = 1;
      }
      this.state.mode = "CAL";
      this.ok(args[2]?.toUpperCase() === "MIN" ? "cal_min" : "cal_max");
      this.emitState();
    } else {
      this.err(1);
    }
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
  appendLog("sys", "模拟模式：?mock=1，不连硬件");
  if (autoConnect) setTimeout(connect, 250);
}
render();
