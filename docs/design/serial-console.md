# LT100 串口控制台设计

- 日期：2026-11-21
- 状态：已确认并实现
- 目标：用一个例程把「电脑 ↔ ESP32」的串口交互讲透，并给后续舵机命令留好扩展位

## 1. 为什么做

前面的例程都是板子自己跑：灯环、OLED 动画。串口是第一个「电脑参与」的入口：
电脑发命令，板子执行；板子把状态发回电脑。学生要能亲眼看到这条闭环：

```text
电脑键盘 → USB-C → CP2102 → UART0 → ESP32 解析
                                      ├─ OLED 显示
                                      ├─ 灯环 / 板载灯执行
                                      └─ 串口回 OK / STAT
```

## 2. 硬件边界

- USB 串口是 **CP2102 接 ESP32 UART0**：GPIO1=TX、GPIO3=RX；烧录和串口监视器共用。
- **UART1（GPIO18/19）已经被 ST3215 舵机总线占用**，本阶段不碰；后续舵机命令走现有总线。
- 打开串口监视器时 DTR/RTS 可能复位板子，这是自动下载电路，属正常现象；程序启动后打印 banner。
- 灯链 50 颗，5V 余量约 1A，亮度上限仍按 **40%** 设计。

## 3. 例程与交互

新增 `examples/08_serial_console/08_serial_console.ino`，串口参数 **115200 8N1**，按行读命令（`\n`，兼容 `\r\n`），单行最长 96 字符。

### 命令表

| 命令 | 作用 | 示例回复 |
|---|---|---|
| `HELP [CMD]` | 列出命令，或查看单条命令用法 | `OK cmds: HELP PING INFO STAT MODE COLOR BRIGHT TEXT CLEAR STREAM ECHO` / `OK MODE SOLID|RAINBOW|BREATHE|OFF` |
| `PING` | 链路测试 | `PONG 12345` |
| `INFO` | 芯片/固件信息 | `{"type":"info","chip":"ESP32-D0WD-V3","mac":"...","flash":4194304,"sdk":"..."}` |
| `STAT` | 状态遥测 | `{"type":"stat","up_ms":12345,"heap":289000,"rx":42,"tx":118,"cmds":5,"mode":"solid","color":"#FF6600","bright":20,"text":""}` |
| `MODE SOLID\|RAINBOW\|BREATHE\|OFF` | 灯环模式 | `OK mode=rainbow` |
| `COLOR RRGGBB\|命名色` | 设置颜色并切到 SOLID；命名色 `RED GREEN BLUE YELLOW CYAN MAGENTA ORANGE WHITE PURPLE OFF` | `OK color=#FF6600` |
| `BRIGHT 0..40` | 灯环亮度百分比 | `OK bright=20` |
| `TEXT <ascii>` | 在 OLED 上显示一行文字（最多 20 字符，5 秒） | `OK text=HELLO` |
| `CLEAR` | 清除 TEXT | `OK text cleared` |
| `STREAM 0\|1` | 每秒自动发一条 STAT | `OK stream=1` |
| `ECHO 0\|1` | 回显输入字符（配裸终端用，默认关） | `OK echo=1` |

08 不接舵机。舵机标定/检测是 09 + 公版 `LT100P/1`，不要再往 08 加 `SERVO` 命令。

错误统一 `ERR <code> <message>`；未知命令、参数缺失、越界都返回错误，不重启、不阻塞。未知命令会带上输入原文，并按前三个字母给出最接近的建议：`ERR 01 unknown 'BOGUS' (HELP)`、`ERR 01 unknown 'MOD' - did you mean MODE?`。

串口按行编辑：支持退格（`0x08`/`0x7F`），`ECHO 1` 时逐字符回显，方便在裸终端里改错字；单行超过 96 字符回 `ERR 05 line too long` 并丢弃该行。

`INFO` 带 `"built":"<编译时间>"` 字段，可以直接看出板子上跑的是哪一次编译；`STAT` 带 `"echo":0|1`。

### OLED 布局

128×32 用 U8g2 `6x10` 字体，三行：

```text
M:SOLID B20
> COLOR FF6600
OK color=#FF6600
```

