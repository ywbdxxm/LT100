# LT100 烧录流程：自动下载 vs 必须手动

- 日期：2026-11-21
- 适用：LT100 / 微雪 Servo Driver with ESP32（ESP32-WROOM-32，CP2102）
- 目标：先花 30 秒判断你这块板属于哪一类，再按对应路线烧；两条路线都能烧成功，区别只在"谁把 IO0 拉低"
- 结论先说：**烧录有两类**——A 类自动下载（一条 `upload` 命令搞定），B 类必须手动按住 `KEY_FLASH`。同一块板子在另一台 Windows 11 上走 A 类，在本机走 **B 类**；差异在主机侧，见 §3。
- **A/B 类说的是“当前主机 + 这块板”的组合，不是板子型号，也不是机器型号。** 同一块板换主机可能从 B 变 A；先按 §2 实测，别凭外观预设。本文的“本机”默认指 B 机（必须手动的那台）。

## 0. 课堂默认：IDE 手动配合（先看这条）

LT100 是给学生用的，**烧录一律由人用 Arduino IDE 执行**，agent 和 `arduino-cli` 不承担课堂烧录：

```text
1) 按住 KEY_FLASH 不松
2) IDE 里点「上传」（板选 ESP32 Dev Module，端口选 CP210x 的 COMx，上传速度 921600）
3) 全程按住，直到日志出现 Hash of data verified / 上传完成，再松手
4) 烧录期间不要开串口监视器，也不要有网页控制台占着串口
```

只差“要不要按键”这一个动作，A 类机器上学生松手也能烧，B 类机器必须按住——所以课堂统一教“按住 `KEY_FLASH` 再点上传”，两种情况都成立。

### 0.1 已知问题：部分机器无法自动下载（2026-11-21 登记）

- 现象：不按键直接上传，esptool 报 `Failed to connect to ESP32: Wrong boot mode detected (0x13)!`，重试多少次都一样。
- 范围：**同一块实物板**在另一台 Windows 11 上自动下载正常并上传成功；在本项目 B 机（AMD xHCI + CP210x 11.6.0.420 + Genesys USB2.1 Hub）上必然失败。已排除：驱动版本（10.1.10.103 / 11.1.0.53 / 11.6.0.420）、USB 选择性暂停、直插根集线器 vs 经过 Hub、换板、115200/921600、`--no-stub`。
- 结论：根因未定论，**按已知问题处理**，不再投入时间。这类机器就按住 `KEY_FLASH` 再上传，功能上不影响教学。
- 不在学生流程里的：agent 用 `arduino-cli upload` 或直接 `esptool` 代烧。烧录需要人手按键配合，串口又随时可能被监视器/网页控制台占用，交给 agent 反而不可控。本文件的 §4 与 `tools/flash-probe.ps1` 只用于老师排障和自动化验证。

## 1. 两条路线一张表

| | A 类：自动下载 | B 类：必须手动 |
|---|---|---|
| 谁拉低 IO0 | CP2102 的 DTR/RTS 经两枚三极管 | 你的手指按住 `KEY_FLASH` |
| 谁复位芯片 | 同一组 DTR/RTS | 电脑用软件拉一次 RTS |
| 命令 | `arduino-cli upload`，默认即可 | 先复位进下载模式，再 `esptool write-flash` |
| 典型耗时 | app 342 KB ≈ 3.5 s；4 MB merged ≈ 11 s | 同左（仍然是 stub + 921600） |
| 成功首行 | 直接出现 `Connected to ESP32 on COMx` | 先出现 `waiting for download`，再 `Connected` |
| 失败症状 | 很少失败 | `Connecting.....` 之后 `Wrong boot mode detected (0x13)!` |
| 适用范围 | 大多数 ESP32 开发板 | 当前主机没能触发自动下载的组合，比如 B 机 + 这块板 |

两条路线**共用**后面的编译、验证、安全检查；只有"怎么进下载模式"这一段不同。

## 2. 判定：你这块板属于哪一类（30 秒）

不按任何键，只用软件复位，读启动日志（端口改成你自己电脑上的那个）：

