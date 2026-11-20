(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const ui = {
    connState: $('connState'), connText: $('connText'),
    connectBtn: $('connectBtn'), disconnectBtn: $('disconnectBtn'), portInfo: $('portInfo'),
    support: $('support'), hint: $('hint'), joints: $('joints'),
    log: $('log'), clearLog: $('clearLog'), sendForm: $('sendForm'),
    cmd: $('cmd'), sendBtn: $('sendBtn'),
    currentJoint: $('currentJoint'), currentJoint2: $('currentJoint2'),
    torqueOffBtn: $('torqueOffBtn'), markMinBtn: $('markMinBtn'),
    markMaxBtn: $('markMaxBtn'), torqueOnBtn: $('torqueOnBtn'),
    liveRead: $('liveRead'), safeLine: $('safeLine'),
    target: $('target'), speed: $('speed'), moveBtn: $('moveBtn'),
    refreshBtn: $('refreshBtn'), clearBtn: $('clearBtn'),
  };

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const mock = new URLSearchParams(location.search).has('mock');
  const supportsSerial = !!navigator.serial;
  const secure = window.isSecureContext;
  const isFile = location.protocol === 'file:';
  const canUse = mock || (supportsSerial && secure && !isFile);

  const blank = () => ({
    online: false, pos: null, volt: null, temp: null, load: null,
    min: null, max: null, safeMin: null, safeMax: null,
  });
  const joints = { 1: blank(), 2: blank(), 3: blank() };
  const torqueOff = { 1: false, 2: false, 3: false };

  let selected = 1;
  let port = null;
  let writer = null;
  let reader = null;
  let connected = false;
  let busy = false;
  let polling = false;
  let tearingDown = false;
  let lineBuf = '';
  let pending = null;
  let pollTimer = null;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function timeStamp() {
    return new Date().toLocaleTimeString('zh-CN', { hour12: false });
  }

  function appendLog(kind, text) {
    const line = document.createElement('div');
    line.className = `log-line ${kind}`;
    const time = document.createElement('span');
    time.className = 'log-time';
    time.textContent = timeStamp();
    const mark = document.createElement('span');
    mark.className = 'log-mark';
    mark.textContent = { tx: '→', rx: '←', err: '!', sys: '·' }[kind] || '·';
    const body = document.createElement('span');
    body.className = 'log-text';
    body.textContent = text;
    line.append(time, mark, body);
    const atBottom = ui.log.scrollTop + ui.log.clientHeight >= ui.log.scrollHeight - 24;
    ui.log.appendChild(line);
    while (ui.log.children.length > 500) ui.log.firstElementChild.remove();
    if (atBottom) ui.log.scrollTop = ui.log.scrollHeight;
  }

  function showNotice(el, text) {
    el.hidden = false;
    el.textContent = text;
  }

  function setConnState(text, kind) {
    ui.connText.textContent = text;
    ui.connState.className = 'conn-state' + (kind ? ` ${kind}` : '');
  }

  function setPortInfo(text) {
    ui.portInfo.textContent = text;
  }

  function hasLimits(j) {
    return j.safeMin !== null && j.safeMax !== null;
  }

  function stateOf(j) {
    if (!j.online) return { text: '离线', cls: '' };
    if (hasLimits(j)) return { text: '已标定', cls: 'ok' };
    return { text: '在线', cls: 'ok' };
  }

  function fmtPos(j) {
    return j.online && j.pos !== null ? String(j.pos).padStart(4, '0') : '----';
  }

  function renderJoint(id) {
    const j = joints[id];
    const state = stateOf(j);
    const card = document.querySelector(`.joint-card[data-id="${id}"]`);
    $(`j${id}state`).textContent = state.text;
    $(`j${id}state`).className = `pill ${state.cls}`;
    $(`j${id}pos`).textContent = fmtPos(j);
    $(`j${id}volt`).textContent = j.volt !== null ? `${j.volt.toFixed(1)} V` : '—';
    $(`j${id}temp`).textContent = j.temp !== null ? `${j.temp} °C` : '—';
    $(`j${id}load`).textContent = j.load !== null ? String(j.load) : '—';
    let safe = '安全区：未标定';
    if (hasLimits(j)) {
      safe = `安全区：${j.safeMin}..${j.safeMax}（raw ${j.min}..${j.max}）`;
      $(`j${id}safe`).className = 'joint-safe cal';
    } else if (j.min !== null) {
      safe = '安全区：只标了下限，还缺上限';
      $(`j${id}safe`).className = 'joint-safe';
    } else if (j.max !== null) {
      safe = '安全区：只标了上限，还缺下限';
      $(`j${id}safe`).className = 'joint-safe';
    } else {
      $(`j${id}safe`).className = 'joint-safe';
    }
    $(`j${id}safe`).textContent = safe;
    card.classList.toggle('offline', !j.online);
    card.classList.toggle('selected', id === selected);
    card.setAttribute('aria-pressed', String(id === selected));
  }

  function renderSteps() {
    const j = joints[selected];
    const done = [
      j.online,
      torqueOff[selected] || j.min !== null || j.max !== null,
      j.min !== null,
      j.max !== null,
      hasLimits(j) && !torqueOff[selected],
    ];
    let active = j.online ? -1 : 0;
    if (j.online) {
      if (hasLimits(j)) {
        if (torqueOff[selected]) active = 4;
      } else if (!torqueOff[selected]) {
        active = 1;
      } else if (j.min === null) {
        active = 2;
      } else if (j.max === null) {
        active = 3;
      }
    }
    document.querySelectorAll('.step-row').forEach((row) => {
      const i = Number(row.dataset.step) - 1;
      row.classList.toggle('done', !!done[i]);
      row.classList.toggle('active', i === active);
    });
    $('s1state').textContent = j.online ? '已选' : '离线';
  }

  function updateButtons() {
    const j = joints[selected];
    const locked = busy || polling;
    const online = connected && j.online;
    ui.connectBtn.disabled = connected || busy || !canUse;
    ui.connectBtn.textContent = connected ? '已连接' : '连接串口';
    ui.disconnectBtn.disabled = !connected || busy;
    ui.torqueOffBtn.disabled = !online || locked || torqueOff[selected];
    ui.markMinBtn.disabled = !online || locked || !torqueOff[selected];
    ui.markMaxBtn.disabled = !online || locked || !torqueOff[selected];
    ui.torqueOnBtn.disabled = !online || locked;
    ui.moveBtn.disabled = !online || locked || !hasLimits(j) || torqueOff[selected];
    ui.refreshBtn.disabled = !connected || locked;
    ui.clearBtn.disabled = !connected || locked;
    ui.target.disabled = !online || locked || !hasLimits(j);
    ui.speed.disabled = !online || locked;
    ui.cmd.disabled = !connected || locked;
    ui.sendBtn.disabled = !connected || locked;
    ui.clearLog.disabled = false;
    document.querySelectorAll('[data-cmd]').forEach((button) => { button.disabled = !connected || locked; });
    ui.liveRead.disabled = !connected;
  }

  function render() {
    for (const id of [1, 2, 3]) renderJoint(id);
    const j = joints[selected];
    const label = `ID${selected}`;
    ui.currentJoint.textContent = label;
    ui.currentJoint2.textContent = label;
    if (hasLimits(j)) {
      ui.safeLine.className = 'safe-line cal';
      ui.safeLine.textContent = `安全区 ${j.safeMin}..${j.safeMax}（raw ${j.min}..${j.max}，已留 40 格余量）`;
      ui.target.min = String(j.safeMin);
      ui.target.max = String(j.safeMax);
      const value = Number(ui.target.value);
      if (!ui.target.value || Number.isNaN(value) || value < j.safeMin || value > j.safeMax) {
        const fallback = j.pos !== null ? Math.min(j.safeMax, Math.max(j.safeMin, j.pos)) : j.safeMin;
        ui.target.value = String(fallback);
      }
    } else {
      ui.safeLine.className = 'safe-line';
      ui.safeLine.textContent = j.online ? '未标定：先记录 MIN / MAX，MOVE 会被拒绝' : '离线：接 12V / 3P 线后刷新';
      ui.target.removeAttribute('min');
      ui.target.removeAttribute('max');
      ui.target.value = '';
    }
    renderSteps();
    updateButtons();
  }

  function parseLine(line) {
    let m;
    if ((m = line.match(/^ID(\d) offline$/))) {
      joints[m[1]] = blank();
      return;
    }
    if ((m = line.match(/^ID(\d) pos=(-?\d+) v=([\d.]+)V t=(-?\d+)C load=(-?\d+)$/))) {
      const j = joints[m[1]];
      j.online = true;
      j.pos = Number(m[2]);
      j.volt = Number(m[3]);
      j.temp = Number(m[4]);
      j.load = Number(m[5]);
      return;
    }
    if ((m = line.match(/^ID(\d) limits raw=(\d+)\.\.(\d+) safe=(-?\d+)\.\.(-?\d+)$/))) {
      const j = joints[m[1]];
      j.min = Number(m[2]);
      j.max = Number(m[3]);
      j.safeMin = Number(m[4]);
      j.safeMax = Number(m[5]);
      return;
    }
    if ((m = line.match(/^ID(\d) limits min=(\d+), MAX unset/))) {
      const j = joints[m[1]];
      j.min = Number(m[2]);
      j.max = null;
      j.safeMin = null;
      j.safeMax = null;
      return;
    }
    if ((m = line.match(/^ID(\d) limits MAX=(\d+), min unset/))) {
      const j = joints[m[1]];
      j.min = null;
      j.max = Number(m[2]);
      j.safeMin = null;
      j.safeMax = null;
      return;
    }
    if (/^ID\d+ limits UNSET/.test(line)) {
      const id = Number(line.match(/^ID(\d)/)[1]);
      joints[id].min = null;
      joints[id].max = null;
      joints[id].safeMin = null;
      joints[id].safeMax = null;
      return;
    }
    if ((m = line.match(/^OK torque ID(\d) (ON|OFF)/))) {
      torqueOff[m[1]] = m[2] === 'OFF';
      return;
    }
    if ((m = line.match(/^OK mark ID(\d) (MIN|MAX) raw=(-?\d+)/))) {
      const j = joints[m[1]];
      if (m[2] === 'MIN') j.min = Number(m[3]);
      else j.max = Number(m[3]);
      if (j.min !== null && j.max !== null) {
        j.safeMin = j.min + 40;
        j.safeMax = j.max - 40;
      }
    }
  }

  function resolvePending(line) {
    if (!pending) return;
    if (pending.re.test(line)) {
      const p = pending;
      pending = null;
      clearTimeout(p.timer);
      p.resolve(line);
    }
  }

  function handleLine(raw) {
    const line = raw.trim();
    if (!line) return;
    const quietPoll = polling && /^ID\d+ pos=/.test(line);
    if (!quietPoll) appendLog('rx', line);
    parseLine(line);
    resolvePending(line);
    render();
  }

  function onChunk(value) {
    lineBuf += decoder.decode(value, { stream: true });
    const parts = lineBuf.split('\n');
    lineBuf = parts.pop();
    for (const part of parts) handleLine(part.replace(/\r$/, ''));
  }

  async function sendAndWait(cmd, re, timeout = 4500) {
    if (!writer) throw new Error('未连接串口');
    if (pending) throw new Error('上一条命令还在等回复');
    if (!polling) appendLog('tx', cmd);
    let resolveFn;
    let rejectFn;
    const promise = new Promise((resolve, reject) => {
      resolveFn = resolve;
      rejectFn = reject;
    });
    const timer = setTimeout(() => {
      if (pending && pending.timer === timer) {
        pending = null;
        rejectFn(new Error(`等待回复超时：${cmd}`));
      }
    }, timeout);
    pending = { re, resolve: resolveFn, reject: rejectFn, timer };
    try {
      await writer.write(encoder.encode(cmd + '\n'));
    } catch (err) {
      if (pending && pending.timer === timer) {
        pending = null;
        clearTimeout(timer);
      }
      throw err;
    }
    return promise;
  }

  async function sendRaw(cmd) {
    if (!writer) throw new Error('未连接串口');
    appendLog('tx', cmd);
    await writer.write(encoder.encode(cmd + '\n'));
  }

  async function refreshAll() {
    if (!connected) return;
    for (const id of [1, 2, 3]) joints[id].online = false;
    await sendAndWait('SCAN', /^SCAN done:|^ERR/, 5000);
    for (const id of [1, 2, 3]) {
      joints[id].min = null;
      joints[id].max = null;
      joints[id].safeMin = null;
      joints[id].safeMax = null;
    }
    await sendAndWait('LIMITS', /^OK limits$|^ERR/, 2000);
    render();
  }

  async function run(fn) {
    if (busy || polling) return;
    busy = true;
    updateButtons();
    try {
      await fn();
    } catch (err) {
      appendLog('err', err && err.message ? err.message : String(err));
    } finally {
      busy = false;
      updateButtons();
      render();
    }
  }

  function startPolling() {
    stopPolling();
    if (!connected || !ui.liveRead.checked) return;
    pollTimer = setInterval(pollSelected, 900);
  }

  function stopPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }

  async function pollSelected() {
    if (!connected || busy || polling || !ui.liveRead.checked) return;
    polling = true;
    updateButtons();
    try {
      await sendAndWait(`READ ${selected}`, /^ID\d+ pos=|^ERR/, 1800);
    } catch {
      // Polling is best-effort; do not spam the log.
    } finally {
      polling = false;
      updateButtons();
    }
  }

  async function readLoop() {
    reader = port.readable.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) onChunk(value);
      }
    } catch (err) {
      if (!tearingDown) appendLog('err', `读取中断：${err && err.message ? err.message : err}`);
    } finally {
      try { reader.releaseLock(); } catch {}
      reader = null;
    }
  }

  async function connect() {
    if (connected || busy) return;
    busy = true;
    updateButtons();
    try {
      port = mock ? createMockPort() : await navigator.serial.requestPort();
      await port.open({ baudRate: 115200 });
      lineBuf = '';
      writer = port.writable.getWriter();
      connected = true;
      setConnState('已连接', 'ok');
      setPortInfo(mock ? '模拟端口（不连硬件）' : 'CP210x / Web Serial');
      appendLog('sys', mock ? '模拟端口已连接；不会驱动真实舵机' : '串口已连接；打开串口可能让板子复位一次');
      readLoop();
      await sleep(mock ? 80 : 900);
      await refreshAll();
      if (ui.liveRead.checked) startPolling();
    } catch (err) {
      appendLog('err', `连接失败：${err && err.message ? err.message : err}`);
      await teardown();
    } finally {
      busy = false;
      updateButtons();
      render();
    }
  }

  async function teardown() {
    tearingDown = true;
    stopPolling();
    if (pending) {
      clearTimeout(pending.timer);
      pending = null;
    }
    try { if (reader) await reader.cancel(); } catch {}
    try { if (reader) reader.releaseLock(); } catch {}
    reader = null;
    try { if (writer) writer.releaseLock(); } catch {}
    writer = null;
    try { if (port) await port.close(); } catch {}
    port = null;
    connected = false;
    setConnState('未连接');
    setPortInfo('未选择端口');
    tearingDown = false;
  }

  async function disconnect() {
    if (!connected) return;
    await teardown();
    appendLog('sys', '串口已断开');
    updateButtons();
    render();
  }

  async function actionTorqueOff() {
    await run(async () => {
      await sendAndWait(`TORQUE ${selected} OFF`, /^OK torque ID\d+ OFF|^ERR/);
      torqueOff[selected] = true;
      appendLog('sys', '已卸力：先扶住关节，再手移到安全端点');
      await refreshAll();
    });
  }

  async function actionTorqueOn() {
    await run(async () => {
      await sendAndWait(`TORQUE ${selected} ON`, /^OK torque ID\d+ ON|^ERR/);
      torqueOff[selected] = false;
      await refreshAll();
    });
  }

  async function actionMark(kind) {
    if (!torqueOff[selected]) {
      appendLog('err', '先卸力，再标记端点');
      return;
    }
    await run(async () => {
      await sendAndWait(`MARK ${selected} ${kind}`, /^OK mark|^ERR/);
      await refreshAll();
    });
  }

  async function actionMove() {
    const j = joints[selected];
    if (!hasLimits(j)) return;
    const target = Number(ui.target.value);
    const speed = Number(ui.speed.value);
    if (!Number.isInteger(target) || target < j.safeMin || target > j.safeMax) {
      appendLog('err', `目标必须是 ${j.safeMin}..${j.safeMax} 内的整数`);
      return;
    }
    if (!Number.isInteger(speed) || speed < 1 || speed > 600) {
      appendLog('err', '速度必须是 1..600');
      return;
    }
    await run(async () => {
      await sendAndWait(`MOVE ${selected} ${target} ${speed}`, /^OK move|^ERR/, 4000);
      await sleep(350);
      await sendAndWait(`READ ${selected}`, /^ID\d+ pos=|^ERR/, 1800);
    });
  }

  async function actionClear() {
    if (!confirm(`清除 ID${selected} 的 MIN/MAX？换舵机或拆臂后才需要重标。`)) return;
    await run(async () => {
      await sendAndWait(`CLEAR ${selected}`, /^OK clear|^ERR/);
      torqueOff[selected] = false;
      await refreshAll();
    });
  }

  async function manualCommand(cmd) {
    const text = String(cmd || '').trim();
    if (!text) return;
    await run(async () => {
      await sendRaw(text);
      if (/^(MARK|TORQUE|MOVE|CLEAR)\b/i.test(text)) {
        await sleep(500);
        await refreshAll();
      }
    });
  }

  function selectJoint(id) {
    selected = Number(id);
    render();
  }

  function createMockPort() {
    let ctrl = null;
    const pos = { 1: 1500, 2: 1800, 3: 2100 };
    const min = { 1: null, 2: null, 3: null };
    const max = { 1: null, 2: null, 3: null };
    const torque = { 1: true, 2: true, 3: true };
    const emit = (text) => {
      try { ctrl.enqueue(encoder.encode(text + '\n')); } catch {}
    };
    const safe = (id) => {
      if (min[id] === null || max[id] === null) return null;
      return [min[id] + 40, max[id] - 40];
    };
    const handle = (cmd) => {
      const parts = cmd.trim().split(/\s+/);
      const op = (parts[0] || '').toUpperCase();
      const id = Number(parts[1]);
      if (op === 'SCAN') {
        emit('SCAN servo bus (ID 1..3):');
        for (const n of [1, 2, 3]) emit(`  ID${n} pos=${pos[n]} v=12.0V t=31C load=0`);
        emit('SCAN done: 3/3 online');
      } else if (op === 'LIMITS') {
        emit('LIMITS (raw encoder ticks, 0..4095):');
        for (const n of [1, 2, 3]) {
          const range = safe(n);
          if (range) emit(`  ID${n} limits raw=${min[n]}..${max[n]} safe=${range[0]}..${range[1]}`);
          else if (min[n] !== null) emit(`  ID${n} limits min=${min[n]}, MAX unset (MOVE disabled)`);
          else if (max[n] !== null) emit(`  ID${n} limits MAX=${max[n]}, min unset (MOVE disabled)`);
          else emit(`  ID${n} limits UNSET (MOVE disabled)`);
        }
        emit('OK limits');
      } else if (op === 'READ') {
        if (!pos[id]) emit('ERR 02 usage: READ <id 1..3>');
        else emit(`ID${id} pos=${pos[id]} v=12.0V t=31C load=0`);
      } else if (op === 'TORQUE') {
        if (!pos[id] || !['ON', 'OFF'].includes((parts[2] || '').toUpperCase())) emit('ERR 02 usage: TORQUE <id> ON|OFF');
        else {
          torque[id] = parts[2].toUpperCase() === 'ON';
          emit(`OK torque ID${id} ${torque[id] ? 'ON' : 'OFF'}`);
        }
      } else if (op === 'MARK') {
        const which = (parts[2] || '').toUpperCase();
        if (!pos[id] || !['MIN', 'MAX'].includes(which)) emit('ERR 02 usage: MARK <id> MIN|MAX');
        else {
          const nextMin = which === 'MIN' ? pos[id] : min[id];
          const nextMax = which === 'MAX' ? pos[id] : max[id];
          if (nextMin !== null && nextMax !== null && nextMax - nextMin <= 80) {
            emit(`ERR 08 endpoints too close: raw ${nextMin}..${nextMax}, need > 80 ticks`);
          } else {
            if (which === 'MIN') min[id] = pos[id]; else max[id] = pos[id];
            const range = safe(id);
            emit(range
              ? `OK mark ID${id} ${which} raw=${pos[id]} safe=${range[0]}..${range[1]}`
              : `OK mark ID${id} ${which} raw=${pos[id]}; mark the other endpoint`);
          }
        }
      } else if (op === 'CLEAR') {
        min[id] = null; max[id] = null;
        emit('OK clear limits');
      } else if (op === 'MOVE') {
        const target = Number(parts[2]);
        const speed = Number(parts[3] || 250);
        const range = safe(id);
        if (!range) emit('ERR 09 uncalibrated; use MARK <id> MIN and MARK <id> MAX first');
        else if (!Number.isInteger(target) || target < range[0] || target > range[1]) emit(`ERR 10 target ${target} outside safe ${range[0]}..${range[1]}`);
        else if (!Number.isInteger(speed) || speed < 1 || speed > 600) emit('ERR 03 range: speed 1..600');
        else {
          const from = pos[id];
          pos[id] = target;
          emit(`OK move id=${id} from=${from} pos=${target} speed=${speed} safe=${range[0]}..${range[1]}`);
        }
      } else if (op === 'MOCKPOS') {
        // mock-only test hook: simulate moving the joint by hand
        const target = Number(parts[2]);
        if (pos[id] && Number.isInteger(target)) {
          pos[id] = target;
          emit(`OK mockpos ID${id} pos=${target}`);
        } else {
          emit('ERR 02 usage: MOCKPOS <id> <pos>');
        }
      } else if (op === 'HELP') {
        emit('Commands: SCAN READ LIMITS MARK TORQUE CLEAR MOVE HELP');
        emit('OK help');
      } else {
        emit('ERR 01 unknown command; send HELP');
      }
    };
    const readable = new ReadableStream({
      start(controller) { ctrl = controller; },
    });
    const writable = new WritableStream({
      write(chunk) {
        const text = decoder.decode(chunk);
        for (const line of text.split('\n')) {
          if (line.trim()) setTimeout(() => handle(line), 30);
        }
      },
    });
    return {
      readable,
      writable,
      async open() {},
      async close() { try { ctrl.close(); } catch {} },
      getInfo() { return { usbVendorId: 0x10c4 }; },
    };
  }

  ui.connectBtn.addEventListener('click', connect);
  ui.disconnectBtn.addEventListener('click', disconnect);
  ui.joints.addEventListener('click', (event) => {
    const card = event.target.closest('.joint-card');
    if (card) selectJoint(card.dataset.id);
  });
  ui.torqueOffBtn.addEventListener('click', actionTorqueOff);
  ui.torqueOnBtn.addEventListener('click', actionTorqueOn);
  ui.markMinBtn.addEventListener('click', () => actionMark('MIN'));
  ui.markMaxBtn.addEventListener('click', () => actionMark('MAX'));
  ui.moveBtn.addEventListener('click', actionMove);
  ui.refreshBtn.addEventListener('click', () => run(refreshAll));
  ui.clearBtn.addEventListener('click', actionClear);
  ui.liveRead.addEventListener('change', () => {
    if (ui.liveRead.checked) startPolling();
    else stopPolling();
  });
  ui.clearLog.addEventListener('click', () => { ui.log.textContent = ''; });
  ui.sendForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const cmd = ui.cmd.value;
    ui.cmd.value = '';
    manualCommand(cmd);
  });
  document.querySelectorAll('[data-cmd]').forEach((button) => {
    button.addEventListener('click', () => manualCommand(button.dataset.cmd));
  });
  window.addEventListener('pagehide', () => { teardown(); });

  if (!canUse) {
    showNotice(ui.support, '此浏览器不支持 Web Serial，或页面不是从 localhost/HTTPS 打开。请用 Chrome / Edge 89+（或 Firefox 151+），从 start-servo-console.bat 启动。');
  } else if (mock) {
    showNotice(ui.hint, '模拟模式：界面和命令流可以测试，但不会连接真实舵机。地址加 ?mock=1 可复现。');
  } else {
    showNotice(ui.hint, '第一次连接先确认 12V 5A 已打开，再点「刷新」；TORQUE OFF 前必须扶住手臂。');
  }
  render();
})();
