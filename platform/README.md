# LT100 公版平台

这是所有上层应用共用的固件底座。设计依据见
[`docs/design/common-platform.md`](../docs/design/common-platform.md)；
应用清单见 [`docs/design/interactive-applications.md`](../docs/design/interactive-applications.md)。

## 当前状态（2026-11-21）

| 项 | 状态 |
| --- | --- |
| 协议/标定/限位/Core 状态机 | 已实现 |
| Host 纯逻辑测试 | `all checks passed` |
| ESP32 固件编译 | `arduino-cli compile --warnings all` 通过；351,521 B flash / 25,792 B RAM |
| 编译警告 | 本项目源码无警告；SCServo 1.0.2 的 `ReadMode` 有上游 `-Warray-bounds` 警告，本项目不调用该函数 |
| 真板运动验证 | **未做**；当前只接了 ID1，ID2/3 离线，不能验证三关节 `POSE` |
| 网页 SDK | 未开始 |

> 编译通过、host 测试通过都不等于产品验收。真板必须先做标定与低速端点验证，
> 再谈应用。

## 目录

```text
platform/
├── firmware/
│   ├── lt100_core/            # Arduino library: protocol/calibration/limits/core
│   │   ├── library.properties
│   │   └── src/
│   │       ├── LT100Core.h
│   │       └── lt100/*.h,*.cpp
│   └── apps/
│       └── lt100_lamp/        # 整机 sketch: SCServo HAL + NVS + OLED + 串口
└── tests/
    └── host/
        ├── host_tests.cpp     # 无 Arduino 依赖的 fake HAL 测试
        └── run-tests.ps1      # MSVC vcvars64 构建 + 运行
```

## 编译固件

在 `LT100/` 目录执行（路径相对仓库；不要写死 COM 口）：

```powershell
arduino-cli compile `
  --fqbn esp32:esp32:esp32 `
  --libraries ".\platform\firmware" `
  --build-path ".\.local\build-lt100-lamp" `
  ".\platform\firmware\apps\lt100_lamp"
```

`--libraries` 指向包含 `lt100_core/` 的父目录，Arduino CLI 会把 `lt100_core`
当作名为 `LT100Core` 的库。

验证环境：Arduino CLI 1.6.0、ESP32 core 4.0.0、SCServo 1.0.2、U8g2 2.36.19。

## 跑 host 测试

在 `LT100/` 目录执行：

```powershell
pwsh -NoProfile -File ".\platform\tests\host\run-tests.ps1"
```

脚本用本机 MSVC 2022 BuildTools 的 `vcvars64.bat`，不需要 Arduino。
测试覆盖：

- 标定换算（含 `zero_q`、方向、raw 边界、checksum）；
- 软件限位（未标定、越界、速度/加速度参数）；
- `LT100P/1` 解析（POSE/STREAM/CAL/TORQUE、错误与超长行）；
- Core 状态机（未标定拒绝、标定会话、扭矩门禁、失联、离线、CLEAR、状态流）。

## 串口操作顺序（真板）

USB 串口 **115200 8N1**，行尾 `\n`；舵机总线 **1Mbps**，UART1
GPIO18=RX / GPIO19=TX。上电不自动运动。

标定（人必须扶住手臂，12V 已上电）：

```text
HELLO
STATE
TORQUE all OFF
CAL REF 1 <参考姿态的模型角 q1>
CAL DIR 1 +1            # 或 -1，按实际安装方向
CAL MARK 1 MIN          # 手移到安全端点，不要撞死点
CAL MARK 1 MAX
# 对 ID2、ID3 重复 CAL REF/DIR/MARK
CAL SAVE
CAL STATUS
LIMITS
TORQUE all ON
STATE
```

运动：

```text
POSE seq=1 q=<q1>,<q2>,<q3> speed=30 acc=20
STREAM ON
STREAM OFF
STOP
ESTOP
CLEAR
```

- `speed` 单位是度/秒（1..52，默认 22）；`acc` 是舵机加速度寄存器 0..254。
- `CAL REF/DIR/MARK` 会进入 `CAL` 模式；`CAL` 下 `POSE` 和 `TORQUE ON` 被拒绝。
- `CAL SAVE` / `CAL CLEAR` 退出 `CAL`。未保存的标定掉电丢失；想放弃未保存编辑又不改 NVS，直接重启。
- `STOP` 只停止接受新目标，保持最后目标；`ESTOP` 锁存，需 `CLEAR`。

## 安全边界（当前硬件）

- **没有机械硬限位**：标定出的 `min_raw/max_raw` 加 margin 是唯一保护。
- **没有弹簧/配重**：失力会掉臂；`TORQUE OFF` 前必须扶住。
- 任一舵机离线 → `FAULT`，停止自动运动；恢复后需 `CLEAR`。
- 失联 300ms → 停止接受新 `POSE`，保持最后目标，不自动卸力。
- `load` 是输出电压百分比，不是电流；过温/掉压保护尚未接入 Core。

## 尚未实现

- `PRESET`、`LED`、`EVT`、过温/掉压自动降额、力矩上限；
- 网页 SDK / 2D 孪生 / 标定向导；
- 真板 HIL 脚本与 30 分钟连续运动记录；
- 机械硬限位、弹簧/配重（学生改进项目）。