```powershell
$port = "COMx"                       # 换成你电脑上的 CP210x 端口
$p = [System.IO.Ports.SerialPort]::new($port, 115200)
$p.Open()
$p.DtrEnable = $false
$p.RtsEnable = $true
Start-Sleep -Milliseconds 120        # 拉 RTS = 复位
$p.RtsEnable = $false
Start-Sleep -Milliseconds 100
$buf = ""
$deadline = (Get-Date).AddMilliseconds(1500)
while ((Get-Date) -lt $deadline) { $buf += $p.ReadExisting(); Start-Sleep -Milliseconds 40 }
$p.Close()
$buf
```

看输出里的第一行：

```text
rst:0x1 (POWERON_RESET),boot:0x13 (SPI_FAST_FLASH_BOOT)   ← A 类：芯片正常启动 app
rst:0x1 (POWERON_RESET),boot:0x3  (DOWNLOAD_BOOT(...))     ← B 类：已进下载模式
waiting for download
```

或者直接试一次上传：

```powershell
.\resources\arduino-cli\arduino-cli.exe upload --fqbn esp32:esp32:esp32 --port COMx .\examples\01_blink_rgb
```

- 看到 `Connected to ESP32` → **A 类**，照 §6 走。
- 看到 `Failed to connect to ESP32: Wrong boot mode detected (0x13)!` → **B 类**，照 §4 走。

`0x13` 的含义是"芯片好好地在跑正式固件"，不是 Flash 坏了、也不是固件被清空。**旧固件还在**，重试一百次也不会自己变成下载模式。

## 3. 实测：自动下载在 B 机为什么不生效

> 本节记录的是 **B 机**（必须手动按 `KEY_FLASH` 的那台）的现象。A 机用**同一块实物板**已经 `AUTO-OK` + `UPLOAD-OK`，所以下面的“本机”均指 B 机；不要把 B 机的结论套到所有机器上。

`.tmp-flash/probe-seq.ps1` 保持串口打开、按不同次序拨 DTR/RTS，每一步都读启动日志（DTR/RTS 用 .NET `DtrEnable`/`RtsEnable` 表示，`1` = 断言）：

| 序列 | 结果 | 说明 |
|---|---|---|
| 单独断言 DTR 200 ms 后释放 | 无启动日志 | DTR 单独不产生复位 |
| 单独断言 RTS 200 ms 后释放 | 无启动日志 | RTS 单独也不产生复位 |
| esptool classic：`(0,0) → (0,1) → (1,0)` | 复位，`boot:0x13` | 复位链路正常，但启动时 IO0 是高 |
| 交换序：`(1,0) → (0,1) → (0,0)` | 复位，`boot:0x13` | 同上 |
| `(1,0) → (1,1) → (0,0)` | 复位，`boot:0x13` | 同上 |

`arduino-cli` / `esptool` 默认序列跑出来也是同一个结果：

```text
Connecting..................
A fatal error occurred: Failed to connect to ESP32: Wrong boot mode detected (0x13)!
```

结论要分清“B 机上发生了什么”和“电路能不能”：

1. **B 机的复位链路是好的**：日志里的 `rst:0x1 (POWERON_RESET)` 说明 EN 那一路被触发过。
2. **B 机的 .NET 线序探测没有把 IO0 拉低到启动采样点**：这几组自定义序列都停在 `boot:0x13`。但这只证明“这组 .NET 时序在 B 机上没生效”，**不能证明电路不可能进下载**——A 机用同一块板、同一个 esptool 已经自动连上并烧录成功；同一轮 5 组序列在 A 机也同样全是 `0x13/none`。

对照原理图 `docs/reference/board/servo-driver-esp32-board-schematic.pdf` 里的 `AUTO PROGRAM CIRCUIT B`：

```text
DTR ──R3 12K── VT1(S8050) ── #EN
RTS ──R6 12K── VT2(S8050) ── IO0
真值表（DTR RTS → RST GPIO0）：(1,1)→(1,1) (0,0)→(1,1) (1,0)→(0,1) (0,1)→(1,0)
```

真值表里 `(DTR=0, RTS=1) → RST=1, GPIO0=0` 正是“释放复位时 IO0 为低”的下载状态；esptool 的 ClassicReset 就走这条。问题不在“电路缺这一行”，而在**B 机的主机侧有没有按顺序、按时间把这两次电平变化送到 CP210x**。

