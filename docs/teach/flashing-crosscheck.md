# LT100 烧录现象对照实验（两台 Windows 11，同一块板）

- 日期：2026-11-21
- 背景：**同一块实物板**，在 A 机（另一台 Windows 11）上 `arduino-cli upload` 直接自动烧录成功；在 B 机（本仓库当前这台）上永远报
  `Failed to connect to ESP32: Wrong boot mode detected (0x13)!`
- 目的：用同一套脚本、同一块板、同一根线，把两台机器上的 **DTR/RTS 翻转序列** 和 **结果** 全部录下来，逐行对比，定位差异到底在哪一层
- 执行方式：在 **A 机**上按本文件跑一遍，把生成的报告目录整个发回；B 机的报告已按同样方法生成

## 1. 交付物

跑完后会得到这样一个目录（脚本自己创建）：

```text
flashing-report\
  summary.txt               ← 先看这个，人眼可读的结论汇总
  logs\
    serial-ports.txt        ← 端口枚举
    driver.txt              ← CP210x 驱动版本/日期/INF
    core-list.txt           ← arduino-cli core 版本
    auto-chip-id.txt        ← 关键：verbose 自动下载日志（含每次 DTR/RTS 翻转）
    seq-*.txt               ← 5 条 DTR/RTS 序列各自的启动日志
    upload-01.txt           ← arduino-cli 真实上传日志（可跳过）
```

把 `flashing-report` 整个文件夹打包发回即可，**不要**只截 `summary.txt`——判读要看 `auto-chip-id.txt` 里的翻转明细。

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

## 4. 关键：第 2 步的 verbose 日志怎么读

`logs\auto-chip-id.txt` 里，DTR/RTS 的每次翻转都以这样的形式出现（esptool v5）：

```text
Changing baud rate to 921600...
...
Connected to ESP32 on COMx:
Chip type:          ESP32-D0WD-V3 (revision v3.1)
```

失败时则是：

```text
Connecting........................................................................
A fatal error occurred: Failed to connect to Esp32: Wrong boot mode detected (0x13)!
The chip needs to be in download mode.
```

要对比的是**连接成功/失败之前那一小段**，典型形态：

```text
DTR=1 RTS=0  →  DTR=0 RTS=1  →  DTR=0 RTS=0
```

把两台机器的这段序列贴在一起，就能回答两个问题：

- 两次翻转的**顺序和电平**是否一致？
- 若一致，是不是在同样的电平下，一边能拿到同步应答、一边拿不到？

## 5. 判读表：四种组合，四种结论

| A 机（能自动） | B 机（本机） | 说明 | 下一步 |
|---|---|---|---|
| `AUTO-OK` | `AUTO-FAIL` | 两台翻转序列**完全相同** | 差异在电气层：USB 口 / 线材 / 板子连接器 / 驱动对电平的处理 |
| `AUTO-OK` | `AUTO-FAIL` | 翻转序列**不同**（顺序或电平不一致） | 差异在驱动或工具层：比对第一个分歧点，看是哪边少/多一次翻转 |
| `AUTO-OK` | `AUTO-OK` | 本机其实也能自动 | 之前的失败是偶发，检查是否有程序抢串口 |
| `AUTO-FAIL` | `AUTO-FAIL` | 两台都失败 | 问题不在机器，回到板子/线材，或直接走 §6 手动路线 |

序列探测（第 3 步）的结果还能进一步缩小范围：

- 两台都能在某条序列里看到 `download=DOWNLOAD` → 自动下载电路是好的，问题只在 esptool 的时序/驱动
- 两台都是 `boot=0x13`、没有任何一组出现 `DOWNLOAD` → 该板的两管自动下载电路确实不工作，只能手动
- 只有 B 机拿不到 `boot:` 行（`boot=none`）→ 该机的复位脉冲根本没发出去，重点查 USB 口/驱动

## 6. 如果确认必须手动（B 类）

手动路线见 [flashing.md §4](flashing.md)：按住 `KEY_FLASH`，由脚本/工具拉一次 RTS 复位，读到 `waiting for download` 后再用 esptool 写 merged 镜像。这条路在 B 机上已经验证可用（stub + 921600，4 MB 约 11 秒）。

## 7. 回传内容清单

- [ ] `flashing-report\summary.txt`
- [ ] `flashing-report\logs\auto-chip-id.txt`（最关键）
- [ ] `flashing-report\logs\seq-*.txt`
- [ ] `flashing-report\logs\driver.txt`
- [ ] 一句话说明：用的是**同一块板**还是同型号另一块；**同一根线**吗；插的是机箱后面还是前面板的 USB 口

## 8. 隐私

- 脚本只采本机的 OS 版本、驱动版本、串口枚举，不采用户名、路径、MAC 之外的任何信息；板子 MAC 会出现在 `auto-chip-id.txt` 里，回传前可以自行删掉那一行。
- 报告目录不要提交进仓库，`flashing-report\` 已在 `.gitignore` 内。
