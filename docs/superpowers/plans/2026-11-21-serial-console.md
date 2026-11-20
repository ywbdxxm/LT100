# LT100 Serial Console Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a beginner-friendly serial console example that turns PC keystrokes into OLED/LED actions and returns JSON telemetry.

**Architecture:** A non-blocking Arduino loop reads newline-delimited ASCII commands from UART0, dispatches them to a small command table, updates a 50-pixel NeoPixel chain and a U8g2 OLED console, and replies with `OK`/`ERR`/JSON lines. A PowerShell host tool uses the built-in .NET serial port so students need no Python package.

**Tech Stack:** Arduino ESP32 core 4.0.0, U8g2 2.36.19, Adafruit NeoPixel 1.15.5, UART0 via CP2102, PowerShell 7/.NET SerialPort.

**Spec:** `docs/design/serial-console.md`

## Global Constraints

- Serial: `Serial` (UART0), 115200 8N1, newline-terminated commands.
- Do not use or reconfigure UART1 (GPIO18/19) — reserved for ST3215 servos.
- LED brightness is capped at 40% (50-pixel 5V budget).
- OLED is 128×32 SSD1306 at 0x3C, SDA=21, SCL=22, U8g2 full buffer.
- `TEXT` accepts printable ASCII only.
- Public docs use `COMx`, never a machine-specific COM number.

## Review Focus

- A command without trailing newline must not hang the loop or lose LED animation.
- A line longer than the 96-byte buffer must return an error and resynchronize on the next newline.
- Invalid color/brightness/mode arguments must not change the previous working state.
- `STREAM 1` must keep the console responsive and must not overwrite the last command response on OLED.
- Opening the serial port may reset the board; boot banner and console must recover.

---

### Task 1: Firmware `08_serial_console`

**Files:**
- Create: `examples/08_serial_console/08_serial_console.ino`

**Interfaces:**
- Produces serial commands: `HELP`, `PING`, `INFO`, `STAT`, `MODE`, `COLOR`, `BRIGHT`, `TEXT`, `CLEAR`, `STREAM`.
- Produces replies: `OK ...`, `ERR <code> ...`, `PONG <millis>`, one-line JSON for `INFO`/`STAT`.
- Consumes: U8g2 `U8G2_SSD1306_128X32_UNIVISION_F_HW_I2C`, Adafruit_NeoPixel on GPIO23 with 50 pixels.

- [ ] **Step 1: Write the sketch** with non-blocking line reader, command dispatch, OLED 3-line console, LED modes, RX/TX flashes, and `STREAM` telemetry.
- [ ] **Step 2: Compile** with `arduino-cli compile --fqbn esp32:esp32:esp32`; expect exit 0 and record flash/RAM.
- [ ] **Step 3: Flash** to the board; expect `Hash of data verified`.
- [ ] **Step 4: Serial protocol test** with a PowerShell `SerialPort`: send each command, assert replies and JSON parse, send an invalid command and an overlong line. Save the transcript to `.local/`.
- [ ] **Step 5: Commit** the sketch.

### Task 2: PowerShell host console

**Files:**
- Create: `tools/serial-console.ps1`

**Interfaces:**
- Parameters: `-Port <COMx>`, `-Baud 115200`, `-List`, `-Demo`.
- Uses `[System.IO.Ports.SerialPort]`; prints board lines; interactive `LT100>` prompt; `quit` exits.
- `-Demo` sends a fixed sequence and prints all replies.

- [ ] **Step 1: Write the script** with port discovery by CP210x description or `GetPortNames()`, open/close in `try/finally`, and `ReadLine` timeout handling.
- [ ] **Step 2: Run `-List`** and `-Demo` against the board; expect `PONG`, `STAT` JSON, and mode/color replies.
- [ ] **Step 3: Commit** the script.

### Task 3: Serial teaching page and docs

**Files:**
- Create: `docs/teach/serial-console.md`
- Modify: `web/index.html` (nav, tree, new `#serial` section)
- Modify: `web/style.css` (UART waveform / terminal styles)
- Modify: `docs/README.md`, `LT100/README.md`

**Interfaces:**
- Web section explains: CP2102 UART0 path, 115200 8N1, start/data/stop bits for `A` (0x41), newline framing, command table, `TEXT` ASCII limit, 40% brightness cap, serial-monitor reset.
- Docs page is the copyable protocol reference and troubleshooting table.

- [ ] **Step 1: Write the docs page** with command table, examples, error codes, and host-tool usage.
- [ ] **Step 2: Add the web section** and diagrams; link `examples/08_serial_console/08_serial_console.ino`.
- [ ] **Step 3: Update indexes** and verify local links.
- [ ] **Step 4: Render the page** at `http://127.0.0.1:8768/` and inspect the serial section.
- [ ] **Step 5: Commit** docs/web.

### Task 4: Final verification and push

- [ ] **Step 1: Re-run compile** for `08` and confirm the flashed binary matches.
- [ ] **Step 2: Run the host `-Demo`** once more; save the transcript.
- [ ] **Step 3: Check `git grep -n -E 'COM[0-9]+'`** on tracked text; expect only `COMx`.
- [ ] **Step 4: Commit and push**; confirm `main...origin/main` clean.