> **归属已经缩到 B 机**：同一块实物板子在 A 机（另一台 **Windows 11**）上 `arduino-cli upload` 直接自动烧录成功，在 B 机上则总是 `0x13`。同一块板 + 同一系统版本，说明问题既不在板子，也不在 Windows 版本，而在 B 机的**主机侧**：USB 口/线、CP210x 驱动对 DTR/RTS 的处理、或某个抢占串口的后台程序。
>
> 要定位，在 B 机上抓一次自动连接日志：
>
> ```powershell
> $esptool = "$env:LOCALAPPDATA\Arduino15\packages\esp32\tools\esptool_py\5.3.1\esptool.exe"
> & $esptool --chip esp32 -p COMx -b 921600 -v --before default-reset chip-id
> ```
>
> **注意：esptool 5.3.1 的 `-v` 不打印 DTR/RTS 翻转明细**，只打印 `Connecting....`、`Connected` 或 `Wrong boot mode detected (0x13)`。不要按“翻转明细”对比；看 `auto-chip-id.txt` 原文和 `upload-01.txt` 的 `Hash of data verified`。
>
> 一键采集脚本与完整判读表见 [flashing-crosscheck.md](flashing-crosscheck.md)（`tools\flash-probe.ps1`）。
>
> 在 B 机上，**可行路线只有 B 类**（§4）：手按 `KEY_FLASH` 提供 IO0 低，软件拉 RTS 产生复位。

**已排除的干扰项**（都实测过，别再重复排障）：

| 怀疑对象 | 实测结果 |
|---|---|
| 驱动版本 | 10.1.10.103 / 11.1.0.53 / 11.6.0.420 三个版本，行为完全一致 |
| Windows USB 省电 | 关掉选择性挂起 + `LatencyTimer=1` 后仍 `0x13` |
| USB Hub / 控制器 | B 机直插 `USB\ROOT_HUB30\...`（USB 3.x）仍 `0x13`；A 机经 USB2.1 Hub 反而成功 → Hub 不是根因，B 可试 USB 2.0 Hub/端口 |
| 板子个体 | 换过另一块同型号实物板，本机同样 `0x13`；同型号板在另一台机器上可自动烧 |
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
$p = [System.IO.Ports.SerialPort]::new('COMx', 115200)
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
# esptool 随 esp32 core 一起装，版本号按你本机目录换
$esptool = "$env:LOCALAPPDATA\Arduino15\packages\esp32\tools\esptool_py\5.3.1\esptool.exe"

& $esptool --chip esp32 -p COMx -b 921600 `
  --before no-reset --after hard-reset `
  write-flash -z --flash-mode dio --flash-freq 40m --flash-size 4MB `
  0x0 .\build\02_rainbow_breathe.ino.merged.bin
```

`.\build\` 换成你 `compile --output-dir` 的输出目录。

本机成功日志（2026-11-21）：

```text
Connected to ESP32 on COMx
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
| "多试几次自动就好了" | B 机上 .NET 线序探测没有拿到 IO0 低（§3 实测）；先手动，别靠重试 |
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

## 9. 证据与脚本（本机临时目录，不进 git）

排障时在本地 `.tmp-flash/` 下用过这些脚本；不随仓库分发，README 只描述它们做了什么，方便复现：

| 文件 | 作用 |
|---|---|
| `probe-seq.ps1` | 保持串口打开，按不同次序拨 DTR/RTS，每步读启动日志；仅作补充，不能单独判定 A/B 类 |
| `rts-reset.ps1` | 只做"拉 RTS 120 ms 复位"这一个动作 |
| `flash-one.sh` | 循环：复位 → 确认 `waiting for download` → stub 921600 写入 |
| `flash-01.log` / `flash-02.log` / `flash-fast.log` | 各次烧录原始日志（端口号已脱敏为 `COMx`） |

`esptool` 就在 esp32 core 里：`%LOCALAPPDATA%\Arduino15\packages\esp32\tools\esptool_py\<版本>\esptool.exe`——`arduino-cli` 用的就是它（`platform.txt` 里 `tools.esptool_py.cmd=esptool`），所以两条路线的底层工具是同一个。

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
- [ ] IDE 上传：全程按住 `KEY_FLASH`，点「上传」后不要松手
- [ ] `KEY_FLASH` 全程按住，复位用软件拉 RTS（不要指望 `KEY_RST`）
- [ ] 复位后看到 `waiting for download` 才开始写
- [ ] 写的是 `.ino.merged.bin`，地址 `0x0`，`-b 921600`（不用 `--no-stub`）
- [ ] 看到 `Hard resetting via RTS pin` 后再松开 `KEY_FLASH`
