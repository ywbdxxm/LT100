# LT100 烧录：人用 IDE，按住 BOOT 最稳

- 日期：2026-11-21
- 适用：LT100 / 微雪 Servo Driver with ESP32（ESP32-WROOM-32，CP2102）
- 课堂约定：**烧录由人用 Arduino IDE 执行**；agent 和 `arduino-cli` 不承担课堂烧录。烧录需要人手按键，串口又容易被监视器/网页控制台占用，交给 agent 反而不可控。

烧录只需要 USB；12V 可以关掉。舵机接着时，先关 12V 并扶住手臂。

## 0. 课堂默认：人 + IDE + 按住 BOOT

```text
1) 关掉串口监视器、网页控制台和其他串口工具
2) 按住 BOOT（KEY_FLASH / IO0）不松
3) IDE 选 ESP32 Dev Module、CP210x 的 COMx、Upload Speed 921600
4) 点「上传」，保持 BOOT 按住
5) 全程按住到上传完成（Hash of data verified / Done uploading），再松手
6) 上传完按一下 EN（KEY_RST），让板子运行新固件
```

**为什么课堂统一按 BOOT**：自动下载正常的机器，按住 BOOT 也能烧；自动下载不触发的机器，按住 BOOT 才能烧。课堂只教一个动作，两种情况都成立，不用先判断“这台电脑能不能自动”。

> **已知问题**：少数电脑不按键直接上传会报 `Wrong boot mode detected (0x13)`。旧固件还在，不是 Flash 坏了，也不是板子坏了；根因尚未定论，不再投入时间追。按上面的 BOOT 流程烧即可。内部排查记录见 [flashing-crosscheck.md](flashing-crosscheck.md)（学生不用看）。

## 1. 自动烧录（可选，自己电脑上先试）

不按任何键，Arduino IDE 直接上传：

- `Tools → Board → ESP32 Arduino → ESP32 Dev Module`
- `Tools → Port → Silicon Labs CP210x (COMx)`
- `Tools → Upload Speed → 921600`（默认值）
- 点左上角 **→** 或按 `Ctrl+U`
- 成功标志：`Done uploading`，日志里有 `Hash of data verified`

如果卡在 `Connecting...` 或报 `0x13`，回到 §0 的“按住 BOOT”流程。

注意：

- **921600** 是上传速度；串口监视器的 **115200** 是应用串口，两者不是同一个波特率。
- 正常上传 **不会擦 NVS**：09 的舵机标定限位会保留。只有 `Erase All Flash Before Sketch Upload` 或 `erase_flash` 才会清掉，之后必须重新标定。
- `arduino-cli` 只用于老师编译、读串口和自动化验证；**不要用它代烧课堂板**。agent 需要烧录时，请人按 §0 操作 IDE。

## 2. 按住 BOOT 仍连不上

1. 保持 BOOT 按住，点一下 EN（`EN` / `KEY_RST`），松开 EN；再点一次上传。
2. 把上传速度降到 **115200** 再试。
3. 换一根能传数据的 USB-C 线，换一个 USB 口（优先电脑直出，不经过 Hub / KVM / 扩展坞）。
4. 装 `resources\CP210x_Universal_Windows_Driver\silabser.inf`，装完拔插 USB。
5. 确认 `Tools → Port` 选的是 CP210x 的 `COMx`，不是别的串口。
6. 还不行就走 §3 的进阶路线（老师/维护者）。

> **只按 EN 不会进下载模式**：EN 只复位，BOOT 才把 IO0 拉低。手动下载必须“BOOT 按住 + 复位一次”。

## 3. 进阶：BOOT + 直接写 merged 镜像（老师/维护者）

当 IDE 的上传仍然失败时，可以绕过工具的自动复位，自己把芯片送进下载模式，再用 esptool 写一个完整的 merged 镜像。学生通常用不到这一节。

### 3.1 先编译出 merged 镜像

```powershell
.\resources\arduino-cli\arduino-cli.exe compile `
  --fqbn esp32:esp32:esp32 `
  --output-dir .\build `
  .\examples\09_servo_basic
