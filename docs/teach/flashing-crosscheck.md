# LT100 烧录现象对照实验（两台 Windows 11，同一块板）

- 日期：2026-11-21
- 背景：**同一块实物板**，在 A 机（另一台 Windows 11）上 `arduino-cli upload` 直接自动烧录成功；在 B 机（本仓库当前这台）上永远报
  `Failed to connect to ESP32: Wrong boot mode detected (0x13)!`
- 目的：用同一套脚本、同一块板、同一根线，把两台机器上的 **DTR/RTS 翻转序列** 和 **结果** 全部录下来，逐行对比，定位差异到底在哪一层
- 执行方式：在 **A 机**上按本文件跑一遍，把生成的报告目录整个发回；B 机的报告已按同样方法生成

> **2026-11-21 A 机实测后的判读校正（先看这三条）**
>
> 1. 旧版 `tools\flash-probe.ps1` 的 `AUTO-FAIL` 可能是**脚本误报**：它找 `Chip is ESP32`，而 esptool 5.3.1 输出的是 `Chip type: ESP32-...`。拿到旧报告时，先打开 `logs\auto-chip-id.txt` 看原文里有没有 `Connected to ESP32`，不要只看 `summary.txt`。
> 2. esptool 5.3.1 的 `-v` **不打印 DTR/RTS 翻转明细**，日志里只有 `Connecting....`、`Connected` 或 `Wrong boot mode detected (0x13)`。因此不能按本文旧版 §4 去逐行对比翻转。
> 3. 第 3 步的 5 组 .NET DTR/RTS 序列**不等价于 esptool 的复位序列**：A 机（自动烧录正常）这 5 组也全部是 `boot=0x13` 或 `none`，但同一块板 `AUTO-OK` 且 `UPLOAD-OK`。这组结果只能作补充，**不能单独用来判“自动下载电路坏”**。

## 1. 交付物

跑完后会得到这样一个目录（脚本自己创建）：

```text
flashing-report\
  summary.txt               ← 先看这个，人眼可读的结论汇总
  logs\
    serial-ports.txt        ← 端口枚举
    driver.txt              ← CP210x 驱动版本/日期/INF
    core-list.txt           ← arduino-cli core 版本
    auto-chip-id.txt        ← 关键：自动下载的原始日志（Connected / 0x13）
    seq-*.txt               ← 5 条 DTR/RTS 序列各自的启动日志（仅作补充）
    upload-01.txt           ← arduino-cli 真实上传日志（可跳过）
```

把 `flashing-report` 整个文件夹打包发回即可，**不要**只截 `summary.txt`——判读要看 `auto-chip-id.txt` 原文里的 `Connected` / `Wrong boot mode`，以及 `upload-01.txt` 里的 `Hash of data verified`。

## 2. 准备（两分钟）

1. 板子插 USB，**不接 12V**（烧录不需要；接舵机时更建议断电并扶住手臂）。
2. 关掉所有可能占用串口的程序：Arduino IDE 串口监视器、网页串口控制台、串口助手、`python -m http.server` 之外的任何串口工具。
3. 记下端口号：

```powershell
Get-CimInstance Win32_SerialPort | Select-Object DeviceID, Name
```

正常会看到一行 `Silicon Labs CP210x USB to UART Bridge (COMx)`。**下文所有 `COMx` 都换成这个实际端口。**

4. 确认仓库已更新到最新：

```powershell
git pull
```

## 3. 一键采集

在仓库根目录（`LT100\`）执行：

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\flash-probe.ps1 -Port COMx
```

脚本做四件事，全部只读，不会擦 Flash、不动分区表：

| 步骤 | 内容 | 是否改变板子状态 |
|---|---|---|
| 1 | 采集 OS / PowerShell / arduino-cli / esptool / 端口 / 驱动版本 | 否 |
| 2 | **自动下载测试**：`esptool -v --before default-reset chip-id`，不按任何键 | 否 |
| 3 | **线路序列探测**：5 组 DTR/RTS 时序，每组读启动日志 | 否 |
| 4 | **真实上传**：`arduino-cli upload examples\01_blink_rgb` | 会覆盖固件（01 只是板载灯闪，可再烧回去） |

如果只想看前两步（完全不碰固件），加 `-SkipUpload`：

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\flash-probe.ps1 -Port COMx -SkipUpload
```

自定义报告目录：

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\flash-probe.ps1 -Port COMx -OutDir C:\tmp\flashing-report
```

## 4. 关键：第 2 步的日志怎么读

