# LT100 烧录流程：自动下载 vs 必须手动

- 日期：2026-11-21
- 适用：LT100 / 微雪 Servo Driver with ESP32（ESP32-WROOM-32，CP2102）
- 目标：先花 30 秒判断你这块板属于哪一类，再按对应路线烧；两条路线都能烧成功，区别只在"谁把 IO0 拉低"
- 结论先说：**烧录有两类**——A 类自动下载（一条 `upload` 命令搞定），B 类必须手动按住 `KEY_FLASH`。本机这块板（COM5，2026-11-21 实测）是 **B 类**，自动下载电路实测无效。

## 1. 两条路线一张表

| | A 类：自动下载 | B 类：必须手动 |
|---|---|---|
| 谁拉低 IO0 | CP2102 的 DTR/RTS 经两枚三极管 | 你的手指按住 `KEY_FLASH` |
| 谁复位芯片 | 同一组 DTR/RTS | 电脑用软件拉一次 RTS |
| 命令 | `arduino-cli upload`，默认即可 | 先复位进下载模式，再 `esptool write-flash` |
| 典型耗时 | app 342 KB ≈ 3.5 s；4 MB merged ≈ 11 s | 同左（仍然是 stub + 921600） |
| 成功首行 | 直接出现 `Connected to ESP32 on COMx` | 先出现 `waiting for download`，再 `Connected` |
| 失败症状 | 很少失败 | `Connecting.....` 之后 `Wrong boot mode detected (0x13)!` |
| 适用范围 | 大多数 ESP32 开发板 | 自动下载电路没接好/没生效的板子，比如本机这块 |

两条路线**共用**后面的编译、验证、安全检查；只有"怎么进下载模式"这一段不同。

## 2. 判定：你这块板属于哪一类（30 秒）

不按任何键，只用软件复位，读启动日志：

```powershell
# 串口读取器（本机脚本，见 §9 证据）
powershell -File C:\Users\ljm75\AppData\Local\Temp\lt100-serial\read.ps1 `
  -Port COM5 -Baud 115200 -Mode reset-b -Seconds 3
