# LT100 串口控制台

- 日期：2026-11-21
- 例程：[examples/08_serial_console/08_serial_console.ino](../../examples/08_serial_console/08_serial_console.ino)
- 目标：让电脑通过 USB 串口控制板子，并把板子状态读回电脑

## 1. 硬件路径

```text
电脑 USB-C
   │
   ▼
CP2102（USB ↔ UART）
   │  TX / RX
   ▼
ESP32 UART0：GPIO1=TX、GPIO3=RX
   │
   ├─ OLED：显示命令和回复
   ├─ 灯环 / 板载灯：执行颜色和模式
   └─ UART0 回包：OK / ERR / PONG / JSON
```

- 烧录和串口监视器都走 UART0。
- **UART1（GPIO18/19）已经接 ST3215 舵机总线**，本阶段不碰；以后舵机命令走 UART1。
- 打开串口监视器时，CP2102 的 DTR/RTS 可能让板子复位一次；看到启动横幅就说明程序在跑，不是故障。

## 2. 串口参数

| 参数 | 值 |
|---|---|
| 波特率 | 115200 |
| 数据位 | 8 |
| 校验 | 无 |
| 停止位 | 1 |
| 行尾 | `\n`（兼容 `\r\n`） |

Arduino IDE：`Tools → Serial Monitor`，右下角选 **115200**，行尾选 **Newline** 或 **Both NL & CR**。

UART 没有时钟线，双方必须用同一个波特率。一个字节的线上顺序是：

```text
空闲高 → 起始位 0 → 8 个数据位（低位先发）→ 停止位 1
```

115200 时每位约 `1 / 115200 = 8.68 µs`。字符 `A` 的 ASCII 是 `0x41`，二进制 `0100 0001`，低位先发就是 `1 0 0 0 0 0 1 0`。

## 3. 命令表

命令大小写不敏感；单行最长 96 字节。

| 命令 | 作用 | 示例回复 |
|---|---|---|
| `HELP` | 列出命令 | `OK commands: ...` |
| `PING` | 测试链路 | `PONG 12345` |
| `INFO` | 芯片、MAC、Flash、SDK、堆 | `{"type":"info",...}` |
| `STAT` | 当前状态 | `{"type":"stat",...}` |
| `MODE SOLID` | 单色 | `OK mode=SOLID` |
| `MODE RAINBOW` | 彩虹旋转 | `OK mode=RAINBOW` |
| `MODE BREATHE` | 呼吸 | `OK mode=BREATHE` |
| `MODE OFF` | 灯环熄灭 | `OK mode=OFF` |
| `COLOR RRGGBB` | 设颜色并切 SOLID；`#` 可省 | `OK color=#FF6600` |
| `BRIGHT 0..40` | 亮度百分比 | `OK bright=20` |
| `TEXT <ascii>` | OLED 显示一行文字，5 秒 | `OK text=HELLO` |
| `CLEAR` | 清除 TEXT | `OK text cleared` |
| `STREAM 0\|1` | 每秒自动发一条 STAT | `OK stream=1` |
| `SERVO ...` | 预留，后续接舵机 | `ERR 04 servo not enabled` |

`TEXT` 最多 20 个可打印 ASCII 字符，且不能包含双引号或反斜杠（方便 `STAT` 的 JSON 保持合法）。中文需要额外大字体，本阶段不做。

`BRIGHT` 上限 40%：灯链 50 颗全白会超过板载 5V 约 1A 的余量。

## 4. 回复格式

- 成功：`OK ...`
- 失败：`ERR <code> <message>`
- `PING`：`PONG <millis>`
- `INFO` / `STAT`：一行 JSON

错误码：

| 码 | 含义 |
|---|---|
| `01` | 未知命令 |
| `02` | 参数缺失或格式不对 |
| `03` | 数值越界 |
| `04` | 功能未启用（目前是 SERVO） |
| `05` | 单行超过 96 字节 |

`STAT` 示例：

```json
{"type":"stat","up_ms":19720,"heap":321452,"rx":67,"tx":362,"cmds":8,"mode":"SOLID","color":"#FF6600","bright":20,"text":"HELLO"}
```

字段：运行毫秒、空闲堆、收字节、发字节、命令数、灯模式、颜色、亮度、当前 TEXT。

## 5. OLED 和灯

OLED 三行：

```text
M:SOLID B:20
> COLOR FF6600
OK color=#FF6600
```

第一行模式 + 亮度；第二行最后一条命令；第三行最后一条回复（`TEXT` 有效时显示文字）。

灯：

- 灯环按 `MODE` 做环境光；`LED_COUNT = 50` 是板载 2 + 两个 24 灯环。
- 只接一个灯环也能跑：前 26 颗有显示，多出的 24 颗没有设备接收，不会报错。
- **板载 0 号灯 = RX**，收到字节闪蓝色；**1 号灯 = TX**，发出数据闪绿色，约 60ms。
- `MODE OFF` 只关环境光，RX/TX 指示仍保留。