**esptool 5.3.1 的 `-v` 不打印 DTR/RTS 翻转明细。** 成功时 `logs\auto-chip-id.txt` 的关键行是：

```text
Serial port COMx:
Connecting....
Connected to ESP32 on COMx:
Chip type:          ESP32-D0WD-V3 (revision v3.1)
MAC:                xx:xx:xx:xx:xx:xx
```

失败时是：

```text
Connecting........................................................................
A fatal error occurred: Failed to connect to ESP32: Wrong boot mode detected (0x13)!
The chip needs to be in download mode.
```

要对比的只有三件事：

1. `summary.txt` 是 `AUTO-OK` 还是 `AUTO-FAIL`；
2. `auto-chip-id.txt` 原文里有没有 `Connected to ESP32`（**旧脚本的 `AUTO-FAIL` 可能误报，以原文为准**）；
3. 两台机器的 `MAC:` 是否相同（确认是不是同一块实物板）。

## 5. 判读表：以 raw log 为准

| A 机（能自动） | B 机（本机） | 说明 | 下一步 |
|---|---|---|---|
| `AUTO-OK` | `AUTO-FAIL` | raw log 里 B 确实是 `Wrong boot mode 0x13`，且 MAC 相同 | 同一块板换主机就变 → 主机侧：USB 口/线材/CP210x 驱动对 DTR/RTS 的处理/时序 |
| `AUTO-OK` | `AUTO-OK` | 本机其实也能自动 | 之前的失败是偶发，检查是否有程序抢串口 |
| `AUTO-FAIL` | `AUTO-FAIL` | 两台都失败 | 回到板子/线材，或直接走 §6 手动路线 |
| summary 与 raw log 矛盾 | — | 旧脚本判定 bug | 不要用 summary 下结论；先更新 `flash-probe.ps1` 再重跑 |

**A 机已实测基线（2026-11-21）**：`AUTO-OK`、`UPLOAD-OK`（`Hash of data verified`）；同一轮第 3 步 5 组序列全是 `boot=0x13` 或 `none`。所以：

- 第 3 步出现 `download=DOWNLOAD` 可以作为**正面**证据（自动下载链路能进下载模式）；
- 第 3 步全是 `0x13/none` **不能**反推“自动下载电路坏”——A 机就是反例。这 5 组 .NET 序列不等价于 esptool 的内部复位序列。

A 机的 CP210x 还**不是直插 root hub**：它接在一个 Genesys Logic 的 **USB2.1 Hub** 上（`Port_#0002.Hub_#0006`，父设备 `USB\VID_05E3&PID_0610`），仍然自动烧录成功；B 机是直插 `ROOT_HUB30`（USB 3.x 根集线器）却失败。因此“Hub 一定会导致自动下载失败”也不成立，反而提示一个可测差异：

- 在 B 机上把板子接到一个 **USB 2.0 Hub** 或 **USB 2.0 端口**（黑色口），再跑 `flash-probe.ps1 -SkipUpload`；
- 如果变成 `AUTO-OK`，差异就在 USB 主控制器/Hub 对 DTR/RTS 控制传输的时序处理，而不是板子或驱动版本。

## 6. 如果确认必须手动（B 类）

手动路线见 [flashing.md §4](flashing.md)：按住 `KEY_FLASH`，由脚本/工具拉一次 RTS 复位，读到 `waiting for download` 后再用 esptool 写 merged 镜像。这条路在 B 机上已经验证可用（stub + 921600，4 MB 约 11 秒）。

## 7. 回传内容清单

- [ ] `flashing-report\summary.txt`
- [ ] `flashing-report\logs\auto-chip-id.txt`（最关键，先看原文有没有 `Connected`）
- [ ] `flashing-report\logs\upload-01.txt`（有没有 `Hash of data verified`）
- [ ] `flashing-report\logs\seq-*.txt`（仅作补充）
- [ ] `flashing-report\logs\driver.txt`
- [ ] `flashing-report\logs\serial-ports.txt`
- [ ] 一句话说明：用的是**同一块板**还是同型号另一块（最好附 `auto-chip-id.txt` 里的 `MAC:`）；**同一根线**吗；插的是机箱后面还是前面板的 USB 口

## 8. 隐私

- 脚本只采本机的 OS 版本、驱动版本、串口枚举，不采用户名、路径、MAC 之外的任何信息；板子 MAC 会出现在 `auto-chip-id.txt` 里，回传前可以自行删掉那一行。
- 报告目录不要提交进仓库，`flashing-report\` 已在 `.gitignore` 内。
