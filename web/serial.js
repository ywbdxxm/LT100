(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const ui = {
    connState: $('connState'), connText: $('connText'),
    connectBtn: $('connectBtn'), disconnectBtn: $('disconnectBtn'), portInfo: $('portInfo'),
    support: $('support'), hint: $('hint'),
    log: $('log'), clearLog: $('clearLog'), sendForm: $('sendForm'),
    cmd: $('cmd'), sendBtn: $('sendBtn'),
    modeSeg: $('modeSeg'), color: $('color'), colorHex: $('colorHex'),
    bright: $('bright'), brightOut: $('brightOut'), colorApply: $('colorApply'),
    text: $('text'), textBtn: $('textBtn'), clearText: $('clearText'),
    statUp: $('statUp'), statHeap: $('statHeap'), statRxTx: $('statRxTx'), statCmds: $('statCmds'),
    statMode: $('statMode'), statBright: $('statBright'), statText: $('statText'),
    swatch: $('swatch'), infoLine: $('infoLine'), streamBtn: $('streamBtn'),
    lightRing: $('lightRing'), lightSummary: $('lightSummary'), oledText: $('oledText'),
    textError: $('textError'),
  };

  let previewMode = 'SOLID';
  let previewColor = '#FF6600';
  let previewBright = 20;
  for (let i = 0; i < 24; i++) {
    const dot = document.createElement('span');
    dot.style.setProperty('--i', String(i));
    ui.lightRing.appendChild(dot);
  }

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const mock = new URLSearchParams(location.search).has('mock');
  const supportsSerial = !!navigator.serial;
  const secure = window.isSecureContext;
  const isFile = location.protocol === 'file:';
  const canUse = mock || (secure && !isFile);
  const bridgeUrl = 'ws://127.0.0.1:8771/serial';

  let port = null;
  let reader = null;
  let writer = null;
  let bridge = null;
  let tearingDown = false;
  let closing = false;
  let sawRx = false;
  let streamOn = false;
  let wrongFirmware = false;
  let history = [];
  let historyIndex = 0;

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

  function setConnState(text, kind) {
    ui.connText.textContent = text;
    ui.connState.className = 'conn-state' + (kind ? ` ${kind}` : '');
  }

  function setPortInfo(text) {
    ui.portInfo.textContent = text;
  }

  function showSupport(text) {
    ui.support.hidden = false;
    ui.support.textContent = text;
  }

  function setEnabled(on) {
    const controls = [
      ui.cmd, ui.sendBtn, ui.color, ui.bright, ui.colorApply,
      ui.text, ui.textBtn, ui.clearText, ui.streamBtn,
      ...ui.modeSeg.querySelectorAll('button'),
      ...document.querySelectorAll('[data-cmd]'),
    ];
    controls.forEach((el) => { el.disabled = !on; });
    ui.connectBtn.disabled = on || !canUse;
    ui.disconnectBtn.disabled = !on;
  }

  const MODE_NAMES = { SOLID: '单色', RAINBOW: '彩虹', BREATHE: '呼吸', OFF: '关灯' };

  function renderPreview() {
    const dots = ui.lightRing.children;
    ui.lightRing.classList.toggle('breathe', previewMode === 'BREATHE');
    const base = previewMode === 'OFF' ? 0.12 : 0.25 + 0.75 * (previewBright / 40);
    for (let i = 0; i < dots.length; i++) {
      const color = previewMode === 'RAINBOW'
        ? `hsl(${i * 15} 80% 58%)`
        : previewMode === 'OFF' ? '#a8a29e' : previewColor;
      dots[i].style.background = color;
      dots[i].style.opacity = String(base);
    }
    ui.lightSummary.textContent = `${MODE_NAMES[previewMode] || previewMode} · ${previewBright}%`;
  }

  function setActiveMode(mode) {
    const wanted = String(mode || '').toUpperCase();
    previewMode = wanted || 'SOLID';
    ui.modeSeg.querySelectorAll('[data-mode]').forEach((button) => {
      button.classList.toggle('active', button.dataset.mode === wanted);
    });
    ui.statMode.textContent = wanted || '—';
    renderPreview();
  }

  function normalizeColor(value, addHash) {
    let text = String(value || '').trim().replace(/^#/, '');
    if (!/^[0-9a-fA-F]{6}$/.test(text)) return null;
    return '#' + text.toUpperCase();
  }

  function setColor(value, updateInput) {
    const hex = normalizeColor(value, true);
    if (!hex) return;
    previewColor = hex;
    ui.colorHex.textContent = hex;
    ui.swatch.style.background = hex;
    if (updateInput) ui.color.value = hex.toLowerCase();
    renderPreview();
  }

  function setBright(value, updateInput) {
    const number = Math.max(0, Math.min(40, Number(value)));
    if (!Number.isFinite(number)) return;
    previewBright = number;
    if (updateInput) ui.bright.value = String(number);
    ui.brightOut.textContent = `${number}%`;
    ui.statBright.textContent = `${number}%`;
    renderPreview();
  }

  function setStream(on) {
    streamOn = !!on;
    ui.streamBtn.textContent = streamOn ? 'STREAM 0' : 'STREAM 1';
    ui.streamBtn.classList.toggle('active', streamOn);
  }

  function formatDuration(ms) {
    const total = Math.max(0, Math.floor(Number(ms) / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
  }

  function describePort(target) {
    if (mock) return '演示串口 CP210x';
    if (target && target.__bridge) return '本机串口桥 / CP210x';
    const info = target.getInfo ? target.getInfo() : {};
    const hex = (n) => Number(n).toString(16).padStart(4, '0');
    if (info.usbVendorId != null && info.usbProductId != null) {
      const ids = `${hex(info.usbVendorId)}:${hex(info.usbProductId)}`;
      if (info.usbVendorId === 0x10c4 && info.usbProductId === 0xea60) return `CP210x (${ids})`;
      return `USB 串口 (${ids})`;
    }
    return 'USB 串口';
  }

  function updateStat(stat) {
    if (typeof stat.up_ms === 'number') ui.statUp.textContent = formatDuration(stat.up_ms);
    if (typeof stat.heap === 'number') ui.statHeap.textContent = `${Math.round(stat.heap / 1024)} KB`;
    if (typeof stat.rx === 'number' && typeof stat.tx === 'number') {
      ui.statRxTx.textContent = `${stat.rx} / ${stat.tx}`;
    }
    if (typeof stat.cmds === 'number') ui.statCmds.textContent = String(stat.cmds);
    if (stat.mode) setActiveMode(stat.mode);
    if (stat.color) setColor(stat.color, true);
    if (typeof stat.bright === 'number') setBright(stat.bright, true);
    ui.statText.textContent = stat.text ? stat.text : '—';
    setOledText(stat.text || '');
  }

  function setOledText(text) {
    const value = String(text || '');
    ui.oledText.textContent = value || 'LT100';
    ui.oledText.style.opacity = value ? '1' : '.35';
  }

  function updateInfo(info) {
    const flash = typeof info.flash === 'number'
      ? `${(info.flash / 1048576).toFixed(1)} MB`
      : '—';
    ui.infoLine.textContent = `${info.chip || 'ESP32'} · MAC ${info.mac || '—'} · ${flash} · SDK ${info.sdk || '—'}`;
  }

  function handleIncoming(line) {
    sawRx = true;
    const kind = line.startsWith('ERR ') ? 'err' : 'rx';
    appendLog(kind, line);

    if (/^HELLO\s+protocol=1/i.test(line)) {
      if (!wrongFirmware) {
        wrongFirmware = true;
        ui.support.hidden = false;
        ui.support.innerHTML = '检测到 <b>09 公版固件</b>，不是 08 串口控制台。请 <a href="servo.html">打开 09 标定与检测台</a>；本页的灯/屏幕按钮不会工作。';
        setConnState('固件不匹配', 'busy');
      }
      return;
    }

    if (line.startsWith('{')) {
      try {
        const data = JSON.parse(line);
        if (data.type === 'stat') updateStat(data);
        else if (data.type === 'info') updateInfo(data);
      } catch (_) {
        // Non-JSON lines are still shown in the terminal above.
      }
      return;
    }

    let match = line.match(/^OK mode=([A-Z]+)/i);
    if (match) { setActiveMode(match[1]); return; }
    match = line.match(/^OK color=(#[0-9a-f]{6})/i);
    if (match) { setColor(match[1], true); setActiveMode('SOLID'); return; }
    match = line.match(/^OK bright=(\d+)/i);
    if (match) { setBright(Number(match[1]), true); return; }
    match = line.match(/^OK stream=([01])/i);
    if (match) { setStream(match[1] === '1'); return; }
    match = line.match(/^OK text=(.*)$/i);
    if (match) { setOledText(match[1]); return; }
    if (/^OK text cleared/i.test(line)) setOledText('');
  }

  async function sendCommand(raw, options = {}) {
    const command = String(raw || '').trim();
    if (!command) return false;
    if (!writer) {
      appendLog('err', '还没有连接串口');
      return false;
    }
    try {
      await writer.write(encoder.encode(command + '\n'));
      if (options.echo !== false) appendLog('tx', command);
      return true;
    } catch (error) {
      appendLog('err', `发送失败：${error.message || error}`);
      return false;
    }
  }

  async function teardown(announce) {
    if (tearingDown) return;
    tearingDown = true;
    closing = true;
    try { if (reader) await reader.cancel(); } catch (_) {}
    await sleep(30);
    try { if (writer) await writer.close(); } catch (_) {}
    try { if (bridge) bridge.close(); } catch (_) {}
    try { if (port && !port.__bridge) await port.close(); } catch (_) {}
    reader = null;
    writer = null;
    bridge = null;
    port = null;
    closing = false;
    tearingDown = false;
    sawRx = false;
    setStream(false);
    setEnabled(false);
    setPortInfo('未选择端口');
    setConnState('未连接', '');
    if (announce) appendLog('sys', '串口已断开');
  }

  async function disconnect() {
    if (!port) return;
    if (writer) {
      try { await sendCommand('STREAM 0', { echo: false }); } catch (_) {}
    }
    await teardown(true);
  }

  async function readLoop() {
    if (!port || !port.readable) {
      appendLog('err', '串口没有可读流');
      await teardown(false);
      return;
    }
    reader = port.readable.getReader();
    let buffer = '';
    try {
      while (!closing) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value) continue;
        buffer += decoder.decode(value, { stream: true });
        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline).replace(/\r$/, '');
          buffer = buffer.slice(newline + 1);
          if (line.length) handleIncoming(line);
        }
        if (buffer.length > 4096) buffer = buffer.slice(-1024);
      }
    } catch (error) {
      if (!closing) appendLog('err', `读取中断：${error.message || error}`);
    } finally {
      try { reader.releaseLock(); } catch (_) {}
      reader = null;
      if (!closing && port) {
        appendLog('sys', '串口读取结束，连接可能已断开');
        await teardown(false);
      }
    }
  }

  function openBridge() {
    return new Promise((resolve, reject) => {
      let settled = false;
      let buffer = '';
      const ws = new WebSocket(bridgeUrl);
      ws.binaryType = 'arraybuffer';
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { ws.close(); } catch (_) {}
        reject(new Error('串口桥连接超时'));
      }, 1600);

      ws.onopen = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        bridge = ws;
        port = { __bridge: true };
        writer = {
          async write(bytes) {
            if (ws.readyState !== WebSocket.OPEN) throw new Error('串口桥已断开');
            ws.send(decoder.decode(bytes));
          },
          async close() { try { ws.close(); } catch (_) {} },
        };
        ws.onmessage = (event) => {
          const text = typeof event.data === 'string'
            ? event.data
            : decoder.decode(new Uint8Array(event.data));
          buffer += text;
          let newline;
          while ((newline = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, newline).replace(/\r$/, '');
            buffer = buffer.slice(newline + 1);
            if (line.length) handleIncoming(line);
          }
          if (buffer.length > 4096) buffer = buffer.slice(-1024);
        };
        ws.onclose = () => {
          if (!tearingDown && port) {
            appendLog('sys', '本机串口桥断开');
            teardown(false);
          }
        };
        resolve();
      };
      ws.onerror = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error('串口桥未启动'));
      };
      ws.onclose = () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error('串口桥未启动'));
        }
      };
    });
  }

  async function connect() {
    if (!canUse || port) return;
    wrongFirmware = false;
    ui.support.hidden = true;
    setConnState('连接中…', 'busy');
    ui.connectBtn.disabled = true;
    try {
      if (!mock) {
        try {
          await openBridge();
          appendLog('sys', '已连接本机串口桥 ws://127.0.0.1:8771/serial');
        } catch (bridgeError) {
          appendLog('sys', `本机串口桥不可用：${bridgeError.message || bridgeError}；尝试 Web Serial`);
        }
      }
      if (!port) {
        if (!supportsSerial) throw new Error('本机桥不可用，且浏览器不支持 Web Serial');
        const selected = mock ? createMockPort() : await navigator.serial.requestPort();
        port = selected;
        await port.open({ baudRate: 115200 });
        writer = port.writable.getWriter();
        readLoop();
      }
      setPortInfo(describePort(port));
      setConnState('已连接', 'ok');
      setEnabled(true);
      setStream(false);
      sawRx = false;
      appendLog('sys', `已连接 ${describePort(port)} · 115200 8N1`);
      await sleep(mock ? 80 : 900);
      if (!port) return;
      await sendCommand('STREAM 0', { echo: false });
      await sendCommand('PING');
      await sendCommand('INFO');
      await sendCommand('STAT');
      await sendCommand('HELLO', { echo: false });
      setTimeout(() => {
        if (port && !sawRx) {
          appendLog('sys', '已连接，但 2.5 秒内没收到回复：确认板子烧的是 08，串口监视器已关闭，必要时按 EN。');
        }
      }, 2500);
    } catch (error) {
      if (error && (error.name === 'NotFoundError' || error.name === 'AbortError')) {
        appendLog('sys', '已取消选择端口');
      } else {
        appendLog('err', `连接失败：${error.message || error}`);
      }
      await teardown(false);
      ui.connectBtn.disabled = !canUse;
    }
  }

  function remember(command) {
    if (!command) return;
    if (history[history.length - 1] !== command) history.push(command);
    if (history.length > 60) history.shift();
    historyIndex = history.length;
  }

  function sendText() {
    const text = ui.text.value.trim();
    ui.textError.hidden = true;
    if (!text) {
      ui.textError.textContent = '先输入要显示的文字。';
      ui.textError.hidden = false;
      return;
    }
    if (!/^[\x20-\x7E]{1,20}$/.test(text) || /["\\]/.test(text)) {
      ui.textError.textContent = '只支持 1–20 个 ASCII 字符，不能包含双引号或反斜杠。';
      ui.textError.hidden = false;
      return;
    }
    sendCommand(`TEXT ${text}`);
    setOledText(text);
    setTimeout(() => { if (ui.oledText.textContent === text) setOledText(''); }, 5000);
  }

  // A tiny in-page emulator for UI testing: open serial.html?mock=1
  function createMockPort() {
    const state = {
      up: Date.now(), mode: 'SOLID', color: '#FF6600', bright: 20,
      text: '', stream: false, timer: 0, rx: 0, tx: 0, cmds: 0,
    };
    let controller = null;
    let closed = false;

    const emit = (line) => {
      if (closed || !controller) return;
      state.tx += line.length + 2;
      try { controller.enqueue(encoder.encode(line + '\r\n')); } catch (_) {}
    };
    const statLine = () => JSON.stringify({
      type: 'stat', up_ms: Date.now() - state.up, heap: 321452,
      rx: state.rx, tx: state.tx, cmds: state.cmds,
      mode: state.mode, color: state.color, bright: state.bright, text: state.text,
    });
    const reply = (line) => emit(line);

    const readable = new ReadableStream({
      start(c) { controller = c; },
    });
    const writable = new WritableStream({
      write(chunk) {
        const command = decoder.decode(chunk).trim();
        if (!command) return;
        state.rx += command.length + 1;
        state.cmds++;
        setTimeout(() => {
          if (closed) return;
          const [head, ...rest] = command.split(/\s+/);
          const arg = rest.join(' ');
          switch (head.toUpperCase()) {
            case 'HELP':
              reply('OK commands: HELP PING INFO STAT MODE COLOR BRIGHT TEXT CLEAR STREAM');
              break;
            case 'PING':
              reply(`PONG ${Date.now() - state.up}`);
              break;
            case 'INFO':
              reply(JSON.stringify({
                type: 'info', chip: 'ESP32-D0WD-V3', mac: 'AABBCCDDEEFF',
                flash: 4194304, sdk: 'v6.1.1', heap: 321452,
              }));
              break;
            case 'STAT':
              reply(statLine());
              break;
            case 'MODE': {
              const mode = arg.toUpperCase();
              if (!['SOLID', 'RAINBOW', 'BREATHE', 'OFF'].includes(mode)) {
                reply('ERR 02 mode must be SOLID|RAINBOW|BREATHE|OFF');
              } else {
                state.mode = mode;
                reply(`OK mode=${mode}`);
              }
              break;
            }
            case 'COLOR': {
              const hex = arg.replace(/^#/, '');
              if (!/^[0-9a-f]{6}$/i.test(hex)) {
                reply('ERR 02 color must be RRGGBB');
              } else {
                state.color = '#' + hex.toUpperCase();
                state.mode = 'SOLID';
                reply(`OK color=${state.color}`);
              }
              break;
            }
            case 'BRIGHT': {
              const value = Number(arg);
              if (!Number.isInteger(value) || value < 0 || value > 40) {
                reply('ERR 03 bright must be 0..40');
              } else {
                state.bright = value;
                reply(`OK bright=${value}`);
              }
              break;
            }
            case 'TEXT': {
              if (!arg) reply('ERR 02 missing text');
              else if (!/^[\x20-\x7E]{1,20}$/.test(arg) || /["\\]/.test(arg)) {
                reply('ERR 02 text must be printable ascii without quotes');
              } else {
                state.text = arg;
                reply(`OK text=${arg}`);
              }
              break;
            }
            case 'CLEAR':
              state.text = '';
              reply('OK text cleared');
              break;
            case 'STREAM':
              if (arg === '1') {
                state.stream = true;
                clearInterval(state.timer);
                state.timer = setInterval(() => reply(statLine()), 1000);
                reply('OK stream=1');
              } else if (arg === '0') {
                state.stream = false;
                clearInterval(state.timer);
                reply('OK stream=0');
              } else {
                reply('ERR 02 stream must be 0 or 1');
              }
              break;
            default:
              reply('ERR 01 unknown command');
          }
        }, 80);
      },
    });

    return {
      open: async () => {},
      close: async () => {
        closed = true;
        clearInterval(state.timer);
        try { controller.close(); } catch (_) {}
      },
      getInfo: () => ({ usbVendorId: 0x10c4, usbProductId: 0xea60 }),
      readable,
      writable,
    };
  }

  function bindEvents() {
    ui.connectBtn.addEventListener('click', connect);
    ui.disconnectBtn.addEventListener('click', disconnect);

    ui.sendForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const command = ui.cmd.value.trim();
      if (!command) return;
      remember(command);
      sendCommand(command);
      ui.cmd.value = '';
    });

    ui.cmd.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        if (historyIndex > 0) ui.cmd.value = history[--historyIndex];
      } else if (event.key === 'ArrowDown') {
        event.preventDefault();
        if (historyIndex < history.length - 1) ui.cmd.value = history[++historyIndex];
        else { historyIndex = history.length; ui.cmd.value = ''; }
      }
    });

    ui.clearLog.addEventListener('click', () => { ui.log.replaceChildren(); });

    document.querySelectorAll('[data-cmd]').forEach((button) => {
      button.addEventListener('click', () => sendCommand(button.dataset.cmd));
    });

    ui.modeSeg.querySelectorAll('[data-mode]').forEach((button) => {
      button.addEventListener('click', () => {
        setActiveMode(button.dataset.mode);
        sendCommand(`MODE ${button.dataset.mode}`);
      });
    });

    ui.color.addEventListener('input', () => setColor(ui.color.value, false));
    ui.colorApply.addEventListener('click', () => {
      const hex = normalizeColor(ui.color.value, true);
      if (hex) sendCommand(`COLOR ${hex.slice(1)}`);
    });

    ui.bright.addEventListener('input', () => setBright(ui.bright.value, false));
    ui.bright.addEventListener('change', () => sendCommand(`BRIGHT ${ui.bright.value}`));

    ui.textBtn.addEventListener('click', sendText);
    ui.text.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); sendText(); }
    });
    ui.clearText.addEventListener('click', () => sendCommand('CLEAR'));

    ui.streamBtn.addEventListener('click', () => {
      sendCommand(`STREAM ${streamOn ? 0 : 1}`);
    });

    if (navigator.serial && navigator.serial.addEventListener) {
      navigator.serial.addEventListener('disconnect', (event) => {
        if (port && event.target === port) {
          appendLog('sys', 'USB 串口已拔出');
          teardown(false);
        }
      });
    }

    window.addEventListener('pagehide', () => {
      try { if (port) port.close(); } catch (_) {}
    });
  }

  function init() {
    bindEvents();
    setEnabled(false);
    setActiveMode('SOLID');
    setBright(20, true);
    setColor('#FF6600', true);
    setStream(false);

    if (mock) {
      ui.hint.hidden = false;
      ui.hint.textContent = '演示模式：命令由页面模拟，不会打开真实串口。';
      ui.connectBtn.disabled = false;
    } else if (!canUse) {
      let message = '';
      if (isFile) {
        message = '不要直接双击 HTML：Web Serial 需要 localhost 或 HTTPS。请双击 start-web-console.bat，或把页面放到 HTTPS 上。';
      } else if (!secure) {
        message = '当前页面不是安全上下文。请用 http://127.0.0.1:8773/web/serial.html 或 HTTPS 打开。';
      }
      if (!supportsSerial) {
        message += (message ? ' ' : '') + '这个浏览器不支持 Web Serial；优先使用本机串口桥（start-web-console.bat）。';
      }
      showSupport(message);
      ui.connectBtn.disabled = true;
    }

    appendLog('sys', canUse
      ? '页面就绪。点击「连接串口」，优先连接本机串口桥；桥不可用时再选 CP210x。'
      : '当前环境不能使用串口，请按上方提示打开页面。');
  }

  init();
})();