## 6. 电脑端工具

用 Arduino 串口监视器就能玩。想省事可以用 PowerShell 工具（Windows 自带 .NET，不依赖 Python）：

```powershell
# 列出 CP210x / COM 口
pwsh -File .\tools\serial-console.ps1 -List

# 交互式控制台；只有一个 CP210x 时会自动选
pwsh -File .\tools\serial-console.ps1 -Port COMx

# 自动跑一遍演示：PING、INFO、彩虹、TEXT、STREAM、呼吸、绿色
pwsh -File .\tools\serial-console.ps1 -Port COMx -Demo
```

脚本用 `System.IO.Ports.SerialPort`，读超时 200ms；`STREAM` 每秒一条也能连续读。Ctrl+C 或输入 `quit` 退出，`finally` 会关闭端口。

### 6.1 网页控制台（Web Serial）

不想开 Arduino，也不想装串口工具时，用浏览器页面：

```text
双击 start-web-console.bat
  → 打开 http://127.0.0.1:8773/web/serial.html
  → 点「连接串口」
  → 在浏览器弹窗里选 CP210x 的 COM 口
```

页面提供：串口日志、命令输入、灯环模式、颜色、亮度、OLED 文字、`PING`/`INFO`/`STAT`/`STREAM` 快捷按钮，以及运行时间、空闲内存、收发计数等状态卡。

- 需要 **Chrome / Edge 89+**，或 **Firefox 151+**；Safari 不支持。
- Web Serial 要求安全上下文，所以必须从 `http://127.0.0.1` 或 HTTPS 打开，**不能直接双击 `serial.html`**。
- `tools/web-console.ps1` 是本地静态服务器，`start-web-console.bat` 只是双击入口；不依赖 Python/Node。
- 页面支持 `serial.html?mock=1` 演示模式：不连真实串口，用页面模拟 08 的回复，方便预览 UI。
- 同一时间只能有一个程序占用 COM 口；用网页控制台前先关掉 Arduino 串口监视器和 PowerShell 工具。

## 7. 实测

- 编译：`353988 B / 27% flash`，`26028 B / 7% RAM`，exit 0。
- 烧录：串口写入后 `Hash of data verified`。
- 协议测试：`PING`、`INFO`、`STAT`、`MODE RAINBOW`、`COLOR`、`BRIGHT`、`TEXT`、`STREAM 1`、`STREAM 0`、`CLEAR` 均按预期；`SERVO` 返回 `ERR 04`，未知命令返回 `ERR 01`，120 字节超长行返回 `ERR 05`。
- 边界测试：`BRIGHT 41`、`COLOR XYZ`、`TEXT "bad"` 返回错误，`STAT` 确认之前的颜色/亮度没有被改掉。
- 网页控制台用 `?mock=1` 验证了连接、PING/STAT、模式、颜色、亮度、TEXT、STREAM 和断开；真实 Web Serial 需要用户在浏览器弹窗里手动选串口。
- `tools/web-console.ps1` 在 8773 端口实测：`/web/serial.html`、`/web/serial.js`、`/docs/teach/serial-console.md` 均返回 200。
- 原始日志在 `LT100/.local/serial-test-08-*.log`，不进 git。

## 8. 排错

| 现象 | 处理 |
|---|---|
| 串口监视器没有输出 | 确认 115200、行尾 Newline；按一下 EN 复位 |
| 打开监视器板子重启 | CP2102 的 DTR/RTS 自动复位，正常 |
| 命令没反应 | 行尾不是 Newline；或者命令拼写不对，先发 `HELP` |
| 中文 TEXT 不显示 | 只支持 ASCII；中文需要换字体 |
| 灯不亮/不够亮 | `BRIGHT` 默认 20、上限 40；检查 `MODE` 和 `COLOR` |
| 端口被占用 | 关掉 IDE 串口监视器或其他串口工具；同一时间只开一个 |
| 上传失败 | 关串口监视器，确认 COM 口；必要时按 BOOT 再试 |

## 9. 后续

- `SERVO` 命令：接 UART1 和 `SMS_STS`；[09_servo_basic](servo-basic.md) 已实现读位置、逐关节 MIN/MAX 标定和受区间保护的 `MOVE`，下一步把命令并进 08。
- 电脑端二进制帧流：OLED 当第二屏，灯环跟着画面变色。
- PC 系统监控 / 音频频谱：电脑算 CPU、内存或 FFT，板子只负责显示和发光。
- Web Serial 控制台已实现：`web/serial.html`，从 `start-web-console.bat` 启动。
