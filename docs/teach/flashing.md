# LT100 烧录流程（Arduino CLI / IDE）

- 日期：2026-11-21
- 适用：LT100 / 微雪 Servo Driver with ESP32（ESP32-WROOM-32，CP2102）
- 目标：从选板、编译、烧录到验证，以及自动下载失败时怎么手动进下载模式
- 结论先说：本机默认用 **921600** 烧录；自动下载不是 100% 可靠，重试或手动 `BOOT + EN` 是正常后备。

## 1. 前提

- 板子：ESP32 Dev Module，USB-C 走 CP2102；电脑上显示为 `Silicon Labs CP210x` 的 `COMx`。
- 烧录只靠 USB，**12V 可以关掉**；如果舵机接着，关 12V 并扶住手臂，避免新固件一上电就动。
- 课程库：`SCServo` 1.0.2、`U8g2`、`Adafruit NeoPixel` 已装到 `Documents\Arduino\libraries`。
- 工具：
  - CLI：`LT100\resources\arduino-cli\arduino-cli.exe`（1.6.0，`esp32:esp32 4.0.0`）
  - IDE：Arduino IDE 2.3.11（离线包里有安装器）
- 不要把 `COMx` 写成固定端口；每台电脑枚举出来的编号不同。

## 2. 一眼流程

```text
接 USB-C（12V 可关）
  → 选 ESP32 Dev Module / CP210x 的 COMx
  → compile
  → upload（默认 921600）
  → 看到 Hash of data verified
  → 串口 115200 发 SCAN 验证
  → 卡在 Connecting...：重试 → 手动 BOOT + EN
```

## 3. 选板和端口

CLI：

```powershell
.\resources\arduino-cli\arduino-cli.exe board list
```

找到 `Silicon Labs CP210x` 对应的 `COMx`。如果列表里没有：

- 装 `resources\CP210x_Universal_Windows_Driver\silabser.inf`；
- 换一根能传数据的 USB-C 线；
- 换电脑直出的 USB 口，先不要经过 Hub / KVM / 扩展坞。

IDE：

- `Tools → Board → ESP32 Arduino → ESP32 Dev Module`
- `Tools → Port → Silicon Labs CP210x (COMx)`

## 4. 编译

以 09 舵机例程为例：

```powershell
.\resources\arduino-cli\arduino-cli.exe compile `
  --fqbn esp32:esp32:esp32 `
  .\examples\09_servo_basic
```

本机实测：

```text
Sketch uses 341989 bytes (26%) of program storage space.
Global variables use 25664 bytes (7%) of dynamic memory.
```

退出码必须为 `0`。编译不需要 12V。

## 5. 烧录

```powershell
.\resources\arduino-cli\arduino-cli.exe upload `
  --fqbn esp32:esp32:esp32 `
  --port COMx `
  .\examples\09_servo_basic
```

本机默认上传速度是 **921600**，没有手动降速。成功日志的关键行：

```text
Serial port COMx:
Connecting.....
Connected to ESP32 on COMx:
Chip type:          ESP32-D0WD-V3 ...
Changing baud rate to 921600...
Changed.
...
Wrote 342144 bytes (200549 compressed) at 0x00010000 in 3.5 seconds (791.5 kbit/s).
Verifying written data...
Hash of data verified.

