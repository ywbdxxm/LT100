# LT100 — 三轴平面机械臂台灯教具

智能硬件教学教具：3R 平面机械臂（肩/肘/腕三轴共面）+ 3×ST3215 总线舵机 + ESP32 + WS2812 灯环。
不是对外销售的产品，优先可观察、可测量、可拆改。

## 当前版本（2026-11-18 定稿）

当前组合：微雪 Servo Driver with ESP32（实付 ¥81.20）+ 3×ST3215-C018 + 24 灯 WS2812 圆环。

- 主控板：ESP32-WROOM-32、ST3215 总线、0.91" OLED、1.25mm 3P WS2812 扩展（板子标 PH1.25）
- 灯环：24 灯、5V、72mm 外径 / 54mm 内径，放进 10cm 灯罩
- 电源：12V 5A 给主控板/舵机；灯环从主控板 1.25mm 3P 口的 5V 取电，固件限 40% 亮度
- 不做 BH1750、不做编码器、不做 COB 调光；灯环做颜色/亮度/状态

```text
12V 5A ── 主控板 ── 3× ST3215（5264 串接）
主控板 1.25mm 3P（板子标 PH1.25）：5V → 灯环 5V；GND → 灯环 GND；OUT → 灯环 DIN
USB-C ── 电脑（仅烧录/串口；12V 走板子的 DC 5.5×2.1 圆孔）
```

40% 时灯环约 0.58A，加 ESP32/OLED 约 0.78A；按板载 5V 约 1A 估算，留约 0.2A 余量。

## 文档

- 主设计（定位/架构/契约/实验/风险）：[docs/design/design.md](docs/design/design.md)
- **公版设计**（共用底座/协议/标定/安全/测试）：[docs/design/common-platform.md](docs/design/common-platform.md)
- **交互应用清单**（孪生/IK/覆盖/示教/灯效）：[docs/design/interactive-applications.md](docs/design/interactive-applications.md)
- **公版固件**（构建/测试/标定与运动操作）：[platform/README.md](platform/README.md)
- 采购与搭建（BOM/接线/到货检查/FAQ）：[docs/build/bom.md](docs/build/bom.md)
- 4 小时课（A 装配线 / B AI Agent 线）：[docs/teach/course-4h.md](docs/teach/course-4h.md)
- 运动学与力学（FK/IK、工作空间、力臂与电流、7 个实验）：[docs/teach/kinematics-and-force.md](docs/teach/kinematics-and-force.md)
- 学生机离线 Arduino 环境（安装/验证/agent 执行）：[docs/teach/arduino-env.md](docs/teach/arduino-env.md)
- 烧录（课堂：人用 IDE 按住 BOOT；含 921600、验证与进阶 merged 镜像）：[docs/teach/flashing.md](docs/teach/flashing.md)
- 自动下载对照实验（**内部排查记录**，学生不用看）：[docs/teach/flashing-crosscheck.md](docs/teach/flashing-crosscheck.md)，脚本 [tools/flash-probe.ps1](tools/flash-probe.ps1)
- 串口控制台（UART/命令表/OLED/灯/主机工具）：[docs/teach/serial-console.md](docs/teach/serial-console.md)
- 舵机基础（闭环/总线/逐关节标定/限位）：[docs/teach/servo-basic.md](docs/teach/servo-basic.md)
- 网页应用门户（按固件选入口）：[web/index.html](web/index.html)，双击 [start-lt100.bat](start-lt100.bat) 启动
- 08 网页串口控制台（灯/OLED/状态，需 08 固件）：[web/serial.html](web/serial.html)，双击 [start-web-console.bat](start-web-console.bat) 启动
- 09 网页标定与检测台（零点/方向/raw 端点、状态检测、低速端点测试，需 09 固件）：[web/servo.html](web/servo.html)，双击 [start-servo-console.bat](start-servo-console.bat) 启动
- 采购台账（30 套实付，¥4342.94）：[docs/build/purchase-list.md](docs/build/purchase-list.md)
- 官方参考资料（手册/原理图/数据手册/例程）：[docs/reference/README.md](docs/reference/README.md)
- 课程例程（按课次编号）：[examples/](examples/)
- 现状照片：[hardware/photos/front.jpg](hardware/photos/front.jpg)、[hardware/photos/side.jpg](hardware/photos/side.jpg)
- 结构打印件（14 个切片好的 3MF）：[hardware/prints/](hardware/prints/)；板子 STEP 在 [hardware/cad/](hardware/cad/)

## 目录

```text
LT100/
├── docs/          设计、教学、采购、参考资料
├── examples/      01–09 课程例程（索引见 examples/README.md）
├── platform/      公版：libraries/ 库、apps/ 整机 app、tests/
├── tools/         网页控制台、串口桥、烧录探针
├── web/           课程页面（页面版）
├── hardware/      物理资产：prints/ 3MF、cad/ STEP、photos/ 照片
├── resources/     学生机离线 Arduino 包（约 2.2GB，本地保留、不进 git）
└── .local/        本地日志、证据、构建缓存（不进 git）
```

`.local/` 里的构建目录可以随时删；日志、截图和标定/串口证据保留。

> **学生分发包**在 `student-package/`（已加入 `.gitignore`）。`resources/` 已移入包内；
> 工作区根的 `resources/` 只是指向包内 `resources/` 的目录联接，用来保留旧文档和网页的相对路径。
> 学生包只带 08/09 的完整源码；01–07 每个文件夹只有 README 练习说明，没有 `.ino` 成品。
> 详见 [student-package/README.md](student-package/README.md)。
> 分发归档是同目录的 `student-package-2026-11-22.zip`（约 905 MB，已在 `.gitignore`；
> 解压到 `C:\lt100` 这类短路径，包内最深相对路径 246 字符，路径太长会超 260）。

## 当前状态

- 结构 + 3×ST3215-C018 已装配（2026-11 实物见 `hardware/photos/`）
- 30 套电料已下单到货：主控板、12V 5A 电源、24 灯环（黑 15 + 白 15）、Type-C 线、
  1.25mm/SM2.54 转杜邦、杜邦线；工具两把胶枪 + 电动螺丝刀
- **未装**：灯环、转接线、扩散片；灯环接口与线色已确认（见 BOM）
- 灯罩内壁橙色；白色 PET 反光膜选装
- **公版 Phase 0**：`lt100_core` + `lt100_board` + `lt100_lamp` 已实现，09 已迁到公版，host/协议测试全过、固件编译通过；**未做三关节实板标定/运动验证**（当前只接了 ID1）。
- 标定/检测页已接 `LT100P/1`，mock 流程与低速端点测试通过；08 只做灯/OLED/状态，不接舵机。

## 后续升级（当前不做）

要加 BH1750/编码器/COB 调光，小 board 没有外部 GPIO，需换：

- **General Driver for Robots**（¥145–152）：IIC/PWM/编码电机口/IMU/INA219
- **ESP32-S3 + 灵影 TTL Adapter + 8P Hub**（约 ¥78）：全 GPIO，4 个模块

详见 [docs/build/bom.md](docs/build/bom.md) §10 与主设计 §10。