```

看输出第一行：

```text
rst:0x1 (POWERON_RESET),boot:0x13 (SPI_FAST_FLASH_BOOT)   ← A 类：芯片正常启动 app
rst:0x1 (POWERON_RESET),boot:0x3  (DOWNLOAD_BOOT(...))     ← B 类：已进下载模式
waiting for download
```

或者直接试一次上传：

```powershell
.\resources\arduino-cli\arduino-cli.exe upload --fqbn esp32:esp32:esp32 --port COM5 .\examples\01_blink_rgb
```

- 看到 `Connected to ESP32` → **A 类**，照 §6 走。
- 看到 `Failed to connect to ESP32: Wrong boot mode detected (0x13)!` → **B 类**，照 §4 走。

`0x13` 的含义是"芯片好好地在跑正式固件"，不是 Flash 坏了、也不是固件被清空。**旧固件还在**，重试一百次也不会自己变成下载模式。

## 3. 本机实测：自动下载为什么无效

`.tmp-flash/probe-auto.ps1` 把 DTR/RTS 四种组合都试了一遍，每次都读启动日志：

| DTR | RTS 动作 | 结果 | 说明 |
|---|---|---|---|
| 1 | 脉冲 RTS | 无任何输出 | DTR 拉低 = 把芯片按在复位态 → **DTR 接 EN** |
| 0 | 脉冲 DTR | `boot:0x13` | 释放复位，正常启动 |
| 1 | 脉冲 DTR | `boot:0x13` | 同上 |
| 1 | 脉冲 RTS | `boot:0x13` | 同上 |

结论：**RTS 根本没接到 IO0**，只有 EN 这一路生效；所以无论工具怎么拉 DTR/RTS，IO0 永远是高，芯片永远从 Flash 启动。

对照原理图 `docs/reference/board/servo-driver-esp32-board-schematic.pdf` 里的 `AUTO PROGRAM CIRCUIT B`：

```text
DTR ──R3 12K── VT1(S8050) ── #EN
RTS ──R6 12K── VT2(S8050) ── IO0      ← 设计上有，实物没生效
```

设计上确实是标准两管自动下载电路，但实物上 IO0 那一路不起作用。这不是软件能修的，也不用修——手动路线本来就够用。

**已排除的干扰项**（都实测过，别再重复排障）：

| 怀疑对象 | 实测结果 |
|---|---|
| 驱动版本 | 10.1.10.103 / 11.1.0.53 / 11.6.0.420 三个版本，行为完全一致 |
| Windows USB 省电 | 关掉选择性挂起 + `LatencyTimer=1` 后仍 `0x13` |
| USB Hub / 扩展坞 | 直插 `USB\ROOT_HUB30\...`，没有外部 Hub |
| 板子个体 | 换第二块同型号板，同样 `0x13`（MAC `a4:f0:0f:9b:84:7c`） |
| 波特率 | 115200 / 921600 都进不去下载模式 |

## 4. B 类：手动进下载 + 烧录（本机标准流程）

### 4.1 三个动作

```text
1) 按住 KEY_FLASH 不松             ← 把 IO0 拉低，这一步只有手能做到
2) 电脑发一次 RTS 复位              ← 让芯片采样 IO0=低，进下载模式
3) 串口读到 waiting for download 后，立刻写 Flash
```

**注意**：`KEY_RST`（板上丝印 `KEY_RST` / `USER`）按下时串口没有任何复位日志，**它不复位芯片**。手动流程里不要用它，复位一律用软件拉 RTS。

### 4.2 复位（PowerShell，可直接粘贴）

```powershell
$p = [System.IO.Ports.SerialPort]::new('COM5', 115200)
$p.Open()
$p.DtrEnable = $false          # 别拉 DTR，否则芯片被按在复位态
$p.RtsEnable = $true
Start-Sleep -Milliseconds 120  # RTS 断言 120 ms 即复位
$p.RtsEnable = $false
Start-Sleep -Milliseconds 100
$p.Close()
```

复位后读 1.5 s 日志确认：

```text
rst:0x1 (POWERON_RESET),boot:0x3 (DOWNLOAD_BOOT(UART0/UART1/SDIO_REI_REO_V2))
waiting for download
```

看到这两行就说明时机对了——此时 `KEY_FLASH` 仍要按住，直到写完。

### 4.3 写入（stub + 921600，11 秒）

`arduino-cli upload` 在这里会失败（它先自己拉 DTR/RTS 想自动进下载），所以直接用 esptool 写预编译的 merged 镜像：

```powershell
$esptool = "C:\Users\ljm75\AppData\Local\Arduino15\packages\esp32\tools\esptool_py\5.3.1\esptool.exe"
& $esptool --chip esp32 -p COM5 -b 921600 `
  --before no-reset --after hard-reset `
  write-flash -z --flash-mode dio --flash-freq 40m --flash-size 4MB `
  0x0 C:\Users\ljm75\AppData\Local\Temp\lt100-bins\02_rainbow_breathe\02_rainbow_breathe.ino.merged.bin
```

本机成功日志（2026-11-21）：

```text
Connected to ESP32 on COM5
Chip type:          ESP32-D0WD-V3 (revision v3.1)
Changing baud rate to 921600...
Wrote 4194304 bytes (188037 compressed) at 0x00000000 in 11.0 seconds (3064.0 kbit/s).
Hash of data verified.
Hard resetting via RTS pin...
```

看到 `Hash of data verified` 即成功；`Hard resetting via RTS pin` 会让板子自动退出下载模式并启动新固件，**这时可以松开 KEY_FLASH**。

### 4.4 merged 镜像从哪来

`arduino-cli compile` 带 `--output-dir` 时，每个 sketch 目录里会生成四个文件：

```text
<name>.ino.merged.bin       4 MB，含 bootloader + 分区表 + boot_app0 + app，直接写 0x0
<name>.ino.bin              app
<name>.ino.bootloader.bin   bootloader
<name>.ino.partitions.bin   分区表
```

手动烧录用 merged，**写 `0x0`**，不要记 `0x10000`。分片烧（0x1000 / 0x8000 / 0xe000 / 0x10000）也试过，bootloader、分区表、boot_app0 都能校验通过，app 段容易在 30% 掉线——不如 merged 一把过。

## 5. 常见误区