Hard resetting via RTS pin...
New upload port: COMx (serial)
```

注意：

- `791.5 kbit/s` 是实际写入吞吐，不是配置的波特率；配置值是 **921600**。
- 应用串口监视器的 **115200** 是另一个波特率，不要混。
- `Hash of data verified` 和退出码 `0` 都出现，才算写入成功。
- `arduino-cli upload` 会按分区表写 bootloader / partitions / app；**不要自己记 `0x10000` 去裸烧**。
- 正常 `upload` **不会擦 NVS**：09 的标定限位会保留。只有 `Erase All Flash Before Sketch Upload` 或 `erase_flash` 才会清掉 NVS，之后必须重新标定。

## 6. 烧录后验证

先等板子启动，再打开串口监视器：

```text
波特率：115200
行尾：Newline
```

发：

```text
SCAN
```

正常应回：

```text
SCAN servo bus (ID 1..3):
...
SCAN done: 3/3 online
```

如果回 `0/3`：

- 烧录本身可能已经成功，只是舵机没有 12V 或没接好；
- 查 12V 5A 是否打开、3P 总线、ID 是否 1/2/3；
- 09 上电只读、不自动转，`0/3` 不是烧录失败的证据。

也可以发 `HELP`、`LIMITS`，确认固件在跑。

## 7. 自动下载失败：手动 BOOT + EN

板子的自动下载电路是：

```text
CP2102 DTR/RTS → 两个三极管 → EN / IO0
```

它会尝试自动复位并拉低 IO0；如果时序没对上，就会失败。实际见过：

```text
Connecting......................................
A fatal error occurred: Failed to connect to ESP32: Wrong boot mode detected (0x13)!
The chip needs to be in download mode.
```

这类失败发生在写入之前，**旧固件还在，Flash 没坏**。同一台电脑也可能偶发：本机曾出现第一次成功、紧接着第二次 `0x13`、重试又成功。

手动步骤：

1. 关掉串口监视器、网页控制台和其他占用 COM 口的工具。
2. Arduino IDE 选 **ESP32 Dev Module**，上传速度先降到 **115200**。
3. **按住 BOOT**（`BOOT` / `KEY_FLASH`，接 IO0）不松。
4. 点一下 **EN**（`EN` / `KEY_RST`，复位），松开 EN；BOOT 仍按住。
5. 松开 BOOT，点上传。
6. 看到 `Connecting...` 后等写入完成；上传完按一下 **EN**，让板子退出下载模式运行。

如果还是卡住：重复步骤 3–5；有些工具需要按住 BOOT，直到日志出现 `Chip is ESP32...` 再松开。

### 降速烧录

排错时把上传速度降到 115200：

```powershell
.\resources\arduino-cli\arduino-cli.exe upload `
  --fqbn esp32:esp32:esp32:UploadSpeed=115200 `
  --port COMx `
  .\examples\09_servo_basic
```

IDE：`Tools → Upload Speed → 115200`。

但注意：如果失败发生在 `Connecting...` 阶段，降速通常救不了自动复位；手动 BOOT 更可靠。

## 8. 为什么另一台电脑不能自动

同一块板在不同电脑上表现不同，通常是**主机侧**差异：

| 差异 | 表现 | 处理 |
|---|---|---|
| 串口监视器/网页控制台占用 COM | 端口忙，或复位后连不上 | 关掉所有占用串口的工具 |
| USB Hub / KVM / 扩展坞 | DTR/RTS 控制传输被吞 | 换电脑直出 USB 口 |
| 虚拟机 / 远程 USB 透传 | 串口能用，自动复位不稳 | 本机直连，或手动 BOOT |
| 充电线 / 劣质线 | 可能没有 COM，或时好时坏 | 换能传数据的线 |
| CP210x 驱动旧/异常 | 端口行为不一致 | 装包内驱动，重插 USB |
| Windows USB 省电 | 空闲后第一次上传失败 | 设备管理器关掉该 COM 口省电 |
| 上传速度 921600 | 握手失败 | 降 115200 |
| 工具不拉 DTR/RTS | 裸串口工具/部分网页工具 | 手动 BOOT，或换 Arduino IDE/arduino-cli |

判断：

- **同一块板**：A 机能自动、B 机不能 → 问题在 B 机的主机/工具/线/端口。
- **同一台电脑**：这块板不能、另一块能 → 才更像板子的自动下载电路问题。
- **手动 BOOT 能烧**：芯片、USB 串口、Flash 都正常，只是自动复位没触发；可以一直手动，不必修板。

## 9. 安全

- 烧录只需要 USB；有舵机时建议 **关 12V**，并扶住手臂。
- 不要带电插拔 3P 舵机线。
- 烧完先确认板子在跑，再开 12V；09 上电不会自动转，但其他固件不一定。
- 标定/SCAN 需要 12V；烧录不需要。

## 10. 证据

- 成功日志：`.local/upload-09-*.log`
- `Wrong boot mode` 失败日志同样在 `.local/upload-09-*.log`
- `.local/` 不进 git。
- 本机 09 实测：编译 `341989 B / 26% flash`、`25664 B / 7% RAM`；上传成功后可回 `SCAN done: 0/3 online`（当时舵机没有 12V 响应），说明固件与串口链路正常。

## 11. 检查清单

- [ ] 板子选 `ESP32 Dev Module`
- [ ] 端口是 CP210x 的 `COMx`
- [ ] 串口监视器/网页控制台已关闭
- [ ] 编译退出码 `0`
- [ ] 上传日志有 `Hash of data verified`
- [ ] 上传后串口 115200 能回 `SCAN`/`HELP`
- [ ] 自动下载失败时已试过重试和手动 `BOOT + EN`
- [ ] 有舵机时：12V 已关/已扶住，烧完再开
