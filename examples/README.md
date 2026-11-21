# LT100 课程例程

按课次编号，目录名保持稳定；每个目录里只有该课的 `.ino`。

| 例程 | 内容 | 额外库 | 对应文档 |
|---|---|---|---|
| [01_blink_rgb](01_blink_rgb/) | 板载 2 颗 RGB 闪烁 | NeoPixel | [串口/灯](../docs/teach/serial-console.md) |
| [02_rainbow_breathe](02_rainbow_breathe/) | 彩虹与呼吸 | NeoPixel | [串口/灯](../docs/teach/serial-console.md) |
| [03_ring_show](03_ring_show/) | 单灯环灯效 | NeoPixel | — |
| [04_dual_ring_show](04_dual_ring_show/) | 双灯环灯效 | NeoPixel | — |
| [05_oled_wave](05_oled_wave/) | OLED 波形（SSD1306） | SSD1306/GFX、NeoPixel | — |
| [06_oled_warp](06_oled_warp/) | OLED 星际穿越（U8g2） | U8g2、NeoPixel | — |
| [07_oled_cube](07_oled_cube/) | OLED 旋转立方体（U8g2） | U8g2、NeoPixel | — |
| [08_serial_console](08_serial_console/) | 串口控制台：灯/OLED/状态，**不接舵机** | U8g2、NeoPixel | [serial-console.md](../docs/teach/serial-console.md) |
| [09_servo_basic](09_servo_basic/) | 公版舵机标定/检测，`LT100P/1` | `LT100Core`、`LT100Board`、SCServo、U8g2 | [servo-basic.md](../docs/teach/servo-basic.md) |

公版库在 [`platform/libraries`](../platform/libraries/)；安装方法见
[arduino-env.md](../docs/teach/arduino-env.md)。整机 app 在
[`platform/apps/lt100_lamp`](../platform/apps/lt100_lamp/)。
