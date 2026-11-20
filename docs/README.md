# LT100 文档索引

```text
docs/
├── design/           设计与规格
│   └── design.md
├── build/            采购与搭建
│   ├── bom.md
│   └── purchase-list.md
├── teach/            教学
│   ├── course-4h.md
│   └── arduino-env.md
└── reference/        官方原件（手册/原理图/数据手册/例程）
    ├── board/  servo/  led/  software/
    └── README.md
```

| 文档 | 内容 | 什么时候看 |
|---|---|---|
| [design/design.md](design/design.md) | 定位、机械/电气现状、架构、硬件契约、灯光、教学模块、风险、升级 | 改方案、查参数 |
| [build/bom.md](build/bom.md) | BOM、实付成本、接线图、选购要点、到货检查、FAQ | 买件、接线、排障 |
| [build/purchase-list.md](build/purchase-list.md) | 30 套实付台账（¥4342.94） | 对账、报销 |
| [teach/course-4h.md](teach/course-4h.md) | 4 小时课：A 装配线 / B AI Agent 线 | 备课、上课 |
| [teach/arduino-env.md](teach/arduino-env.md) | 学生机离线 Arduino 环境：资源、安装、验证、agent 执行说明 | 装机、排障 |
| [reference/README.md](reference/README.md) | 官方原件清单、来源与哈希 | 查一手资料 |

约定：

- 结论写进 design / build / teach，不写进 `reference/`
- `reference/` 里的文件保持原样，不改名、不编辑
- 页面版在 `../../web/`，目前只有主控板一块
