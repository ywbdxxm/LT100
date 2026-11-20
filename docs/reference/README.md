# LT100 参考资料（官方原件）

- 下载日期：**2026-11-20**
- 来源：微雪官方 wiki / 飞特（Feetech）官网 / WorldSemi 数据手册
- 文件按原样保存，未做任何修改；下表哈希为本次下载的快照，官方若更新会不一致
- 这些是**只读参考**，不要在这里改文件；结论写进 [design.md](../design/design.md) 或 [build-bom.md](../build/bom.md)

---

## board/ — 微雪 Servo Driver with ESP32

| 文件 | 是什么 | 大小 | sha256（前 16 位） |
|---|---|---|---|
| `servo-driver-esp32-user-manual-cn.pdf` | 中文用户手册（接线、例程、Web UI） | 1.9 MB | `fb0101b66d64ded1` |
| `servo-driver-esp32-board-schematic.pdf` | **整板原理图**（1 页）：6–12V 输入、5V/3.3V 电源、CP2102 USB、ESP32、按键、OLED、WS2812、舵机驱动 | 478 KB | `5c40860cdcc3a2e2` |
| `bus-servo-driver-schematic.pdf` | 总线舵机控制电路**子图**（1 页）：TX/RX 缓冲 + 5264 接口；整板图里也有这一块 | 27 KB | `2abebb4b5e9d71a1` |
| `servo-driver-esp32-step.zip` | 板子 3D 模型（STEP），结构设计用 | 725 KB | `41d60fec860dbe42` |
| `factory-firmware-st.rar` | ST 系列出厂固件（恢复出厂用） | 20.9 MB | `b8668f0a78fbcfe5` |
| `factory-firmware-sc.rar` | SC 系列出厂固件（对照/备用，LT100 用 ST） | 20.9 MB | `8e172af45699571f` |
| `cp210x-usb-uart-driver.zip` | CP210x USB 串口驱动（Windows 认不到 COM 口时用） | 4.7 MB | `7cb2b9b40e5279e5` |

来源：
- 手册 <https://www.waveshare.net/w/upload/d/d6/Servo-Driver-with-ESP32-user-manual-cn.pdf>
- 整板原理图 <https://www.waveshare.net/w/upload/e/e6/Servo_Driver_with_ESP32.pdf>（wiki 文件页 `文件:Servo_Driver_with_ESP32.pdf`）
- 舵机驱动子图 <https://www.waveshare.net/w/upload/5/54/总线舵机驱动电路原理图.pdf>
- STEP <https://www.waveshare.net/w/upload/2/28/Servo_Driver_with_ESP32_STEP.zip>
- ST 出厂固件 <https://www.waveshare.net/w/upload/8/8b/SERVO_DRIVER_WITH_ESP32_ST_FACTORY.rar>
- SC 出厂固件 <https://www.waveshare.net/w/upload/c/c5/SERVO_DRIVER_WITH_ESP32_SC_FACTORY.rar>
- CP210x 驱动 <https://www.waveshare.net/w/upload/6/62/CP210x_USB_TO_UART.zip>
- 官方 wiki <https://www.waveshare.net/wiki/Servo_Driver_with_ESP32>

> 出厂固件 ST / SC 两个版本都已存档，我们用的是 **ST**（ST3215）。里面是烧录工具和镜像，不是源码。

---

## servo/ — ST3215-C018

| 文件 | 是什么 | 大小 | sha256 |
|---|---|---|---|
| `st-3215-c018-datasheet.pdf` | 飞特官方数据手册（8 页，含参数、尺寸图、接线） | 567 KB | `d0a735a8ddc23585` |

来源：<https://www.feetechrc.com/525603>（产品页）→ <https://www.feetechrc.com/Data/feetechrc/upload/file/20260622/6391772519923113075854851.pdf>

关键参数（设计文档里也有一份）：4–14V、堵转 30kg·cm@12V、额定 10kg·cm、空载 0.222s/60°、
空载 180mA / 堵转 2.7A、12 位磁编码 0–4096、半双工串行 38.4k–1Mbps、ID 0–253、25T 花键。

---

## led/ — WS2812B

| 文件 | 是什么 | 大小 | sha256 |
|---|---|---|---|
| `ws2812b-datasheet.pdf` | WorldSemi WS2812B 数据手册（5 页） | 347 KB | `670517e400d01f76` |

来源：<https://cdn-shop.adafruit.com/datasheets/WS2812B.pdf>（Adafruit 镜像的原厂手册）

> 注意：这是**单颗灯珠**的手册；24 灯环的接线（DI/DO、5V/GND）以卖家资料为准，环内是串接的。

---

## software/ — 例程与库

| 文件 | 是什么 | 大小 | sha256 |
|---|---|---|---|
| `st-servo-examples.zip` | 微雪 **ST 系列** Arduino 例程（我们用这个） | 33 KB | `0250d7138a192776` |
| `sc-servo-examples.zip` | 微雪 **SC 系列** Arduino 例程（对照用） | 38 KB | `eeed376ccfb6f576` |
| `scstservo-library.zip` | SC/ST Arduino 库（`SCServo`/`STServo`） | 24 KB | `eb373b1d2354b540` |
| `stservo-python.zip` | ST/SC Python 控制库 | 8.7 MB | `f39b7a07324b6857` |

来源：
- ST 例程 <https://www.waveshare.net/w/upload/d/d8/ST_Servo.zip>
- SC 例程 <https://www.waveshare.net/w/upload/5/5a/SERVO_DRIVER_WITH_ESP32.zip>
- Arduino 库 <https://www.waveshare.net/w/upload/2/22/SCSTServoLibrary.zip>
- Python 库 <https://www.waveshare.net/w/upload/9/95/STServo_Python.zip>

**ST 还是 SC？** ST3215 属于 ST 系列，例程和库都要走 ST 分支；SC 例程只是拿来对照。
如果 Web UI 或例程扫不到舵机，先查 `STSCTRL.h` 里是不是还停在 `CTRL_SC_SERVO`。

---

## 没下的资料

- `Robots.zip`（<https://www.waveshare.net/w/upload/2/21/Robots.zip>，3.7 MB）——微雪自家的蜘蛛/机械臂 STEP 结构件，**不是 LT100 这套台灯结构**；已看过清单，没存
- 舵机协议细节（内存表地址）——在 ST 例程的库源码里，不在数据手册
- 3D 打印件（机械臂结构）——已切片的 14 个 3MF 在 `LT100/结构/`，直接进打印机
