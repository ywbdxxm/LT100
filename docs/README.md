# LT100 文档索引

```text
docs/
├── design/           设计与规格
│   ├── design.md
│   └── serial-console.md
├── build/            采购与搭建
│   ├── bom.md
│   └── purchase-list.md
├── teach/            教学
│   ├── course-4h.md
│   ├── arduino-env.md
│   ├── flashing.md
│   ├── flashing-crosscheck.md
│   ├── kinematics-and-force.md
│   ├── serial-console.md
│   └── servo-basic.md
└── reference/        官方原件（手册/原理图/数据手册/例程）
    ├── board/  servo/  led/  software/
    └── README.md
```

| 文档 | 内容 | 什么时候看 |
| --- | --- | --- |
| [design/design.md](design/design.md) | 定位、机械/电气现状、架构、硬件契约、灯光、教学模块、风险、升级 | 改方案、查参数 |
| [design/serial-console.md](design/serial-console.md) | 串口控制台设计：协议、命令、状态机、错误码 | 改固件、定协议 |
| [build/bom.md](build/bom.md) | BOM、实付成本、接线图、选购要点、到货检查、FAQ | 买件、接线、排障 |
| [build/purchase-list.md](build/purchase-list.md) | 30 套实付台账（¥4342.94） | 对账、报销 |
| [teach/course-4h.md](teach/course-4h.md) | 4 小时课：A 装配线 / B AI Agent 线 | 备课、上课 |
| [teach/arduino-env.md](teach/arduino-env.md) | 学生机离线 Arduino 环境：资源、安装、验证、agent 执行说明 | 装机、排障 |
| [teach/flashing.md](teach/flashing.md) | 烧录：课堂由人用 IDE 按住 BOOT；含 921600、验证、进阶 merged 镜像 | 烧录、排障 |
| [teach/flashing-crosscheck.md](teach/flashing-crosscheck.md) | **内部排查记录**：自动下载失败的对照实验与采集脚本（学生不用看） | 老师/维护者继续定位 |
| [teach/kinematics-and-force.md](teach/kinematics-and-force.md) | 3R 平面臂运动学（FK/IK/工作空间/误差）+ 静力学（力臂/电流/柔顺）+ 7 个课堂实验 | 备物理课、讲原理 |
| [teach/serial-console.md](teach/serial-console.md) | 串口控制台：UART 参数、命令表、OLED/灯行为、主机工具 | 学串口、改命令 |
| [teach/servo-basic.md](teach/servo-basic.md) | 舵机基础：闭环、总线、逐关节标定与限位、09 例程 | 学舵机、标定限位 |
| [reference/README.md](reference/README.md) | 官方原件清单、来源与哈希 | 查一手资料 |

约定：

- 结论写进 design / build / teach，不写进 `reference/`
- `reference/` 里的文件保持原样，不改名、不编辑
- 页面版在 `../../web/`：主控板、串口控制台、舵机标定台