| 误区 | 事实 |
|---|---|
| "多试几次自动就好了" | B 类板上 IO0 从来没被拉低过，重试不会有变化 |
| "按 `KEY_RST` 复位" | 实测无效，复位只能靠软件拉 RTS |
| "用 `--no-stub` 更稳" | 更慢：ROM loader 上限 115200，4 MB 要 34 s；stub 921600 只要 11 s |
| "stub 一定掉线" | 早期 stub 在 30% 断线是**握手时机**问题；芯片已在下载模式后再连就稳 |
| "降波特率能救自动下载" | 失败发生在 `Connecting...`，是复位/IO0 问题，与波特率无关 |
| "`0x13` 把 Flash 写坏了" | 恰恰相反，`0x13` = 芯片在正常跑旧固件，Flash 没动过 |
| "两个脚本一起跑更快" | 会抢 COM 口，报 `UnauthorizedAccessException` / `Cannot configure port`，先杀干净再重试 |

## 6. A 类：自动下载（正常板子）

这类板子一条命令即可，`arduino-cli` 内部会调 esptool 完成复位、同步、写入、校验：

```powershell
.\resources\arduino-cli\arduino-cli.exe upload `
  --fqbn esp32:esp32:esp32 `
  --port COMx `
  .\examples\09_servo_basic
```

默认上传速度 **921600**。成功日志的关键行：

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
- 正常 `upload` **不会擦 NVS**：09 的标定限位会保留。只有 `Erase All Flash Before Sketch Upload` 或 `erase_flash` 才会清掉 NVS，之后必须重新标定。

如果 A 类板子偶发 `0x13`（时序没对上），照 §4.1 手动进一次下载即可，不用改任何配置。

## 7. 选板和端口

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

## 8. 编译与验证

编译（不需要 12V）：

```powershell
.\resources\arduino-cli\arduino-cli.exe compile --fqbn esp32:esp32:esp32 .\examples\09_servo_basic
```

本机实测：`341989 bytes (26%)` flash、`25664 bytes (7%)` RAM，退出码必须为 `0`。

烧完先等板子启动，再开串口监视器（**115200**，行尾 Newline），发：

```text
SCAN
```

正常应回：

```text
SCAN done: 3/3 online
```

回 `0/3` 时：烧录可能已经成功，只是舵机没 12V 或总线/ID 不对；09 上电只读不转，`0/3` 不是烧录失败的证据。也可以发 `HELP`、`LIMITS` 确认固件在跑。

## 9. 证据与脚本（本机，不进 git）

| 文件 | 作用 |
|---|---|
| `.tmp-flash/probe-auto.ps1` | 扫 DTR/RTS 四种组合并读启动日志，用于判定 A/B 类 |
| `.tmp-flash/rts-reset.ps1` | 只做"拉 RTS 120 ms 复位"这一个动作 |
| `C:\Users\ljm75\AppData\Local\Temp\lt100-serial\read.ps1` | 串口读取；`-Mode reset-b` 用 RTS 复位并抓启动日志 |
| `.tmp-flash/flash-one.sh` | 循环：复位 → 确认 `waiting for download` → stub 921600 写入 |
| `.tmp-flash/flash-01.log` / `flash-02.log` / `flash-fast.log` | 各次烧录原始日志 |

`esptool` 路径：`C:\Users\ljm75\AppData\Local\Arduino15\packages\esp32\tools\esptool_py\5.3.1\esptool.exe`（`arduino-cli` 用的就是它，`platform.txt` 里 `tools.esptool_py.cmd=esptool`）。

## 10. 安全

- 烧录只需要 USB；有舵机时建议 **关 12V**，并扶住手臂。
- 不要带电插拔 3P 舵机线。
- 烧完先确认板子在跑，再开 12V；09 上电不会自动转，但其他固件不一定。
- 标定/SCAN 需要 12V；烧录不需要。

## 11. 检查清单

通用：

- [ ] 板子选 `ESP32 Dev Module`，端口是 CP210x 的 `COMx`
- [ ] 串口监视器 / 网页控制台已关闭，没有第二个脚本在抢 COM 口
- [ ] 编译退出码 `0`
- [ ] 上传日志有 `Hash of data verified`
- [ ] 上传后串口 115200 能回 `SCAN` / `HELP`

A 类（自动）：

- [ ] `upload` 直接出现 `Connected to ESP32`，无需按任何键

B 类（手动）：

- [ ] 先跑 §2 判定，确认是 `0x13` 而不是 `0x3`
- [ ] `KEY_FLASH` 全程按住，复位用软件拉 RTS（不要指望 `KEY_RST`）
- [ ] 复位后看到 `waiting for download` 才开始写
- [ ] 写的是 `.ino.merged.bin`，地址 `0x0`，`-b 921600`（不用 `--no-stub`）
- [ ] 看到 `Hard resetting via RTS pin` 后再松开 `KEY_FLASH`