- 第一行：模式 + 亮度；右上角可用 `5x7` 字体显示 `RX/TX` 计数。
- 第二行：最后一条命令（超长截断）。
- 第三行：最后一条回复；`TEXT` 模式下显示用户文字。
- 启动时显示约 1 秒 `LT100 SERIAL` / `115200 8N1`。
- 只支持 ASCII；中文需要额外大字体，本阶段不做。

### 灯环 / 板载灯

- 灯环（2–49）按 `MODE` 做环境光：SOLID / RAINBOW / BREATHE / OFF。
- **板载 0 号灯 = RX 指示**，收到一个字节闪蓝色；**1 号灯 = TX 指示**，发出一段数据闪绿色，约 60ms。
- `MODE OFF` 时灯环熄灭，但 RX/TX 指示仍保留，方便看串口是否在动。
- `BRIGHT` 上限 40%，保护板载 5V。

## 4. 代码结构

- 非阻塞主循环：`Serial.available()` 逐字节收，凑满一行再解析；动画和 OLED 刷新不能停。
- 命令解析用固定小缓冲 + `strtok`/手写切分，避免 `String` 反复分配。
- 命令用固定的 `if/else` 链，新增灯/屏命令只加一段，不改主循环；舵机不在这里扩展。
- OLED 刷新约 10 fps，灯环约 30 fps；I2C 400 kHz。
- `STAT` 用一行 JSON，方便电脑端 `json.loads` / PowerShell `ConvertFrom-Json`。

## 5. 电脑端

- **主路径**：Arduino IDE 串口监视器，115200，行尾选 **Newline**；开箱即用。
- **加分项**：`tools/serial-console.ps1`，用 Windows 自带 .NET `SerialPort`，自动列 COM 口，提供交互输入和 `-Demo` 脚本；不依赖 Python/pyserial。
- **网页控制台（追加）**：`web/serial.html` + `web/serial.js`，用浏览器 Web Serial 直连 COM 口；`tools/web-console.ps1` 提供 localhost 静态服务器，`start-web-console.bat` 一键启动。需要 Chrome / Edge 89+ 或 Firefox 151+，不能在 `file://` 下用。

## 6. 网页与文档

- 新增 `docs/teach/serial-console.md`：命令表、接线/波特率、串口监视器步骤、常见错误。
- `web/index.html` 新增「串口」章节，放在 OLED 之后：
  - USB-C → CP2102 → UART0 的连线图；
  - 一个字节的 UART 波形（起始位、8 位数据 LSB 先发、停止位，115200 下每位约 8.68µs）；
  - 电脑命令 → 板子执行 → OLED/灯 → 回包的流程图；
  - 命令表和可直接复制的终端示例。
- 资料树补 `08_serial_console/`，文档索引补 `teach/serial-console.md`。

## 7. 验收

1. 编译 08，烧录到实板；记录 flash/RAM。
2. 用串口工具依次发 `PING`、`INFO`、`STAT`、`MODE RAINBOW`、`COLOR FF6600`、`BRIGHT 20`、`TEXT HELLO`、`STREAM 1`、未知命令；逐条核对回复。
3. 确认 OLED 三行随命令变化，灯环模式和板载 RX/TX 闪烁正确。
4. 用 `STREAM 1` 连续收 10 条 JSON，确认无丢行/乱码。
5. 网页控制台在 localhost 下连接 CP210x，确认 PING、灯环、颜色、亮度、TEXT、STAT/STREAM 正常；`?mock=1` 用页面模拟验证 UI。
6. 证据日志放 `LT100/.local/`；网页和文档用 `COMx`，不写具体端口。

## 8. 非目标

- 本阶段不实现舵机运动、不占用 UART1、不做二进制帧流。
- Web Serial 已作为追加实现（`web/serial.html`），不属于 08 固件本体。
- 不在 OLED 上显示中文。
- 不追求毫秒级实时性；先保证协议清楚、交互稳定、学生能改。

## 9. 后续扩展

- **不把舵机并进 08**：08 保持灯/OLED/板子状态；舵机标定/检测走独立的 [09_servo_basic](../teach/servo-basic.md) + [公版标定台](../../web/servo.html)，协议 `LT100P/1`。
- 二进制帧流：电脑推 128×32 画面，OLED 当第二屏；作为串口第二例程。
- 网页串口面板已实现：`web/serial.html`，优先走本机串口桥，桥不可用才回退 Web Serial。
