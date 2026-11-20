# LT100 开发环境（离线 Arduino）

- 日期：2026-11-21
- 对象：给学生机装环境的老师/助教，以及学生机上的 AI agent
- 目标：不依赖外网，装完就能编译、烧录主控板

## 1. 资源清单（`LT100/resources/`）

| 文件/目录 | 用途 | 体积 |
|---|---|---|
| `arduino-ide_2.3.11_Windows_64bit.exe` | Arduino IDE 官方安装包 | 153 MB |
| `CP210x_Universal_Windows_Driver/` | CP210x 串口驱动（已解压，认不到 COM 口时用） | 4.7 MB |
| `arduino-cli/` | arduino-cli 1.6.0，解压即用 | 40 MB |
| `arduino-offline/` | ESP32 core 4.0.0 + 工具链 + 课程库（含 U8g2，学生机用这个） | 约 2 GB |

主控板的 USB 转串口是 CP2102；Windows 10/11 通常自带驱动，先看设备管理器再决定装不装。

SCServo 1.0.2 是 Arduino 库管理器里的最新版本（2024-08-08 发布，release notes 仅 cleanup，API 与 1.0.1 相同）。
驱动 ST3215 用的是库里的 **`SMS_STS`** 类（`SCSCL` 是 SC 系列，别用错）；总线按主设计是 UART1 @ 1 Mbps。

按官方流程，开发这块板需要的组件：

| 组件 | 版本 | 用途 |
|---|---|---|
| `esp32 by Espressif Systems`（`esp32:esp32`） | 4.0.0 | xtensa 编译器、烧录工具、ESP32 底层库 |
| `SCServo`（SCServo 库） | 1.0.2 | ST3215 总线舵机控制 |
| `Adafruit NeoPixel` | 1.15.5 | 板载 2 颗 + 外接 24 颗 WS2812 |
| `Adafruit SSD1306` | 2.5.17 | 0.91 寸 OLED（I2C，0x3C） |
| `Adafruit GFX Library` | 1.13.0 | SSD1306 的图形依赖 |
| `Adafruit BusIO` | 1.17.4 | SSD1306 的 I2C 依赖 |
| `U8g2` | 2.36.19 | 单色 OLED 图形库；06/07 例程的星场与立方体 |

## 2. 安装步骤

1. 安装 IDE。装完如果自动打开了 IDE，先关掉。
2. 认不到 COM 口时，右键 `CP210x_Universal_Windows_Driver\silabser.inf` → 安装；
   或在设备管理器里右键带黄色感叹号的设备 → 更新驱动程序 → 浏览到该文件夹。装完拔插一次 USB 线。
