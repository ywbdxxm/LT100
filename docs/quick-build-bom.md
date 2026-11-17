# LT100 快速搭建 BOM（4 小时课版）

- 日期：2026-11-17
- 目标：**不画板、不焊板、不写新固件**，用淘宝现成模块，4 小时内让一个工位跑起来
- 适用：教师/助教先跑通，再复制到学生工位

---

## 1. 采购原则

1. **能买成品就不做**：总线转接板、降压模块、MOS 管模块全部买带端子的。
2. **不焊接**：DC 口用免焊转端子，灯板买「带线」款，舵机线买成品 5264。
3. **一个 12V 电源**：舵机、LED、ESP32（经 buck）共用，减少讲电源的时间。
4. **先跑通再优化**：课上用 Ra90 的 12V COB；Ra95 作为课后升级，不占课堂时间。

---

## 2. 单工位 BOM

| 类别 | 物料（点击进商品页） | 推荐规格 | 数量 | 单价 | 备注 |
|---|---|---|---|---|---|
| 控制 | [ESP32-S3 开发板](https://item.taobao.com/item.htm?id=927404705261) | N16R8，44Pin，Type-C | 1 | ¥23.5 | 200+ 付款；别买 4MB Flash 版 |
| 总线 | [灵影 TTL Adapter (A)](https://item.taobao.com/item.htm?id=983866781632) | UART ↔ 飞特 ST/SC 总线 | 1 | ¥26 | 套餐 2 带数据线即可 |
| 总线 | [灵影 5264 8P Hub](https://item.taobao.com/item.htm?id=992302020901) | 分组供电 + 信号分配 | 1 | ¥18 | 3 个舵机不要从转接板细线取电 |
| 电源 | [12V 5A 适配器](https://item.taobao.com/item.htm?id=535595427494) | 3C，DC5.5×2.1 | 1 | ¥19 | 不要用 12V 2A |
| 电源 | [DC5521 免焊转端子](https://detail.tmall.com/item.htm?id=628550408976) | 母头转快速接线端子 | 1 | ¥7.48 | 600+ 付款 |
| 电源 | [LM2596 降压模块](https://item.taobao.com/item.htm?id=600527214039) | 带接线端子 | 1 | ¥3 | 上电前先调到 5.0V |
| 光源 | [12V COB 灯板 10W 带线](https://item.taobao.com/item.htm?id=830753777837) | 恒压 12V，3000/4000K | 1 | ¥4.5 起 | 课堂用 Ra90 即可 |
| 光源 | [逻辑电平 MOS 管模块](https://item.taobao.com/item.htm?id=687204896504) | N 沟道，低边，带端子 | 1 | ¥5.94 | 用来 PWM 调光 |
| 传感 | [BH1750 GY-302](https://item.taobao.com/item.htm?id=753672368913) | I2C，3.3V，0x23 | 1 | ¥3.1 | 1000+ 付款 |
| 交互 | [KY-040 旋转编码器](https://item.taobao.com/item.htm?id=648728887153) | 带按键 | 1 | ¥3.59 | 调亮度/切预设 |
| 线材 | [5264-3P 总线舵机线](https://item.taobao.com/item.htm?id=587191439333) | 30–50cm，双头 | 3 | ¥2 | 与 ST3215 配套 |
| 光学 | [乳白亚克力圆片](https://item.taobao.com/item.htm?id=759027988845) | Ø100mm，2mm，乳白/磨砂 | 1 | ¥2.9 起 | 下单备注直径 |
| 光学 | [白色 PET 反光膜](https://detail.tmall.com/item.htm?id=1025255397140) | 自粘，0.2mm | 1 | ¥11.8 | 贴灯罩内壁，解决橙色染色 |
| 散热 | [2mm 铝板](https://item.taobao.com/item.htm?id=38623444649) | 100×100×2mm，可定制 | 1 | ¥3 起 | COB 的散热基板 |
| 辅料 | [WAGO 接线端子](https://item.taobao.com/item.htm?id=670709536126) | 221 系列，混装 | 1 套 | ¥2.29/个 | 课堂尽量免焊 |
| 辅料 | USB-C 数据线 | 能传数据 | 1 | ¥5 | 不要买纯充电线 |
| 保护 | [5A 保险丝座](https://item.taobao.com/item.htm?id=650467623373) | 5×20mm，带线 | 1 | ¥2.6 | 串在 12V 总线上 |

**单工位新增成本：约 ¥150–230**（不含已有的 3 只 ST3215 和机械结构）。

---

## 3. 教师/班级共用

| 物料 | 数量 | 单价 | 用途 |
|---|---|---|---|
| [飞特 URT-2 调试板](https://s.taobao.com/search?q=%E9%A3%9E%E7%89%B9+URT-2+%E8%B0%83%E8%AF%95%E6%9D%BF) | 1 | ¥45 | 课前设 ID、验舵机、救砖 |
| [备用 ST3215-C018](https://item.taobao.com/item.htm?id=769061524145) | 1 | ¥99 | 坏一个立刻换，不拖堂 |
| [备用 ESP32-S3](https://item.taobao.com/item.htm?id=927404705261) | 1 | ¥23.5 | 同上 |
| [备用 TTL Adapter](https://item.taobao.com/item.htm?id=983866781632) + 线材 | 1 套 | ¥30 | 同上 |
| 万用表 | 1–2 | ¥30–50 | 测 12V/5V/电流 |
| 12V 汽车灯泡或功率电阻 | 1 | ¥5 | 先验证电源，不接主板 |
| 小十字螺丝刀/剪线钳/剥线钳 | 1 套 | ¥30 | 装配 |

**班级共用新增：约 ¥220–260**（按 6 个工位算，摊到每工位约 ¥40）。

---

## 4. 接线图

```
12V 5A ── DC5521免焊端子 ──┬── 8P Hub 电源 ── 3× ST3215（串联）
                           ├── 12V→5V buck ── ESP32 5V / GND
                           └── COB 12V+ ── MOS 管漏极
                                            │
COB 12V- ───────────────────────────────────┘
MOS 管源极 ── GND；栅极 ── ESP32 GPIO（串 100Ω，10k 下拉）

ESP32 UART2 TX/RX/GND ── TTL Adapter ── 8P Hub 信号
ESP32 3V3/GND ── BH1750 VCC/GND；GPIO ── SDA/SCL
ESP32 3V3/GND ── KY-040 +/GND；GPIO ── CLK/DT/SW
```

**共地**：12V 负极、5V 负极、ESP32 GND、MOS 源极、传感器 GND 必须接在一起。

---

## 5. 选购要点

### 5.1 ESP32-S3

- 选 **N16R8**（16MB Flash + 8MB PSRAM），Arduino/PlatformIO 都支持。
- 44Pin DevKitC-1 兼容板即可，约 ¥24–33；不要买只有 4MB Flash 的旧版。
- 板子要带 **Type-C 数据口**，不是只有供电。

### 5.2 总线转接

- 必须买 **飞特 ST/SC 系列** 的 TTL 转接板，不是 RS485/CAN。
- 灵影 TTL Adapter (A) 有 UART 侧（5V/GND/TX/RX）和 5264 侧；资料：<https://wiki.lygion.ai/reference/bus-devices/ttl-adapter-a/>。
- **确认 UART 侧逻辑电平**：如果转接板 TX 是 5V，ESP32 RX 要分压（1k/2k）或用电平转换；ESP32 TX 3.3V 一般能被 5V 端识别，但以 wiki 为准。
- 3 个舵机总电流可能到 1.5–2A，**电源走 8P Hub**，不要从转接板细线取。

### 5.3 电源

- 12V 5A，3C 认证，DC5.5×2.1。
- 上电顺序：先接 12V 灯泡验证 → 测 12V → 接 buck 调到 5.0V → 再接 ESP32 → 最后接舵机。
- 总线入口加 1000µF 电解 + 0.1µF 陶瓷（可选，但强烈建议）。

### 5.4 光源

- 课堂用 **12V 10W COB 带线灯板**，直接 12V + MOS 低边 PWM。
- **必须买「恒压 12V」版（板上有限流电阻/驱动）**；裸 COB 直接上 12V 会过流。不确定就问客服「能不能直接接 12V」。
- 想要 Ra95：买 10W 全光谱 COB（裸片）+ 12V 恒流驱动，作为课后升级；课上不折腾。
- COB 必须贴铝板 + 导热硅脂，不能只靠塑料灯罩。

### 5.5 光学

- 灯罩内壁橙色：贴 **白色 PET 反光膜**，或喷哑光白。课上用反光膜，5 分钟搞定。
- 扩散片：Ø100mm 乳白亚克力，2mm；离 COB 至少 15mm，避免热点。
- 反光膜 + 扩散片是最低成本解决「橙色染色 + 眩光」的组合。

### 5.6 推荐下单清单（2026-11-17 页面）

| 物料 | 推荐商品 | 价格 |
|---|---|---|
| ESP32-S3 | [N16R8 44Pin Type-C](https://item.taobao.com/item.htm?id=927404705261) | ¥23.5 |
| TTL Adapter | [灵影 TTL Adapter (A)](https://item.taobao.com/item.htm?id=983866781632)，套餐 2 | ¥26 |
| 8P Hub | [灵影 5264 8P Hub](https://item.taobao.com/item.htm?id=992302020901) | ¥18 |
| 12V 5A | [3C 认证适配器](https://item.taobao.com/item.htm?id=535595427494) | ¥19 |
| DC5521 端子 | [免焊转接线端子](https://detail.tmall.com/item.htm?id=628550408976) | ¥7.48 |
| LM2596 | [带接线端子降压模块](https://item.taobao.com/item.htm?id=600527214039) | ¥3 |
| COB 10W | [12V 带线 COB 灯板](https://item.taobao.com/item.htm?id=830753777837) | ¥4.5 起 |
| BH1750 | [GY-302 BH1750](https://item.taobao.com/item.htm?id=753672368913) | ¥3.1 |
| KY-040 | [旋转编码器模块](https://item.taobao.com/item.htm?id=648728887153) | ¥3.59 |
| 5264 线 | [5264-3P 总线舵机线](https://item.taobao.com/item.htm?id=587191439333) | ¥2 |
| 乳白亚克力 | [乳白圆形灯片](https://item.taobao.com/item.htm?id=759027988845)，定制 Ø100×2mm | ¥2.9 起 |
| 反光膜 | [白色 PET 自粘反光膜](https://detail.tmall.com/item.htm?id=1025255397140) | ¥11.8 |
| 铝板 | [2mm 铝板](https://item.taobao.com/item.htm?id=38623444649)，定制 100×100 | ¥3 起 |
| 保险丝座 | [5×20 带线保险丝座](https://item.taobao.com/item.htm?id=650467623373) | ¥2.6 |
| WAGO 端子 | [221 系列接线端子](https://item.taobao.com/item.htm?id=670709536126) | ¥2.29/个 |
| 舵机 | [ST3215-C018](https://item.taobao.com/item.htm?id=769061524145) | ¥99 |

> 这些是「能买到、有人买过、价格合理」的初步选择，不是唯一解；下单前看库存和发货地。链接是 2026-11-17 的 item 页，失效就用下面的搜索词找同款。

**链接失效时搜这些词**：

`ESP32-S3 N16R8 44Pin Type-C`、`灵影 TTL Adapter A`、`灵影 5264 8P Hub`、`12V 5A 电源适配器 3C`、`DC5521 免焊转端子`、`LM2596 降压模块 带接线端子`、`12V COB 灯板 10W 带线`、`MOS 管驱动模块 逻辑电平`、`GY-302 BH1750`、`KY-040 旋转编码器`、`5264-3P 总线舵机线`、`乳白亚克力圆片 100mm`、`LED 灯反光纸 PET 自粘`、`2mm 铝板 100x100`、`5A 保险丝座 5x20`、`WAGO 221 接线端子`、`飞特 URT-2 调试板`、`飞特 STS3215-C018`。

---

## 6. 到货检查

| 检查项 | 方法 | 通过标准 |
|---|---|---|
| 12V 适配器 | 万用表 | 12.0–12.5V |
| buck 输出 | 先空载调 | 4.9–5.1V |
| ESP32 | USB 接电脑 | 能识别串口，能烧 blink |
| TTL Adapter | 接舵机，串口发指令 | 舵机 ID 能读到 |
| 舵机 | 逐个测试 | 三个方向都对，无异响 |
| COB | 12V 直接点 | 亮，不闪，30 分钟铝板 <70°C |
| BH1750 | 串口读 lux | 遮住/照亮数值变化 |
| 编码器 | 串口打点 | 正反转计数正确 |
| 反光膜/扩散片 | 装好后拍照 | 灯罩内看不到橙色反光 |

---

## 7. 成本汇总

| 项目 | 金额 |
|---|---|
| 单工位新增 | ¥150–230 |
| 班级共用（6 工位摊销） | ¥40/工位 |
| **每工位合计** | **约 ¥200–270** |
| 已有 3×ST3215 | ¥240–315（不计入新增） |
| 已有机械结构 | — |

> 价格采集于 2026-11-17 淘宝页面，随活动变化；下单前确认「带线」「3C」「N16R8」这三个关键词。