```

输出目录里会有：

```text
09_servo_basic.ino.merged.bin       4 MB，含 bootloader + 分区表 + boot_app0 + app
09_servo_basic.ino.bin              app
09_servo_basic.ino.bootloader.bin   bootloader
09_servo_basic.ino.partitions.bin   分区表
```

手动烧录用 **merged**，写地址 **0x0**，不要写 `0x10000`。

### 3.2 按住 BOOT，软件复位一次

保持 BOOT 按住，另开一个 PowerShell 窗口执行（`COMx` 换成实际端口）：

```powershell
$p = [System.IO.Ports.SerialPort]::new('COMx', 115200)
$p.Open()
$p.DtrEnable = $false
$p.RtsEnable = $true
Start-Sleep -Milliseconds 120
$p.RtsEnable = $false
Start-Sleep -Milliseconds 100
$p.Close()
```

然后读 1.5 秒串口日志，确认出现：

```text
rst:0x1 (POWERON_RESET),boot:0x3 (DOWNLOAD_BOOT(...))
waiting for download
```

看到 `waiting for download` 就说明时机对了；BOOT 继续按住。

### 3.3 写入

```powershell
# esptool 在 esp32 core 里，版本号按你本机目录换
$esptool = "$env:LOCALAPPDATA\Arduino15\packages\esp32\tools\esptool_py\5.3.1\esptool.exe"

& $esptool --chip esp32 -p COMx -b 921600 `
  --before no-reset --after hard-reset `
  write-flash -z --flash-mode dio --flash-freq 40m --flash-size 4MB `
  0x0 .\build\09_servo_basic.ino.merged.bin
```

成功标志：

```text
Writing at 0x00000000 ...
Wrote 4194304 bytes ...
Hash of data verified.
Hard resetting via RTS pin...
```

看到 `Hash of data verified` 即成功；`Hard resetting via RTS pin` 后板子会退出下载模式并启动新固件，这时可以松开 BOOT。

## 4. 常见误区

| 误区 | 事实 |
|---|---|
| "`0x13` 把 Flash 写坏了" | 恰恰相反，`0x13` = 芯片在正常跑旧固件，Flash 没动过 |
| "多试几次自动就好了" | 可以重试一次；连续失败就直接按 BOOT，不要耗在自动下载上 |
| "按 EN 就能进下载" | EN 只复位；必须同时按住 BOOT 拉低 IO0 |
| "降波特率能救自动下载" | 失败发生在 `Connecting...`，是复位/IO0 问题，与上传波特率无关；手动进下载后可再用 115200 排错 |
| "用 `--no-stub` 更稳" | 更慢：ROM loader 上限 115200；stub 921600 快得多 |
| "两个脚本一起跑更快" | 会抢 COM 口，报 `UnauthorizedAccessException` / `Cannot configure port`；先关干净 |
| "烧完 `SCAN` 回 0/3 就是烧录失败" | 不一定。09 上电只读不转，没接 12V 时 `0/3` 正常；发 `HELP` / `LIMITS` 确认固件在跑 |

## 5. 编译与验证

编译（不需要 12V）：

```powershell
.\resources\arduino-cli\arduino-cli.exe compile `
  --fqbn esp32:esp32:esp32 `
  .\examples\09_servo_basic
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

回 `0/3` 时：烧录可能已经成功，只是舵机没 12V、3P 线没插好或 ID 不对；也可以发 `HELP`、`LIMITS` 确认固件在跑。

## 6. 安全

- 烧录只需要 USB；有舵机时建议 **关 12V**，并扶住手臂。
- 不要带电插拔 3P 舵机线。
- 烧完先确认板子在跑，再开 12V；09 上电不会自动转，但其他固件不一定。
- 标定 / `SCAN` 需要 12V；烧录不需要。

## 7. 检查清单

- [ ] 板子选 `ESP32 Dev Module`，端口是 CP210x 的 `COMx`
- [ ] 串口监视器 / 网页控制台已关闭，没有第二个脚本在抢 COM 口
- [ ] 课堂烧录：按住 BOOT，点 IDE 上传，全程按住到上传完成
- [ ] 编译退出码 `0`
- [ ] 上传日志有 `Hash of data verified` / `Done uploading`
- [ ] 上传后串口 115200 能回 `SCAN` / `HELP`

## 8. 内部说明

自动下载靠 CP2102 的 DTR/RTS → 两个三极管 → EN / IO0。它不是每台电脑、每根线、每个工具都能触发；同一块板换一台电脑可能就正常。**这是主机侧的正常差异，不是板子型号问题。**

课堂处理原则：烧录由人用 IDE 完成；自动能用就自动，自动失败就按住 BOOT；能烧进去就继续上课。根因排查记录在 [flashing-crosscheck.md](flashing-crosscheck.md)（内部资料，学生不用看）。