3. 复制数据目录（**先关掉 Arduino IDE**）：

   | 源（`resources\arduino-offline\` 内） | 目标 |
   |---|---|
   | `Arduino15\` | `%LOCALAPPDATA%\Arduino15` |
   | `user-libraries\` | `%USERPROFILE%\Documents\Arduino\libraries` |

   目标目录已存在就合并，同名文件覆盖。PowerShell（在 `arduino-offline` 目录里执行）：

   ```powershell
   robocopy .\Arduino15 "$env:LOCALAPPDATA\Arduino15" /E
   robocopy .\user-libraries "$env:USERPROFILE\Documents\Arduino\libraries" /E
   ```

4. `arduino-cli` 不需要安装：直接用 `resources\arduino-cli\arduino-cli.exe`。
   它默认读写 `%LOCALAPPDATA%\Arduino15`，与 IDE 共用同一套 core 和库。
   本包的 `Arduino15\arduino-cli.yaml` 已登记 ESP32 板卡索引地址。

## 3. 验证

- **IDE**：`Tools → Board` 里出现 **ESP32 Dev Module**；`File → Examples` 里出现 **SCServo**、**Adafruit SSD1306**、**U8g2**。
- **CLI**（在 `resources\arduino-cli\` 目录）：

  ```powershell
  .\arduino-cli.exe core list
  ```

  应看到 `arduino:avr 1.8.8` 和 `esp32:esp32 4.0.0`。
- **编译冒烟**（可选，确认工具链完整）：

  ```powershell
  .\arduino-cli.exe compile --fqbn esp32:esp32:esp32 "..\arduino-offline\user-libraries\SCServo\examples\STSCL\Ping"
  ```

  通过时最后两行是 flash/RAM 占用（例：292265 bytes / 22%，23248 bytes / 7%）。

## 4. 交给学生机上的 agent

学生机装了 AI agent 时，把本节和 `resources\arduino-offline\README.txt` 一起给它，让它按下面执行：

1. 确认 IDE 已装（安装器在 `resources\`，静默参数可用 `/S`），IDE 进程不在运行。
2. 把 `arduino-offline\Arduino15` 合并到 `%LOCALAPPDATA%\Arduino15`，
   把 `arduino-offline\user-libraries` 合并到 `%USERPROFILE%\Documents\Arduino\libraries`。
3. 用 `resources\arduino-cli\arduino-cli.exe core list` 验证 `esp32:esp32 4.0.0`。
4. 不要联网下载或升级 core/库；缺什么先报告，不要自行换版本。

## 5. 离线包是怎么来的

本机装好一套 Arduino 环境后，把数据目录原样打包，学生复制即得到同样的版本组合：

- 只保留经典 ESP32 编译/烧录需要的工具：`esp-x32`、`esp32-libs`、`esptool_py`、`mkspiffs`、`mklittlefs`、`openocd-esp32`
- 剔除 `esp-rv32`（3.1 GB，ESP32-C/H/P 系列编译器）及其他芯片的 libs/gdb，也不含 `staging` 下载缓存
- 保留 Arduino AVR 1.8.8（247 MB）：不是编译 ESP32 的依赖，而是 Arduino IDE 2 首次启动会固定安装它；预置后首次启动不联网。
  若要删除，需在干净 Windows 用户或虚拟机上实测首次启动不卡。
- 只覆盖经典 ESP32（`esp32:esp32:esp32` / ESP32-WROOM-32）。其他型号（S2/S3/C3/C5/C6/H2/P4）
  的芯片库和 RISC-V 编译器已剔除，IDE 菜单里仍会列出这些板，但选中后编译会失败。
  GDB 也已剔除，IDE 的 Debug 按钮不可用；课程用串口日志。
- 已验证：2026-11-21 用隔离配置指向本包编译 `SCServo/examples/STSCL/Ping` 通过
  （`arduino-cli 1.6.0`，`esp32:esp32:esp32`，292329 B / 22% flash，23248 B RAM，exit 0）。
  同一编译也用 **Arduino IDE 2.3.11 自带的 arduino-cli**（版本同为 1.6.0）复跑通过，
  `core list`、`board listall`、`board details` 均正常。
- SCServo 升级到 **1.0.2** 后复测同一例程：292265 B / 22% flash，23248 B RAM，exit 0
  （比 1.0.1 少 64 B；1.0.2 的 release notes 仅标注 cleanup，API 未变）。
  课程 5 个灯链/OLED 例程（`examples/01`–`05`）在 1.0.1 下全部通过：281944 / 287552 / 288296 / 288736 / 351564 B。
  离线包现已同步为 1.0.2，并用包内 `SCServo/examples/STSCL/Ping` 复测通过。
- 2026-11-21 用同一套离线库编译并烧录 `examples/06_oled_warp`（U8g2 星际穿越）
  通过：355703 B / 27% flash，26676 B RAM / 8%，串口上传哈希校验通过。
- 2026-11-21 同法编译并烧录 `examples/07_oled_cube`（U8g2 旋转立方体）
  通过：349992 B / 26% flash，25532 B RAM / 7%，串口上传哈希校验通过。
- 2026-11-21 同法编译并烧录 `examples/09_servo_basic`（SCServo 1.0.2 + U8g2 + NVS 限位）
  通过：341989 B / 26% flash，25664 B RAM / 7%，串口上传哈希校验通过。
  本次实测舵机总线回 `0/3`（舵机没有响应，先查 12V/3P 线），命令与限位门控测试见
  [servo-basic.md](servo-basic.md)。
- 同一天连续烧录 09 时出现一次 **`Wrong boot mode detected (0x13)`**：第一次自动下载成功，
  紧接着第二次失败，重试后成功；上传日志在 `.local/upload-09-*.log`。说明自动复位不是 100%
  可靠，重试或手动 `BOOT + EN` 是正常后备，不是固件或 Flash 坏了。
- U8g2 源码目录 47.8 MB，主要是全部字体表；Arduino 编译时只链接实际引用的驱动与字体，
  所以离线包变大，但固件不会把整套字体都装进去。

## 6. 排错

| 现象 | 处理 |
|---|---|
| IDE 提示下载/更新 | 数据目录没复制进去，重新复制 `Arduino15`，确认复制到当前用户 |
| 板卡列表没有 ESP32 | 确认 `%LOCALAPPDATA%\Arduino15\packages\esp32` 存在 |
| 认不到 COM 口 | 装 `CP210x_Universal_Windows_Driver\silabser.inf`，装完拔插 USB |
| 编译报找不到 SCServo.h | `user-libraries` 没复制到 `Documents\Arduino\libraries` |
| 烧录失败/端口被占 | 关闭 IDE 串口监视器；确认端口号；上传速度降到 115200 |
| 一直卡在 `Connecting...` | 手动进下载模式：按住 BOOT → 点一下 EN → 松开 BOOT → 再点上传 |
| 复制后 IDE 仍用旧环境 | IDE 没关就复制了；关掉 IDE 重开，必要时重新复制 |

### 手动进下载模式（自动下载失败时）

板子有 CP2102 自动下载电路，正常不用按；但换电脑、换线、换工具时可能不触发。手动是正常后备，不是板子坏了。

1. 关掉串口监视器和其他占用 COM 口的工具；Arduino IDE 选 **ESP32 Dev Module**，上传速度先降到 **115200**。ESP32 Dev Module 默认上传速度是 **921600**；115200 是排错档，不是应用串口监视器的 115200。
2. **按住 BOOT**（板子上的 `BOOT` / `KEY_FLASH`，接 IO0），不要松。
3. 点一下 **EN**（`EN` / `KEY_RST`，复位），松开 EN；此时仍按住 BOOT。
4. 松开 BOOT，点上传。
5. 看到 `Connecting...` 后等写入完成；上传完按一下 **EN**，让板子从下载模式回到运行。

如果还是连不上：换一根能传数据的 USB-C 线、换 USB 口；确认 `Tools → Port` 是 CP210x 的 COMx；装 `CP210x_Universal_Windows_Driver\silabser.inf`。烧录只需要 USB，12V 可以关掉；如果舵机接着，先关 12V 并扶住手臂。

### 为什么同一块板子，这台电脑能自动、另一台不能

自动下载靠的是 **CP2102 的 DTR/RTS → 两个三极管 → EN / IO0**，不是板子“认电脑”。以下主机侧差异最常见：

| 差异 | 表现 | 处理 |
| --- | --- | --- |
| 串口监视器/网页控制台占用 COM | 上传报端口忙，或复位后连不上 | 先关掉所有占用串口的工具 |
| USB Hub / KVM / 扩展坞 | DTR/RTS 控制传输被吞，自动下载不触发 | 换到电脑直出 USB 口 |
| 虚拟机 / 远程 USB 透传 | 串口能用，但控制线不稳定 | 本机直连，或手动 BOOT |
| 充电线 / 劣质线 | 可能连 COM 都没有，或时好时坏 | 换能传数据的线 |
| CP210x 驱动/旧驱动 | 端口异常、复位行为不一致 | 装包内驱动，重插 USB |
| Windows USB 省电 | 空闲后端口被挂起，第一次上传失败 | 设备管理器里关掉该 COM 口的省电 |
| 上传速度 921600 | 复位后握手失败 | 降到 115200 |
| 工具不拉 DTR/RTS | 例如裸串口工具/部分网页工具 | 手动 BOOT，或换 Arduino IDE/arduino-cli |

判断方法：

- **同一块板**：A 机能自动、B 机不能 → 问题在 B 机的主机/工具/线/端口，不是板子。
- **同一台电脑**：这块板不能自动、另一块能 → 才更像板子的自动下载电路或线序问题。
- **手动 BOOT 能烧**：芯片、USB 串口和 Flash 都正常，只是自动复位没触发；可以一直手动，不必修板。
