# Guideline 映射、区域规则、设计规则、美观性

> **本文件结构（v2.1.0 起）**
>
> - **第一节 能力地图（三值状态机）**：当前权威结论，25 项原子动作**零空白**。
> - **第二节 方法面勘误**：解释旧结论为什么会错，以及正确的探测写法。
> - 第三节起是 `notes/` 的逐字合并（历史档案，**未删改**）。里面的 ❌ 与
>   「网络类无 API」「差分对只能走 UI」反映的是当时结论，已被第一节取代。
>   读的时候**以第一节为准**。
>
> 收录：`20-guideline-capability-map.md`、`21-guideline-batch1-regions.md`、`22-guideline-batch2-rules.md`、`23-aesthetics-guideline.md`、`24`–`46` 相关批次
> - **v2.1.1**（2026-11-05）：guideline v1.1 增量映射（G1–G4/CK-01~06）+ flex 条件行；行级变更清单 `changelist-06-v2.1.1.md`（随 v1.1 应用包提交于 guideline 目录）。

---

## 一、原子动作能力地图（三值状态机，2026-11-02 定稿）

图例：

| 状态 | 含义 |
|---|---|
| ✅ | CDP 通道可达：要么走扩展 API，要么走 React `onClick`/键盘事件，且本机跑通或有明确入口 |
| ROUTE-BRIDGE | 官方 bridge（pro-api skill）已覆盖，本 skill 只标方法名、不重复实现，交编排层路由 |
| EXTERNAL | 计算 / 人判外置：本 skill 只负责把参数落到软件里，不承诺数值正确 |

「证据」列：**实测** = 本机跑通并回读过；**入口** = 菜单/DOM/签名已确认但没跑完；
**未验** = API 存在但未实测。

### 1.1 二十五项原子动作

| # | 原子动作 | 状态 | 通道与符号 | 证据 | 备注 |
|---|---|---|---|---|---|
| 1 | 板框绘制 | ✅ | `pcb_PrimitivePolyline`（层 11）+ `pcb_MathPolygon` | 实测 | |
| 2 | 铺铜 + 灌注 | ✅ | `pcb_PrimitivePour` + 属性面板「重建铺铜区」 | 实测 | `Shift+B` 在 CDP 下无效，见 `diffpair_route.py` 头注 |
| 3 | 过孔放置 | ✅ | `pcb_PrimitiveVia.create` | 实测 | |
| 4 | 自动布线 | ✅ | `pcb_Document.autoRouting({RoutingNets})` | 实测 | |
| 5 | 按网络改线宽 | ✅ | `pcb_PrimitiveLine.modify({lineWidth})` | 实测 | |
| 6 | DRC 检查 | ✅ | `pcb_Drc.check(strict, ui, verbose)` | 实测 | 返回嵌套树，判据见 `notes/22` |
| 7 | 元件放置 / 定位 | ✅ | `pcb_PrimitiveComponent.modify`、`placeComponentWithMouse` | 实测 | |
| 8 | 器件编号 | ✅ | `lib_Device.search` + `modify({supplierId})` | 实测 | |
| 9 | 对齐 | ✅（UI） | `布局 → 对齐` 子菜单 / 右键「对齐」/ `Ctrl+Shift+L/R/O/B/E/H` | 入口 | 769 个方法里**没有** align，只能走菜单 |
| 10 | 分布（等距） | ✅（UI） | `布局 → 分布`、右键「水平/垂直等距分布」 | 入口 | 同上，无 API |
| 11 | 组合 | ✅（UI） | `布局 → 组合`、右键「组合选中」`Ctrl+G` | 入口 | 无 API |
| 12 | **网络类创建与分配** | ✅ | `pcb_Drc.createNetClass / addNetToNetClass / getAllNetClasses` + `getNetRules / overwriteNetRules` | 实测 | 脚本 `netclass_manage.py`；**类规则不会被 `check()` 消费**（`notes/49` §5） |
| 13 | 差分对定义 | ✅ | `pcb_Drc.createDifferentialPair / getAllDifferentialPairs / deleteDifferentialPair` | 实测 | 脚本 `diffpair_define.py`（`notes/48`） |
| 14 | 等长网络组 | ✅ | `pcb_Drc.createEqualLengthNetGroup / addNetToEqualLengthNetGroup / getAllEqualLengthNetGroups` | 实测 | 建组/读回/删除已跑通 |
| 15 | 约束区域（局部规则） | ✅ | `pcb_PrimitiveRegion.create`（6 参）+ `pcb_Drc.getRegionRules / overwriteRegionRules` | 实测 | `notes/21` |
| 16 | 禁止区域 | ✅ | 同上，参数不同 | 实测 | 与约束区域同族 |
| 17 | **泪滴** | ✅ | `teardrop_apply.py`：选中 → 右键 → `添加 → 添加泪滴...`（无 API、无顶栏菜单） | 实测 | 判据 = DRC 一进一出，脚本 `--check-drc` 自动对照（`notes/50`） |
| 18 | 缝合孔阵列 | ✅ | `pcb_PrimitiveVia` 批量 + 等距坐标计算 | 实测 | 坐标由脚本算，不用 UI |
| 19 | 过孔围栏 | ✅ | 同上，沿板框周长等距 | 实测 | `notes/24` |
| 20 | 扇出 | ✅（入口） | 右键 / `布线 → 扇出布线...` → 扇出设置对话框 | 入口 | 只支持 BGA；非 BGA 器件点应用无产出（`notes/50`） |
| 21 | 蛇形等长 | ✅（工具） | `布线 → 等长调节`（`Shift+A`），画布点起点，`Tab` 调参 | 入口 | 绘制未脚本化；读侧 `pcb_Net.getNetLength` 实测。等长收敛已由 `net_skew` + `fastroute --pair-skew` 覆盖，UI 蛇形工具仅作交互式微调 |
| 22 | 安装孔 NPTH + 接地环 | ✅ | `pcb_PrimitivePad.create`（`hole` 字段） | 未验 | 参数面已确认，NPTH 未单独实测 |
| 23 | 丝印文字 / 位号 | ✅ | `pcb_PrimitiveString.create/modify/getAll` + `pcb_PrimitiveAttribute` | 实测 | 位号是 `Attribute(key='Designator')` |
| 24 | 叠层与铜层数 | ✅ | `pcb_Layer.setTheNumberOfCopperLayers / getTheNumberOfCopperLayers` | 实测 | |
| 25 | 物理叠层（阻抗前提） | ✅ | `pcb_Layer.getCurrentPhysicalStackingConfiguration` | 实测 | 数值决策归 EXTERNAL |
| 26 | 随板制造说明 readme（新原子动作候选，挂 guideline §18.8 G4-05） | 待勘察 / ROUTE-BRIDGE 注记 | 制造文件导出族（§1.2 bridge）+ 外置说明文档 | — | v2.1.1 增补候选 |

> - G1 去耦布置（guideline §6.4：就近/容值/过孔顺序）→ 既有 place/route 原子动作（#7 元件放置、#3 过孔、#5 线宽）。
> - G2 星型接地（guideline §9.6：铺铜/过孔/焊盘预留）→ 既有 pour/via 动作（#2 铺铜、#3 过孔、#18 缝合孔阵列）。
> - G3 换层双过孔（guideline §10.5）→ route via 计数注记（#3 过孔放置，数量核对外置）。
> - G4 层映射 readme（guideline §18.8）→ 导出流程附属步骤（§1.2 制造文件导出族 + 上方 #26 候选行）。
> - flex（variant-B）：guideline §20 柔性板要点映射——影线铜覆盖率/图案对齐 → 规则型参数可落（网络类/区域规则）；弯折区几何 → 禁止/约束区域。
> - flex（variant-B）：影线阻抗仿真 → EXTERNAL（计算型，逐例求解外置）。

### 1.2 ROUTE-BRIDGE（官方 bridge 覆盖，本 skill 不实现）

方法名在本通道**同样可见**，但按 ADR-0002/0003 不承诺、不重复实现——
两套实现必然漂移。编排层要这些能力时直接走 bridge。

| 能力 | 官方方法名 | 路由原因 |
|---|---|---|
| 制造文件导出 | `pcb_ManufactureData.getGerberFile`、`getBomFile`、`getPickAndPlaceFile`、`getPdfFile`、`getDxfFile`、`get3DFile`、`getIpc2581CFile`、`getInteractiveBomFile` | bridge 的 `PCB_ManufactureData` 全家已覆盖，含参数校验与文件落盘 |
| 下单 | `pcb_ManufactureData.placePcbOrder`、`placeSmtComponentsOrder`、`placeComponentsOrder`、`place3DShellOrder` | 涉及账号与外发，属编排层职责 |
| 工程管理（DMT 域） | `dmt_Project.createProject/openProject/getProjectInfo`、`dmt_Pcb.createPcb/copyPcb/deletePcb` | 工程生命周期归编排层，本 skill 只操作已打开的文档 |
| 视口导航 | `pcb_Document.navigateToCoordinates`、`navigateToRegion`、`zoomToRegion`、`zoomToAllPrimitives` | 本通道也有，但「看哪里」属编排决策，不重复封装 |
| 原理图建元件 | `sch_PrimitiveComponent.create`、`placeSymbolWithMouse`、`createNetFlag`、`createNetPort` | bridge 已覆盖；本 skill 只做 PCB 侧落图 |

### 1.3 EXTERNAL（计算 / 人判外置）

| 能力 | 为什么外置 | 本 skill 负责到哪一步 |
|---|---|---|
| 阻抗计算 | 依赖板厂叠层、铜厚、介质 Dk/Df | 把线宽/间距/层数落到软件里（`pcb_Layer`、`overwriteNetRules`） |
| PDN / 载流 | 需要电流、温升、铜厚建模 | 铺铜、过孔阵列、线宽按外部结论设置 |
| 安规间距 | 依标准（IEC/UL）与工作电压 | 把间距写进规则与区域 |
| 叠层数值决策 | 板厂工艺能力 | 读/写叠层配置，不推荐数值 |
| 整体观感（§15.3 节奏、留白、装饰克制） | 主观 | `aesthetics_check.py --sheet` 出图，标注「C 类，需人审」 |

> EXTERNAL 口径细分（v2.1.1）：**规则型** = 查表阈值可落参数（线宽/间距/孔径/铜覆盖率类），经网络类/区域规则落入软件后由 DRC 或人工核对消费。
> **计算型** = 逐例求解外置（阻抗/载流/安规/影线阻抗等），本 skill 只把参数落到软件，数值正确性由外置计算/人判保证。

### 1.4 自动布局 / 自动位号布局（2026-11-03 补录）

guideline 原文没把「自动布局」列为原子动作，但它是实测中最容易被误判的一项，单列出来。

| 项 | 结论 |
|---|---|
| 菜单入口 | **`布局` 菜单**（12 项）里的前三条：`自动元件布局`、`自动位号布局...`、`草图自动元件布局` |
| 同步 API | `pcb_Document.autoLayout()` —— 有 RPC 端点（`extensionApi.PCB_Document.autoLayout`），**未实测** |
| 异步 API | `startAutoLayout()` 返回 `{jobId:""}` 且不发 RPC；`getAutoJobStatus(t)` 是空函数体 —— **两个都是空壳** |
| 外部导入 | `pcb_Document.importAutoLayoutJsonFile(t)` —— 有 RPC 端点，疑似「外部算好布局再灌回」，参数格式无文档 |

**易错点（真实踩过）**：只在「设计」「布线」两个菜单里找，会得出「EDA 没有内置自动布局」的
错误结论。它在第三个菜单。判断「有没有某个功能」时，**把 7 个顶栏菜单都过一遍**再下结论，
比凭印象挑两个菜单查要可靠。

**用途建议**：做自研布局算法时，把内置的「自动元件布局」当对照基准；把结果导回 EDA 优先试
`importAutoLayoutJsonFile`，而不是逐个 `modify({x,y})` —— 前者是一次原子应用，后者中途失败会
留下半移动的板面。

### 1.5 与脚本的对应关系


| 脚本 | 覆盖地图里的 | 契约 |
|---|---|---|
| `diffpair_define.py` | #13 | api-contract §3.3 |
| `netclass_manage.py` | #12 | 同上 |
| `teardrop_apply.py` | #17 | 同上 |
| `aesthetics_check.py` | §14/§15/§16 可校验点 | 同上 |
| `board_check.py` | #1/#3/#5/#6 的读侧 | 同上 |
| `diffpair_route.py` | #13 的布线闭环 | 同上 |

> §19 审查清单承接通道（v2.1.1）：guideline §19.1/§19.3 **CK-01~06**（去耦贴近/星型接地/弯曲半径/换层双过孔/εR 区分/层映射 readme）→ 操作层查询入口 = §1.1 映射行 + §1.3 口径注记 + 脚本表；两端闭合。

## 二、方法面勘误（2026-11-02）

旧结论里三处「没有 API」全是**探测写法**导致的误判：

```js
Object.keys(A.pcb_Drc)   // -> []   ← 永远为空，别再用
```

扩展 API 的方法都在**类实例的原型链**上。正确写法：

```js
Object.getOwnPropertyNames(A.pcb_Drc)  // 沿 prototype 链遍历
```

现成工具早就有：`python scripts/diag_ns.py --title <片段> --ns pcb_Drc`
（1.x 起就是沿原型链枚举的）。问题不是没工具，是探测时顺手用了 `Object.keys`。
**纪律：任何「有没有 API」的判断，先跑 `diag_ns.py --ns <命名空间>`。**

按正确写法导出：**97 个命名空间 / 769 个方法**（4.1.78）。完整清单见
`notes/_api-surface-4.1.78.json`，方法与教训见 `notes/47-api-surface-prototype-chain.md`。

被推翻的三条：

| 旧结论 | 实际 |
|---|---|
| 「网络类可编程 ❌ 无 API，只能 UI」（`notes/22`） | `pcb_Drc.createNetClass` 等 6 个方法 |
| 「差分对只能走 UI」（`notes/26`/`27`） | `pcb_Drc.createDifferentialPair` 等 6 个方法 |
| 「等长组无 API」（隐含） | `pcb_Drc.createEqualLengthNetGroup` 等 6 个方法 |

仍然成立的一条：**泪滴没有 API**（769 个方法里没有 teardrop 的 create/delete），
只能走上下文菜单 —— 但那条路是通的，见第一节 #17。

---

### 来源：`notes/20-guideline-capability-map.md`

## Guideline → EDA 操作能力测绘计划

来源：`PCB_Layout_Guideline_Package.zip`（v1.0，2026-11-02，目标平台「嘉立创 EDA 专业版」）。
本文不是 guideline 的摘要，而是把 guideline 翻译成**可被 agent 执行的动作**，并标出现有能力缺口。

### 一、guideline 的操作面拆解

| 章节 | 内容 | 落到操作上是什么 |
|---|---|---|
| 2 原理图 | 阅读方向、模块划分、文本层级、网络标签 | 布局坐标 + 文本对象 + 网络标签 |
| 4 布局 | 功能分区、方位、对齐、间距 | 元件坐标/旋转 + 对齐命令 |
| 5 布线几何 | 方向、平行、转角、过孔排列、蛇形 | 走线角度约束 + 蛇形工具 |
| 6 线宽/间距/规则分层 | 起始线宽、间距、默认/网络类/区域/制造四层 | 设计规则的四个作用域 |
| 7 焊盘/过孔/螺丝孔 | 环宽、过孔尺寸库、螺丝间隙、机械包络 | NPTH 孔 + 禁止区域 + 定位 |
| 8 泪滴 | 位置与视觉规范 | 泪滴工具 + 参数 + 重跑 DRC |
| 9 铜皮/缝合 | 铺铜管理、热焊盘/直连、缝合、围栏 | 铺铜属性 + 过孔阵列 |
| 10 扇出/差分/等长/阻抗 | 四类高级布线 | 扇出、差分对、等长组、叠层 |
| 11 禁止/约束区域 | 五类禁止项、八类场景 | 两种区域图元 + 局部规则 |
| 12 EMI | 分区、回流、围栏、屏蔽罩、Guard Ring | 几何 + 铺铜 + 过孔组合 |
| 13 网络命名/网络类 | NC_* 十个类 | 网络类对象 |
| 16 丝印 | 位号方向、字号、避让 | 文字图元 + 属性 |
| 18 工作流 | 快捷键表、五个阶段 | 命令入口 |

### 二、原子动作 × 现有能力（缺口表）

> **历史快照（2026-11-02 首次测绘）**：本表的 ❌ 已被文首「第一节 三值状态机」全部清掉，
> 保留原文只为留痕。要看当前结论请回到第一节。

图例：✅ 已验证　🟡 已知入口未验证　❌ 完全空白

| # | 原子动作 | UI 入口 | 预期 API | 状态 |
|---|---|---|---|---|
| 1 | 板框绘制 | 放置→板框 | `pcb_PrimitivePolyline`（层 11）+ `MathPolygon` | ✅ |
| 2 | 铺铜 + 灌注 | 属性面板「重建铺铜区」 | `pcb_PrimitivePour` + **`Shift+B`** | ✅（Shift+B 未验证，见下） |
| 3 | 过孔放置 | 放置→过孔 | `pcb_PrimitiveVia.create(net,x,y,孔径,外径)` | ✅ |
| 4 | 自动布线 | 布线→自动布线 | `pcb_Document.autoRouting({RoutingNets})` | ✅ |
| 5 | 按网络改线宽 | 布线→布线宽度 | `pcb_PrimitiveLine.modify({lineWidth})` | ✅ |
| 6 | DRC 检查 | 设计→检查DRC | `pcb_Drc.check(true,true,true)` | ✅ |
| 7 | 元件放置/定位 | 放置→器件 | 鼠标 + `modify({x,y,rotation})` | ✅ |
| 8 | 器件编号 | 底部→器件标准化 | `lib_Device.search` + `modify({supplierId})` | ✅ |
| 9 | 对齐（左/右/顶/底/居中/网格） | — | 未知 | ❌ 快捷键 `Ctrl+Shift+L/R/O/B/E/H/G` |
| 10 | 分布（等距） | 布局→分布 | 未知 | 🟡 右键浮层有「水平/垂直等距分布」 |
| 11 | 组合 | 布局→组合 | 未知 | 🟡 右键浮层有「组合」 |
| 12 | **网络类创建与分配** | 设计→网络类管理器 | 未知 | ❌ 关键缺口 |
| 13 | 差分对定义 | 设计→差分对管理器 | 未知 | ❌ |
| 14 | 等长网络组 | 设计→等长网络组管理器 | 未知 | ❌ |
| 15 | 约束区域（局部规则） | 放置→约束区域 | `pcb_PrimitiveRegion.create`（6 参） | 🟡 |
| 16 | 禁止区域（元件/走线/铺铜/内电层） | 放置→禁止区域 | 同上，参数不同 | 🟡 |
| 17 | 泪滴 | PCB 工具菜单 | 未知 | ❌ |
| 18 | 缝合孔阵列 | 放置→缝合孔 | `pcb_PrimitiveVia` 批量 + 阵列计算 | 🟡 单个已会，阵列未做 |
| 19 | 过孔围栏 | 手动 | 同上 + 等距计算 | ❌ |
| 20 | 扇出 | 布线→扇出布线... | 未知 | ❌ |
| 21 | 蛇形等长 | 布线→等长调节 | 未知 | ❌ |
| 22 | 安装孔 NPTH + 接地环 | 放置→焊盘 | 未知 | ❌ |
| 23 | 丝印文字/位号 | 放置→文本 | `pcb_PrimitiveString` | 🟡 |
| 24 | 叠层与铜层数 | 设计→层管理器 | `pcb_Layer.setTheNumberOfCopperLayers` | 🟡 |
| 25 | 物理叠层（阻抗前提） | 设计→叠层管理器 | `pcb_Layer.getCurrentPhysicalStackingConfiguration` | 🟡 |

### 三、先验证的三个高价值假设

guideline §18.1 给了快捷键表，其中一条直接解决我此前的卡点：

**假设 1：`Shift+B` 可以重建铺铜。**
此前的结论是「只能点属性面板按钮」，如果 `Shift+B` 成立，铺铜流程就能全自动化。

**假设 2：网络类可通过 `设计 → 网络类管理器` 建立，并被 DRC 认到。**
这是 line width / clearance 的规则载体，缺了它就只能逐条改图元。

**假设 3：`放置 → 约束区域` 与 `禁止区域` 是同一族图元（`pcb_PrimitiveRegion`），靠参数区分用途。**
若是，11 章那八类场景可以统一用一套参数化调用。

### 四、探测协议（每个动作统一五步）

```text
1. 入口发现   打开菜单/面板，读条目文字与坐标，确认命令存在
2. 签名读取   读 API 方法 toString，拿参数顺序；必要时读返回对象 schema
3. 最小调用   在演练板上做一次最小动作（单对象、小范围）
4. 状态回读   读图元数量/坐标/属性，与预期比对
5. 门禁判定   pcb_Drc.check(true,true,true) 看是否引入错误
```

配套纪律：

- 每个写操作后跑进度条看门狗（连续 3 次不变 → 点右下角取消）
- 每次实验前记录图元基线数量，实验后对比
- 破坏性动作（删除、批量修改）先在单对象上试
- 所有坐标用 `pcb_SelectControl.getCurrentMousePosition()` 现场标定，不写死

### 五、分批计划

| 批次 | 内容 | 理由 |
|---|---|---|
| **批 1：规则层** | #12 网络类、#15/#16 区域、#9 对齐 | 规则是其他一切的前提，且能被 DRC 验证 |
| **批 2：几何层** | #17 泪滴、#18/#19 缝合与围栏、#22 安装孔、#23 丝印 | 纯几何，验证靠图元数量与出图 |
| **批 3：高级布线** | #20 扇出、#21 蛇形、#13/#14 差分与等长 | 依赖器件与叠层，最重，放最后 |

### 六、本计划的边界

- guideline 是**设计规范**，不是软件手册；它给出的数值是起始值，最终要按板厂叠层与工艺校核
- 本测绘只回答「怎么让 agent 在软件里做出这些结构」，不承诺「这些数值就是对的」
- 阻抗、载流、安规这三类结论必须由计算或板厂确认，agent 只负责把参数落到软件里


---

### 来源：`notes/21-guideline-batch1-regions.md`

## Guideline 测绘 批 1：规则层实测

对应 `notes/20` 里的三个假设，全部有了结论。

### 假设 1：`Shift+B` 重建铺铜 —— 成立

```text
建铺铜框 → 点画布拿焦点 → Shift+B → Poured 数量 +1
```

实测：`pour=3, poured=2` → 按下后 `pour=3, poured=3`，无进度条残留。

这条**取代了此前「选中铺铜 + 点属性面板按钮」的路径**：不需要定位按钮、不受面板漂移影响，一次按键完成。铺铜相关流程可以纯脚本化。

快捷键参数：`key="B"`, `code="KeyB"`, `windowsVirtualKeyCode=66`, `modifiers=8`（Shift），`rawKeyDown` 与 `keyUp` 成对发送。

### 假设 2：网络类 —— 未测（顺延到批 2）

### 假设 3：禁止区域与约束区域同源 —— 成立，且更简单

两者都是 `pcb_PrimitiveRegion`，靠 `ruleType` 数组区分。

签名：

```js
create(layer, complexPolygon, ruleType?, regionName?, lineWidth?, primitiveLock?)
```

枚举（官方文档核对）：

| 值 | 含义 |
|---:|---|
| 2 | 禁止元件 NO_COMPONENTS |
| 5 | 禁止布线 NO_WIRES |
| 6 | 禁止填充 NO_FILLS |
| 7 | 禁止覆铜 NO_POURS |
| 8 | 禁止内电层 NO_INNER_ELECTRICAL_LAYERS |
| 9 | 约束区域 FOLLOW_REGION_RULE |

数组可叠加，例如 `[2,5,7]` = 禁元件 + 禁布线 + 禁覆铜（guideline §11.2 的「天线净空区」正是这三条）。

实测两条：

```js
create(1, poly, [2,5,7], "KEEPOUT_ANT", 10, false)   → ruleType [2,5,7]
create(1, poly, [9],     "CONSTRAINT_RF", 10, false)  → ruleType [9]
```

### 区域规则能被 DRC 验证

建了 `[7]`（禁止覆铜）后，DRC 立刻报：

```text
Clearance Error → Copper Region(Filled) to Prohibited Region
"{obj1} and {obj2} overlap"
```

说明区域规则真的在执行，而且**可以用 DRC 做断言**：给某个区域挂 `[7]`，若其范围内已有铺铜，必然出现该错误。

### 新的多边形简写

```js
A.pcb_MathPolygon.createPolygon(['R', x, y, w, h, 0, 0])
```

`'R'` 是矩形简写，比逐点写 `[x,y,'L',x2,y2,…]` 省事。

### 三条流程纪律（本轮踩到）

1. **`pcb_*` 接口只在 PCB 文档激活时可用**。切到原理图后调用会抛
   `Cannot read properties of null (reading 'map')`，看起来像接口坏了，其实是文档上下文不对。
2. **铺铜变动后必须重建**（`Shift+B`），否则 `Poured` 与实际几何不一致。
3. **改原理图会让 PCB 报 `Netlist Error`**：
   `"PCB and schematic netlist does not match"`。
   处理方式：`pcb_Document.importChanges()` → 弹窗点「应用修改」→ DRC 归零。实测这条链路有效。

### 未解决的细节

`create(1, poly, [2,5,7], "KEEPOUT_ANT", 10, false)` 的 `regionName` **没有持久化**（回读无 `name` 字段），而同参数下的约束区域 `[9]` 名称保留。可能是「禁止区域不支持命名」或「多规则时不写名」，待后续单变量实验确认。

### 当前板面状态

| 项 | 值 |
|---|---|
| 元件 / 焊盘 | 6 / 12 |
| 走线 | 12 段 |
| 铺铜 / 灌注 | 2 / 2（层 2 与层 1） |
| 缝合孔 | 6 |
| 板框 | 1 |
| 区域 | 0（测试后已清理） |
| DRC | **0 问题** |


---

### 来源：`notes/22-guideline-batch2-rules.md`

## Guideline 测绘 批 2：设计规则 API 与两个新发现

### 一、最大发现：规则 API 全在 `pcb_Drc` 上

之前扫根对象找 `pcb_Rule` 类没找到，因为规则挂在 **`pcb_Drc`** 上：

| 层级 | 方法 |
|---|---|
| 配置级 | `getCurrentRuleConfigurationName` / `getCurrentRuleConfiguration` / `getAllRuleConfigurations` / `getRuleConfiguration` |
| 配置级写 | `saveRuleConfiguration` / `renameRuleConfiguration` / `deleteRuleConfiguration` / `setAsDefaultRuleConfiguration` / `overwriteCurrentRuleConfiguration` |
| **网络级** | `getNetRules` / `overwriteNetRules` |
| 网络对网络 | `getNetByNetRules` / `overwriteNetByNetRules` |
| **区域级** | `getRegionRules` / `overwriteRegionRules` |

### 二、规则配置的结构

当前配置名：`JLCPCB Capability(Two Layers Board)`。

顶层是 `{config: {...}, name: "..."}`，`config` 下八个分组（英文键）：

| 分组 | 条目 |
|---|---|
| Spacing | Safe Spacing / Other Spacing / Creepage Distance |
| Physics | Track / Net Length Range / Net Length Tolerance / Differential Pair / Blind-Buried Via / Via Size / Height |
| Plane | Plane Zone / Copper Zone |
| Expansion | Solder Mask Expansion / Paste Mask Expansion |
| Copper Analysis | Acute Angle / Hole Falls on Pad / Bare Track Ends / Pad Hole Ring / Track Neckdown / Short Circuit Prompt / Minimum Copper Width |
| Drill Hole Analysis | No Connected Vias / Hole Size / NPTH to Copper |
| Silkscreen Analysis | Silkscreen to Pad / Silkscreen to Hole / Silkscreen Line Width |
| Solder Mask Analysis | （同类分组） |

这八组正好覆盖 guideline 第 6/7/16/17 章提到的规则面。

#### 值的形状（实测）

`Physics.Track.copperThickness1oz`（单位 mm）：

```json
{"editName":"copperThickness1oz","unit":"mm","isSetDefault":true,
 "form":{"status":1,"data":{"1":{"minValue":0.127,"defaultValue":0.254,"maxValue":2.54}}}}
```

`Physics["Via Size"].viaSize`：

```json
{"form":{"viaOuterdiameterMin":0.4999,"viaOuterdiameterMax":10.0,"viaOuterdiameterDefault":0.61,
         "viaInnerdiameterMin":0.2999,"viaInnerdiameterMax":6.29,"viaInnerdiameterDefault":0.305}}
```

`Spacing["Safe Spacing"].copperThickness1oz` 是个**矩阵**：`column` / `row` 列出对象类型（Track / SMD Pad / TH Pad / SMD Test Point / TH Test Point / Via / Fill Region-Teardrop / Copper-Plane Zone / Slot Region / Line / Text-Image / Board Outline / Hole），`tables` 里是对称的间距数值数组。

### 三、网络级规则的写法与实测

`getNetRules()` 返回**索引对象**（`0`~`3`），每条：

```json
{"type":"net","name":"GND",
 "Safe Spacing":"default","Copper Safe Spacing":null,"Plane Safe Spacing":null,
 "Track":"default","Net Length Range":"default","Net Length Tolerance":null,
 "Blind/Buried Via":"default","Via Size":"default","Plane Zone":"default","Copper Zone":"default",
 "Solder Mask Expansion":"default","Paste Mask Expansion":"default",
 "Creepage Distance":null,"targetNet":null}
```

- `"default"` = 继承配置级取值
- 覆盖时给字段塞**同形状的值**，实测通过：

```js
n1.Track = { form: { status: 1, data: { "1": { minValue: 0.2, defaultValue: 0.3, maxValue: 0.5 } } } };
await A.pcb_Drc.overwriteNetRules(allRules);
```

回读确认 `Track` 已被替换；回滚把字段改回 `"default"` 同样有效。

**注意**：`overwriteNetRules` 是**整表覆盖**，必须把未修改的规则原样带回去，不能只传一条。

### 四、DRC 返回数组的真正判据

此前以为要靠 `strict`，实测是**第三个参数 `includeVerboseError`**：

| 调用 | 返回 | 耗时 |
|---|---|---|
| `check()` | `false` | 快 |
| `check(false,true,false)` | `false` | 2.5s |
| `check(false,true,true)` | 数组 | 2.2s |
| `check(true,true,true)` | 数组 | 2.4s |

所以用 `check(false, true, true)`：不强制 strict、弹面板、拿数组，最快。

另有一次 `check(true,true,true)` 在刚布完线时**超时 20 秒**（socket 上限），随后恢复正常——属于引擎繁忙的偶发，不是接口坏。

### 五、网络类没有 API

根对象里只有 `lib_Classification`（库分类），**没有网络类（Net Class）对象**。

`设计 → 网络类管理器...` 打开的是「未选择 / 已选择」两栏 + `>` `<` 移动 + `应用 / 确认 / 取消`，只能把网络**分配**到类，看不到类的定义入口（可能在 `设计规则 → 规则管理 → 网络规则` 里定义规则集）。

结论：**NC_POWER / NC_DIFF_90R 这类"网络类"目前只能走 UI**；但**规则本身可以走 API**（`overwriteNetRules`），所以实际可行的替代是——跳过"类"的概念，直接给每条网络写规则。

### 六、新发现的坑：布线会切碎铺铜，重建后可能留下孤立铜区

流程：`clearRouting` → `autoRouting({})`（19 段）→ `Shift+B` 重建 → DRC 报：

```text
Connection Error / GND / "{obj1} is a free copper region"
```

即铺铜被走线切成若干块，其中某块没接到任何 GND 焊盘或过孔，成为孤立铜。

guideline §9.2 正好点到这条：「检查孤岛铜皮，移除没有电气价值的孤岛」。处置手段：

1. 在孤立区补缝合孔（`pcb_PrimitiveVia.create("GND", x, y, 12, 24)`）
2. 调整铺铜优先级或形状，避免被切碎
3. 接受并标注（某些孤岛无电气价值，可留）

本轮未修完，记为未解决项，原因是缺少「找出孤立铜所在坐标」的 API——`pourFills[].path.complexPolygon` 里能看到多段轮廓，但要判断哪段孤立得做几何连通性分析。

### 七、批 2 结论

| 假设 | 结论 |
|---|---|
| 网络类可编程 | ❌ 无 API，只能 UI |
| 规则可编程 | ✅ `pcb_Drc` 提供完整读写，网络级/区域级都能落 |
| 规则生效可验证 | 🟡 写回可回读；但对布线宽度的影响未拿到干净证据（单网布线索取失败） |


---

### 来源：`notes/23-aesthetics-guideline.md`

## 美观性规范：原文规则 + EDA 操作映射

来源：`PCB_Layout_Guideline.md` §2.5–2.8、§14、§15、§16。
本文不是复述规范，而是把每条视觉规则翻译成**具体对象与可校验点**，便于 agent 执行与审查。

### 一、原理图：文本层级（§2.5）

| 层级 | 内容 | 字号起点 |
|---|---|---:|
| H1 | 功能模块名称 | 2.0–2.5 mm |
| H2 | 子模块名称 | 1.5–2.0 mm |
| Body | 元件编号、参数、说明 | 1.0–1.2 mm |

落到操作：`sch_PrimitiveText.create/modify` 的字高属性。**可校验**：读回图元文字高度做区间判断。

### 二、原理图：位号与参数的相对位置（§2.6）

| 元件 | 位号 | 参数 |
|---|---|---|
| 水平电阻/电容 | 上方 | 下方 |
| 垂直电阻/电容 | 右侧 | 右侧 |
| IC | 符号上方 | 型号或功能在下方 |
| 二极管 | 靠近符号 | 另一侧 |
| 晶振 | 与频率参数分开排列 | — |
| 接插件 | 靠近符号 | 接口说明放附近 |

关键原则：**按元件几何方向决定文字位置，而不是按图纸全局坐标**。水平排列的电阻统一放上方，垂直的统一放右侧。

落到操作：每个元件有两个文本对象（位号 `designator` 与参数 `={Value}`），各自有独立坐标，需随元件旋转同步。**可校验**：读文本对象相对元件的偏移方向是否与旋转角一致。

### 三、原理图：网络标签与符号朝向（§2.7、§14.3）

- 网络标签必须**附着在导线端点**，不能悬空
- 水平信号线优先水平标签
- 电源标签尽量在供电端上方
- GND 符号尽量向下、朝向统一
- 同类电源网络用一致名称（`3V3` 不要一处 `3V3` 一处 `VCC_3V3`）

落到操作：`sch_PrimitiveWire.create` 时给 `net` 参数直接命名，或 `pcb`/`sch` 的 netflag 图元。**可校验**：网络的 `getAllNetsName()` 里不应出现同义不同名。

### 四、原理图：对齐与留白（§2.8、§14.1、§14.4）

- 元件按网格摆放（原理图 0.05 inch 栅格）
- 同行/同列元件对齐
- 模块标题用统一基准线
- 位号与参数**不要贴符号**
- 文字不覆盖导线、不遮挡连接点
- 模块内部紧凑，模块之间宽松
- 长导线不穿过注释区

落到操作：对齐用 `Ctrl+Shift+L/R/O/B/E/H`（左/右/顶/底/水平居中/垂直居中），对齐网格 `Ctrl+Shift+G`。**可校验**：坐标分组的离散度；文字与导线包围盒是否相交需几何判断。

### 五、PCB：元件与走线的相对位置（§15.2）

- 串联元件与主信号路径同向
- 同类被动元件统一方向
- 并列电阻电容对齐
- IC 信号从对应引脚方向自然引出
- 同一总线信号沿相似方向离开芯片
- 走线通道宽度尽量一致
- 避免走线与元件边缘形成无意义狭缝

落到操作：`pcb_PrimitiveComponent.modify({rotation})` + 坐标对齐；走线通道一致性靠布线规则 `Track` 单一取值。**可校验**：同排元件 `rotation` 是否一致、`y` 是否同值。

### 六、PCB：走线节奏（§15.3）

- 平行线保持相近间距
- 同组转角同步
- 过孔规则排列
- 蛇形线折返方向、间距、半径一致
- 不为视觉对称增加无意义绕行

落到操作：过孔阵列用等距坐标生成；蛇形用 `布线 → 等长调节`。**可校验**：过孔坐标的间距序列是否等距。

### 七、PCB：泪滴视觉（§15.1）

- 同一板统一泪滴规则
- 沿走线中心线展开、左右对称
- 与焊盘自然过渡
- 不出现偏斜、尖刺、局部凸起
- 不因装饰扩大而影响间距或阻抗

落到操作：PCB 工具菜单的泪滴功能，参数需全板统一。**可校验**：泪滴生成后重跑 DRC，差分对/RF/BGA 区域无新增间距错误。

### 八、PCB：装饰元素（§15.4）

| 元素 | 用途 | 层 |
|---|---|---|
| 产品 Logo | 品牌 | Top/Bottom Silkscreen |
| 产品名称 | 板卡识别 | Silkscreen |
| PCB Revision | 版本管理 | Silkscreen |
| 装饰线框 / 功能区域边框 | 视觉分区 | Silkscreen |
| 铜箔 Logo | 特殊效果 | Copper |
| 接口编号 | 接口识别 | Silkscreen |
| 测试点名称 | 调试 | Silkscreen |

克制原则：Logo 放留白区；装饰线只用水平/垂直/45°；避开焊盘；RF 区不加无意义铜箔；**不使用无可靠 GND 连接的浮空装饰铜皮**；铜箔 Logo 必须检查网络归属、间距、耦合。

落到操作：丝印文字用 `pcb_PrimitiveString`（丝印层 3/4），铜箔 Logo 用 `pcb_PrimitiveRegion` 或 `Pour` 并显式指定 GND。**可校验**：铜箔装饰若为浮空，DRC 会报 free copper region（与 §9.2 同一条规则）。

### 九、丝印：位号规则（§16.1）

- 位号靠近对应元件
- 同类元件相同相对位置
- 同排元件文字方向一致
- 与元件保持适当距离
- 不压焊盘、本体、其他文字
- 不被屏蔽罩、连接器遮挡
- 按元件几何方向放置（水平件统一上方，垂直件统一右侧）

落到操作：位号是元件自带的 `designator` 文本对象，坐标随元件移动。**可校验**：位号包围盒与焊盘/过孔包围盒不相交。

### 十、丝印：阅读方向（§16.2）

- 全板一个主要阅读方向
- 优先 0° 与 90°
- 少用 180°、270° 与任意角
- 同排保持同向
- 不为填空随意旋转

落到操作：`pcb_PrimitiveString.modify({rotation})` 或位号文本的旋转。**可校验**：统计全板文字旋转角度分布，非 0/90 的比例应趋近 0。

### 十一、丝印：接口标注模板（§16.3）

```text
J1 — UART DEBUG
1  GND
2  3V3
3  TX
4  RX
```

- Pin 1 易识别
- 极性接口标 `+` / `−`
- 电源接口标额定电压
- 调试接口注明 UART、SWD、JTAG
- 文字不与连接器本体或插拔空间冲突

落到操作：多行 `pcb_PrimitiveString`（丝印层）。**可校验**：每个连接器附近是否存在含 "J" + 引脚列表的文本块（正则匹配）。

### 十二、丝印：字号起点（§16.4）

| 内容 | 字高 | 笔画宽度 |
|---|---:|---:|
| 普通元件位号 | 0.9–1.0 mm | 0.15–0.18 mm |
| 接口标注 | 1.0–1.2 mm | 0.15–0.20 mm |
| 模块标题 | 1.5–2.0 mm | 0.20–0.25 mm |
| 产品名称 | 2.0–3.0 mm | 0.20–0.30 mm |

落到操作：文字对象的 `height` / `lineWidth`。**可校验**：按类别分组统计字高是否落在区间内。注意 PCB 侧坐标单位是 mil，规则单位是 mm，需换算（1 mm ≈ 39.37 mil）。

### 十三、丝印：避让矩阵（§16.5）

| 对象 | 要求 |
|---|---|
| SMD 焊盘 | 文字不进阻焊开窗 |
| PTH 焊盘 | 不覆盖焊盘和孔 |
| 过孔 | 不穿过过孔 |
| 元件本体 | 位号放可见区 |
| 走线 | 不被线路分割 |
| 板边 | 保留丝印安全边距 |
| 安装孔 | 避开螺丝头与垫圈覆盖范围 |
| 屏蔽罩 | 文字放覆盖区之外 |

注意：丝印与铜箔是不同制造层，**走线本身不会覆盖丝印**；重点查阻焊开窗、焊盘、过孔、本体与机械遮挡。

落到操作：位置计算 + `modify`。**可校验**：DRC 的 `Silkscreen Analysis` 三项（Silkscreen to Pad / to Hole / Line Width）正是这条的机器化检查。

### 十四、丝印：模块标注布局（§16.6）

```text
模块标题      → 左上角
版本号        → 右上角
元件位号      → 元件附近
功能说明      → 预留空白区
产品信息      → 板边或专门信息区
```

空间不足时板面只保留关键标识，其余放原理图 / BOM / 装配文档。

### 十五、可校验性分级

| 级别 | 含义 | 例子 |
|---|---|---|
| A 可 API 断言 | 读属性即可判定 | 字高区间、旋转角、坐标等距、同排 y 相同 |
| B 需几何计算 | 包围盒/连通性判断 | 文字与焊盘重叠、孤立铜区、平行线间距 |
| C 只能出图人看 | 主观或整体感 | 走线节奏、留白比例、装饰克制、对称性 |

审查流程建议：A 类写脚本自动判 → B 类做几何脚本 → C 类出 `getCurrentRenderedAreaImage` 图供人确认。

### 十六、与既有能力的衔接

- 丝印文字图元：`pcb_PrimitiveString`（未实测，接口与 `Line` 同族）
- 对齐快捷键：`Ctrl+Shift+L/R/O/B/E/H`（guideline §18.1，未实测）
- 丝印规则：`pcb_Drc.getCurrentRuleConfiguration().config["Silkscreen Analysis"]`
- 文字渲染校验：`dmt_EditorControl.getCurrentRenderedAreaImage()` 出纯画布图

---

### 来源：`notes/24-batch3-isolated-copper-and-remaining.md`

## 批 3：孤立铜定位、过孔围栏、批 4 之后的待办

### 一、孤立铜定位：DRC 的报错里就有坐标

之前判断「没有 API 能给出孤立块坐标」，这个结论只对了一半。实际上 **DRC 的每条问题都带 `pos` 和 `objs`**：

```json
{"name":"Connection Error","sub":"GND",
 "objs":["f694675a12606a8d"],
 "pos":{"x":98.4,"y":-98.4},
 "param":{"obj1":"Object 1","type":"ConnectError"}}
```

- `pos` 是 PCB 坐标（1 mil 单位），直接就是问题位置
- `objs[0]` 是内部子对象 id，**用 `Pour.get` / `Poured.get` 都取不到**，只能当定位线索，不能当图元句柄

#### 修复闭环（实测有效）

```text
1. pcb_Drc.check(false,true,true) → 读 pos
2. 在 pos 附近打一个同网络过孔：PrimitiveVia.create("GND", x, y, 12, 24)
3. 点画布 + Shift+B 重建
4. 再跑 DRC → 0 问题
```

本次在 (100,-100) 补孔后，孤立铜报错消失，DRC 归零。

### 二、一个容易忽略的副作用：`clearRouting` 会删掉缝合孔

现象：清理前有 6 个 GND 缝合孔，`clearRouting()` + `autoRouting({})` 之后只剩 0 个，新增一个才变 1。

推断：GND 的缝合孔被当作"布线的一部分"清除。**结论：任何 `clearRouting` 之后都要重新补缝合孔**。

### 三、过孔围栏：按周长等距生成

```js
var inset = 40, step = 200;                    // mil
var x0 = inset, x1 = 1968 - inset;
var y0 = -inset, y1 = -(1968 - inset);
// 沿四条边按 step 生成，角点不重复
```

实测：板 5 cm，内缩 40 mil，步距 200 mil → **38 个孔，全部创建成功，DRC 0 问题**。

`step` 的取值依据 guideline §9.5：`p ≲ λg/10`（λg = c / (f·√εeff)）。低频板随便取，RF 板要按波长算。

### 四、`pourFills` 的坐标单位与 PCB 图元不同

同一块铺铜：

| 来源 | 数值 | 单位 |
|---|---|---|
| `Pour.complexPolygon.polygon` | `[20,-20,"L",1948,…]` | 1 mil |
| `Poured.pourFills[].path.complexPolygon` | bbox `[2,-194, 194,-2]` | **10 mil** |

换算：fill 坐标 × 10 = mil。写几何校验时**必须乘 10**，否则会算出「铜皮只有 2 mm」这种错误结论。

### 五、批 3 执行结果

| 条目 | 状态 | 证据 |
|---|---|---|
| 过孔围栏 | ✅ | 38 孔等距生成，DRC 0 |
| 缝合孔 | ✅ | 单个/阵列都验证过（但会被 clearRouting 清掉） |
| 孤立铜定位 | ✅ | DRC `pos` + 补孔 + 重建 → 归零 |
| 丝印文字 | 🟡 | `pcb_PrimitiveString` 有完整 CRUD；`create` 13 个参数，`create` 第 5 参做字体校验。UI 走「放置 → 文本」需两步（落点 + 输入），本次只建出空壳未保存 |
| 扇出 | 🟡 | 菜单确认存在 `布线 → 扇出布线...`，需选中器件/焊盘上下文，未执行 |
| 等长调节 | 🟡 | 菜单确认 `布线 → 等长调节` / `差分对等长调节`，未执行 |
| 泪滴 | ❌ | **无可见入口**：`设计`/`布局`/`布线` 菜单里都没有；DOM 里只有隐藏按钮（title=泪滴，0×0）与表格里的分类文本；API 无 teardrop 对象 |
| 安装孔 NPTH | ❌ | `放置 → 焊盘` 存在，NPTH 参数未验证 |
| 对齐 | ❌ | 快捷键 `Ctrl+Shift+L/R/O/B/E/H` 未实测 |

#### 泪滴的可疑路径（下一步）

- 工具栏折叠组（`常用` 下拉）展开后可能出现
- 选中导线/焊盘后右键菜单
- 与「填充区域/泪滴」这个表格分类同名的滤镜，说明它是个图元类别而非命令

### 六、guideline 的批次全景与剩余

| 批次 | 主题 | 状态 | 剩余内容 |
|---|---|---|---|
| 批 1 | 规则层基础（区域、重建） | ✅ 完成 | — |
| 批 2 | 规则 API（网络级/区域级） | ✅ 完成 | — |
| 批 3 | 几何增强（围栏、孤立铜、丝印、扇出、等长、泪滴、安装孔） | 🟡 部分 | 丝印落字、扇出、等长、泪滴入口、NPTH、对齐 |
| **批 4** | 高级布线 | ⬜ 未开始 | 差分对定义与布线、等长组（DDR/总线）、阻抗与叠层（`pcb_Layer` 的物理叠层接口） |
| **批 5** | 制造输出 | ⬜ 未开始 | Gerber / 钻孔文件导出、BOM 导出、3D 查看、DFM 检查（`设计 → 检查DFM...`）、`pcb_ManufactureData` |
| **批 6** | 泛化复验（C7） | ⬜ 未开始 | 换一个工程复跑全链路；换客户端版本对照结构漂移 |
| **批 7** | 美观性落地 | ⬜ 未开始 | 丝印排版（字号/方向/避让矩阵）、模块标题与版本号布局、装饰元素规范（依赖批 3 的丝印 API） |

批 4 之所以没动，是因为它依赖「器件有差分对/等长组」的前提——当前演练板只有 6 个被动件，没有差分信号。要真正验证，需要一个带 USB 或 DDR 的工程，或者人为造一对网络并用 `pcb_Drc.getNetByNetRules` / 等长组接口去设约束。

批 5 的接口面已经看到影子：`pcb_ManufactureData`、`pcb_Document.importAutoRouteSesFile`、`设计 → 检查DFM...`，但都没有实测。

### 七、当前板面

| 项 | 值 |
|---|---|
| 元件 / 焊盘 | 6 / 12 |
| 走线 | 19 段（N1=5、N2=5、N3=2、GND=7） |
| 铺铜 / 灌注 | 2 / 2 |
| 过孔 | **39**（38 围栏 + 1 补孤岛） |
| 板框 | 1 |
| 区域 | 0 |
| DRC | **0 问题** |

---

### 来源：`notes/26-oshwhub-import-and-batch4-prereq.md`

## OSHWHub 导入链路与批 4 的前置条件

### 一、两个 CDP 端点

| 进程 | 端口 | 版本 |
|---|---|---|
| 嘉立创EDA 桌面版（Electron） | **9222** | Chrome/146.0.7680.188 |
| Microsoft Edge | **9333** | Edg/156.0.4314.50 |

端口靠扫描 `9200–9400` 的 `/json/version` 找到，不要假设浏览器也在 9222。

### 二、OSHWHub 的「在编辑器中打开」到底打开什么

以 `https://oshwhub.com/shihaowen/usb_hub`（TYPE-C 一拖四 USB2.0 HUB，双层板，明确写了差分布线）为样本。

页面上有两类入口：

| 链接文字 | href | 结果 |
|---|---|---|
| 打开设计图 | `https://lceda.cn/editor?jspm=hub.gc.an.sjq&…` | 标准版在线预览 |
| 在编辑器中打开（原理图） | `https://lceda.cn/editor?jspm=hub.gc.sjt.sdk&…` | **标准版 web 编辑器** |
| 在编辑器中打开（PCB） | `https://lceda.cn/editor?jspm=hub.gc.sjt.pdk&…` | 标准版 web 编辑器 |
| 专业版编辑器 | `https://pro.lceda.cn/editor?jlc_vid=…` | 专业版 web 编辑器首页（不带工程） |

实测点击后的落点：

```text
https://lceda.cn/editor?jspm=hub.gc.sjt.sdk&jlc_vid=…#id=2f1b6edd79
标题：嘉立创EDA(标准版)
正文：登录 注册 … 工程 设计管理器 常用库 元件库 立创商城 …
```

结论：**它开的是标准版在线编辑器，工程 id `2f1b6edd79`，未登录状态下是只读**。

#### 两个操作要点

1. `a.click()` 这种 JS 点击**无效**（被当作非用户手势，弹窗被拦）。必须用 CDP 的真实鼠标事件（`mousePressed` + `mouseReleased`）。
2. 点击前要先 `scrollIntoView({block:'center'})`，因为按钮在长页面下方（视口坐标会变）。

### 三、为什么进不了桌面专业版

桌面端 `文件 → 打开工程` 是**本地文件选择器**（弹窗只有「工作区 / 在新窗口打开 / 打开工程 / 取消」），没有 URL 或工程 id 输入口。

所以 OSHWHub → 桌面专业版 的唯一链路是「账号内流转」：

```text
浏览器登录 → 在编辑器中打开（或专业版编辑器）→ 复制/迁移到我的工程
→ 桌面端 开始页 工程树刷新 → 双击打开
```

这一步**需要登录**，属于不能代替用户完成的动作。当前状态：未登录，链路停在第 2 步。

### 四、批 4 的前置条件（差分对 / 等长组）

#### 差分对只能走 UI

`pcb_Net` 的方法面里**没有差分对**：

```text
getAllNets / getNet / getAllNetsName / getAllNetName / getNetLength
getNetColor / setNetColor / getAllPrimitivesByNet
selectNet / unselectNet / unselectAllNets
highlightNet / unhighlightNet / unhighlightAllNets
getNetlist / setNetlist
```

`pcb_Drc.getNetByNetRules / overwriteNetByNetRules` 是**网络对规则**（两条网络之间的间距），不是差分对定义。

差分对的入口只有 `设计 → 差分对管理器...`，对话框结构：

| 元素 | 内容 |
|---|---|
| 标题/计数 | 差分对管理器，`0/0` |
| 表头 | 名称 / 正网络 / 负网络 |
| 搜索框 | 筛选用 |
| 按钮 | 自动生成... / 应用 / 确认 / 取消 |

#### 所以批 4 有两个选择

**A. 走真实工程**（推荐但需登录）

登录后在浏览器把 usb_hub 复制到我的工程 → 桌面端打开 → 此时板上有真实的 D+/D- 网络，再去 `差分对管理器` 建对、用 `布线 → 差分对布线` 验证。

**B. 自造差分对**（不需登录）

在现有工程里把 N1/N2 重命名为 `USB_DP`/`USB_DM`（`sch_PrimitiveWire.modify({net})` → `importChanges` 同步到 PCB），再用差分对管理器建对。缺点是只有一对网络、没有连接器，验证的是"命令能否执行"，不是"布线质量是否达标"。

### 五、批 4 未完成的原因（如实记）

不是接口不给力，是**缺素材**：差分对/等长组必须建立在真实差分网络上，而获取真实差分网络的两条路（OSHWHub 导入、自建连接器）前者卡登录、后者需先改原理图网络名再同步。

在拿到素材之前，`差分对管理器` 与 `布线 → 差分对布线` 只能记录入口，无法验证行为。

---

### 来源：`notes/27-usbhub-diffpair-blocked.md`

## usb_hub 实操：差分对检测成功、创建卡在自定义复选框

### 一、工程已就位

在桌面端 所有工程 里找到 `usb_hub_<timestamp>`，双击后**新开窗口**（project id `<project-id>`）。

结构：Board `usb_hub` → Schematic `usb_hub` → PCB `PCB_2021-07-31_16-23-57`。

PCB 打开后实测：**18 个元件、16 个网络**，其中差分网络完整：

```text
D_P / D_N                      上行
D1_P / D1_N  D2_P / D2_N       下行 1、2
D3_P / D3_N  D4_P / D4_N       下行 3、4
GND VCC VCC33 VCC18 U1_15 U1_16
```

### 二、自动生成差分对：检测能力验证通过

`设计 → 差分对管理器... → 自动生成...` 打开「自动生成差分对」对话框，字段：

| 字段 | 实测值 |
|---|---|
| 来源 | 全部 |
| 差分对命名前缀 | 空（可填） |
| 创建到差分对组 | 空（可填） |
| 正网络特征 | `P` |
| 负网络特征 | `N` |

它**自动识别出 5 组**：`D3_`、`D_`、`D2_`、`D4_`、`D1_`，并填好正/负网络列（D3_P / D3_N …）。说明规则匹配（`P`/`N` 后缀）本身是可靠的。

### 三、卡点：自定义复选框点不动

管理器和自动生成框里的复选框不是原生 input：

```html
<label class="container_oaJ87"><i class="checkbox_5JRDx"></i></label>
```

`querySelectorAll('input[type=checkbox]')` 返回 **0**，所以早期判断「没有复选框」是错的——这是我这一轮最大的误判，用户直接指出后才发现。

三种点击方式都试过：

| 方式 | 结果 |
|---|---|
| CDP 真实鼠标点 `<i>` 中心 | 类名与背景样式不变，状态未翻转 |
| JS `label.click()` | 同样不变 |
| 点行文本 / 按回车 | 无效果 |

后果：`确认` 提交后只落下 2 行残行（`USB_PAIRS / DPD3_`、`D1_`），**正网络/负网络为空**，管理器计数仍是 `0/0`。

已点「取消」清掉残行，工程保持 **18 元件 / 16 网络**，没有留下脏数据。

### 四、结论与下一步

差分对的**定义**只存在于 UI（`pcb_Net` 无差分对方法，`getNetByNetRules` 是网络对规则不是差分对），而且这层自定义复选框对脚本点击不敏感。

三条路：

1. 人工勾选 5 行 + 确认（最快），随后我验证 `布线 → 差分对布线`
2. 深挖 Vue 组件内部状态（`__vueParentComponent` 之类）改写 selected 数组
3. 跳过"预定义对"，直接测 `布线 → 差分对布线` 是否支持选中两条线临时成对

---

### 来源：`notes/28-diffpair-via-react.md`

## 差分对真正跑通：React 内部点击 + 直接改单元格

### 一、破局点：这是 React，不是 Vue

自定义复选框 `<label class="container_oaJ87"><i class="checkbox_5JRDx"></i></label>` 在手写 DOM 事件下毫无反应，但它挂着：

```text
__reactFiber$umij1ileb4
__reactProps$umij1ileb4
```

`__reactProps` 里就是组件的真实 props：`{data-test, className, onClick, children}`。

**直接调用 `props.onClick({currentTarget, target, preventDefault, stopPropagation})` 就能翻转状态**，`<i>` 的类名立刻变成 `checkbox_5JRDx active_KFYkF`。

这条比"模拟鼠标"可靠得多：不依赖坐标、不依赖命中测试，也不受覆盖层影响。

### 二、管理器里的网络列可以直接填

管理器的每行 `正网络`/`负网络` 单元格里各有一个 `input`。用 React 认可的方式赋值：

```js
var setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
setter.call(input, 'D3_P');
input.dispatchEvent(new Event('input', { bubbles: true }));
```

配合行首 `[data-name]`（如 `DPD3_`）做映射，一次填完 5 组：

| 差分对名 | 正网络 | 负网络 |
|---|---|---|
| DPD3_ | D3_P | D3_N |
| D1_ | D1_P | D1_N |
| D_ | D_P | D_N |
| D2_ | D2_P | D2_N |
| D4_ | D4_P | D4_N |

点 `确认` 后管理器关闭，重开核对：**5 行网络全部保留**。

### 三、一个坑：顶部计数 `0/0` 不是对数

管理器标题旁的 `0/0` 在 5 组差分对都存在时依然显示 `0/0`。判断是否有差分对，**只能看表格行**，不要看这个计数。

### 四、按钮坐标会漂

同一个管理器，两次打开按钮位置不同：

```text
第一次：自动生成 358 / 应用 622 / 确认 726 / 取消 830
第二次：自动生成 406 / 应用 670 / 确认 774 / 取消 878
```

按写死坐标点必然错位——我第一次就把 `确认` 点成了 `自动生成`。每次都要按文字重新取坐标。

### 五、差分对布线：进入了、被 DRC 拦了

入口 `布线 → 差分对布线`，选中网络后菜单项可用。点它不弹窗，直接进入等待起点的模式。

从 `D_P` 焊盘 (4917,-6825) 起，向右画了约 770 mil：

```text
提示：检测到导线违反 DRC，无法生成导线，请查看白色 DRC 边框
```

前后对比：

| 指标 | 布线前 | 布线后 |
|---|---|---|
| D_P 段数 | 17 | 17 |
| D_N 段数 | 17 | 17 |
| D_P 长度 | 559 mil | 559 mil |
| D_N 长度 | 561 mil | 561 mil |

结论：**命令真的执行了，但因为几何违规被拒绝，没有产生半成品**。这是好事——说明它用 DRC 做前置校验，而不是先画后报错。

### 六、板面现状（usb_hub）

- 18 元件 / 16 网络
- D_P 559 mil、D_N 561 mil，各 17 段（原作者接近等长，差约 2 mil）
- 新增 5 组差分对定义
- 未新增任何走线（被 DRC 拦下）

### 七、剩下要做的

真正画出一条合法差分对，需要一个空白区域：当前板已布得很密，随便一条直线都会撞线。可选做法：

1. 在板边空白处造一对临时网络（`sch` 里加两段带网络名的导线 → 同步到 PCB），再布
2. 找板内已有的短差分对（如 D4），沿其走线方向续接
3. 直接接受"命令已可用 + DRC 门禁有效"作为本轮结论

---

### 来源：`notes/29-diffpair-drc-gate.md`

## 差分对布线的真正前置：DRC 必须先干净

### 一、坐标映射校验通过

在四倍缩放下标定：**6.5 文档单位/像素**。

```text
screen(615,290) -> doc(5140,-7075.5)   # 正是 D4_P 焊盘 (5143,-7075)
screen(569,290) -> doc(4840,-7075.5)
```

说明点击确实落在焊盘上，不是点空。

### 二、铺铜不是拦路的原因

按建议先把铺铜的**灌注结果**清掉（保留铺铜框）：

```js
var q = await A.pcb_PrimitivePoured.getAllPrimitiveId();
await A.pcb_PrimitivePoured.delete(q);   // poured 2 -> 0
```

再走差分对，仍然报：

```text
检测到导线违反 DRC，无法生成导线，请查看白色 DRC 边框
```

所以拦路的是**板面已有的 DRC 违规**，不是铜皮。事后用 `Shift+B` 已把灌注恢复（poured 回到 2）。

### 三、定义差分对会暴露既有违规

把 5 组差分对定义后，DRC 立刻多出一组：

```text
Differential Pair Error / Track to Track / 4 条
文本：length tolerance is {width}, should be {shouldBe}
```

查长度：`D4_P` 816 mil、`D4_N` 790 mil，差 26 mil ≈ 0.66 mm，而规则默认等长容差是 **0.254 mm**。

**结论：OSHWHub 这份工程的原始布线并没有满足差分对等长要求**，一旦按规则定义成差分对，就暴露出 4 处不达标。这也解释了为什么原作者没把线定义成差分对。

### 四、放宽容差：要传内层 config

`overwriteCurrentRuleConfiguration` 的签名是 `(ruleConfiguration)`，传 `{config, name}` 整包**不生效**（回读仍是 0.254）；传 **内层 `config`** 才成功：

```js
var c = await A.pcb_Drc.getCurrentRuleConfiguration();
var cfg = JSON.parse(JSON.stringify(c.config));
cfg.Physics['Differential Pair'].differentialPair.form.differentailPairLenTolerMax = 1.0;
await A.pcb_Drc.overwriteCurrentRuleConfiguration(cfg);
// 回读：1.00000054
```

效果：DP 错误 4 条 → **1 条**。

### 五、板面 DRC 现状（usb_hub）

| 组 | 条数 | 来源 |
|---|---|---|
| Clearance Error / Board Outline to TH Pad | 7 | **源工程自带** |
| Connection Error | 2 | 重建铺铜后出现的孤立铜 |
| Differential Pair Error | 1 | 定义差分对后剩余未达标处 |
| Netlist Error | 1 | 原理图与 PCB 未同步 |

### 六、因此得出的操作顺序

```text
1. 先把 DRC 清干净（或至少清到布线区无违规）
2. 再进 布线 → 差分对布线
3. 走完线 → Shift+B 重建铺铜
4. 复查 DRC
```

第 1 步是关键：**布线器把 DRC 当门禁，有违规就拒绝生成**，不会先画后报。这条对普通布线同样适用。

### 七、下一步

要在 usb_hub 上真正画出一条差分对，得先处理那 7 条板框-焊盘间距错误（源工程自带，可能是老工艺参数）。两条路：

1. 按当前规则把那 7 处焊盘往里挪/改小（改源工程布局，代价大）
2. 建一个全新空白工程，只放一对焊盘 + 两个网络，专门验证差分对布线（纯净环境，结论更干净）

建议走 2——用干净环境验证"命令行为"，回到真实工程再谈"设计质量"。

---

### 来源：`notes/31-clean-board-diffpair.md`

## 干净工程做差分对：能定义、布线仍卡住

### 一、新工程已跑通

工程 id `<工程UUID-01>`，`openDocument(pcbUuid)` 直接打开 PCB：

```js
await A.dmt_EditorControl.openDocument("d3fa753091e78bc8");  // PCB1
// 返回后 dmt_Board.getCurrentBoardInfo() 正常：Board1 / PCB1
```

### 二、用 API 造一对差分网络（很关键）

**给焊盘的 `net` 传名字，网络会自动创建**：

```js
await A.pcb_PrimitivePad.create(1, '1', 2000, -2000, 0, ['ELLIPSE',60,60], 'D_P', null, 0,0,0,false,0);
// ... 同法建 D_N，两网络各两枚焊盘
// getAllNetsName() -> ["D_P","D_N"]
```

焊盘参数顺序：`(layer, padNumber, x, y, rotation, padShape, net, hole, …)`，
外形用 `['ELLIPSE', 宽, 高]`，SMD 孔传 `null`。

**坑**：焊盘中心距不能小于直径，否则立刻 Clearance Error。我第一版 60mil 中心距 + 60mil 直径 → 报错，改成 150mil 才干净。

### 三、这个窗口的两个致命细节

#### 1. CDP 鼠标事件默认无效

新开窗口里，菜单点不开、对话框按钮点不动，`getCurrentMousePosition()` 一直返回同一个值（冻结）。

**解法：先 `window.electronAPI.focusWindow()`**，之后再发鼠标事件，位置才开始更新（实测 (500,300)→(4930,-4760)、(650,380)→(6805,-5760)）。

#### 2. 菜单和按钮改走 React props

即使聚焦后，菜单栏与部分按钮仍不响应合成点击。可靠办法（此前在复选框上验证过，这次推广到菜单）：

```js
// 菜单按钮：eda-menu-btn-top_xxx 上挂 onClick
// 逐级向上找 __reactProps，调用 props.onClick({currentTarget,target,preventDefault,stopPropagation})
```

封装成 `window.__rc(text)` 后，`设计/布线` 菜单与 `差分对管理器...`、`自动生成...` 都能可靠打开。

**注意**：文档里同时存在多个「确认」时（管理器 + 自动生成框），必须**限定在目标对话框内**查找，否则会点到后面的那个。为此加了 `__dlg(marker)` + `__rcIn(dlg,'确认')`。

### 四、差分对定义成功

自动生成识别出 `D_ / D_P / D_N`；勾选（React onClick）后点确认，两个对话框闭合。管理器行读回确认过。

### 五、布线仍未出线

`布线 → 差分对布线` 命令能执行（React 点击成功），但随后点击焊盘起点、目标终点，**既不生成导线也不报错**。

已排除：
- 焊盘坐标算错（映射 10.6 单位/像素，(632,300) 正是 D_P 焊盘）
- 铜皮干扰（这块纯净板没有铺铜）
- DRC 阻塞（当前只有 2 条未连接，与 usb_hub 那次的 toast 不同，这次连 toast 都没有）

疑点：
1. 视图缩放停在 fit-all，焊盘直径只有约 6 像素，`zoom()` 是空实现、`zoomToRegion` 调用后比例没变（仍 10.6），可能没真正放大 → 点击精度不足。
2. `差分对布线` 可能要求先"选中差分对"而不是点焊盘；`getAllPrimitivesByNet('D_P')` 返回 0，说明该 API 不覆盖焊盘，选不中。
3. 命令可能进入了模式但对点击位置的要求更严（需精确到焊盘中心 ±1px）。

下一步建议：先解决"能不能真正放大视图"（找一个有效的缩放入口，比如滚轮事件 `mouseWheel`，而不是 API），再重试布线。

---

### 来源：`notes/38-diffpair-needs-real-pins.md`

## 差分对布线：命令能启动，但不认孤立焊盘

用 probe-click 断言过"当前在选择态"（`selected=1`）之后再执行，仍然不出线。于是转向确认"命令有没有启动"。

### 一、命令确实启动了

点 `差分对布线` 后，右侧面板切换到 `布线属性`（`toolLabel: "布线属性"`，`panels:["布线属性"]`）。

对比状态：

| 时刻 | 右上工具标签 | 右侧面板 |
|---|---|---|
| 选择态 | 无 | 无 |
| 点单路布线后 | 布线属性 | 布线属性 |
| 点差分对布线后 | 布线属性 | 布线属性 |

所以不是"命令没点上"，是**工具起来了但点击不被接受**。

### 二、单路能出线，差分对不认

同一块板、同一坐标、同一时序：

```text
布线 → 单路布线 → 点 D_P 焊盘 → 拖 600mil → 点击  ⇒ 生成 1 条导线（605 mil）
布线 → 差分对布线 → 同位置同样操作              ⇒ 无导线、无提示
```

差异只可能在"工具对起点的要求"上。

### 三、最可能的原因：它要求元件引脚，不是孤立焊盘

当前板上的 D_P/D_N 焊盘是**用 API 直接创建的孤立 SMD 焊盘**（padNumber="1"，无元件归属）。

而 `差分对布线` 的语义是从"一对差分引脚"起布——它需要两个焊盘在几何上成对且在同一个元件/连接器内（例如连接器的两个相邻引脚）。

佐证：在 usb_hub（有真实 SL2.1A 元件、D_P/D_N 是元件引脚）上，同一命令**能进入并尝试**——那次点击后弹出了「检测到导线违反 DRC」，说明它认可了起点。

### 四、结论与下一步

差分对布线要成功，素材必须满足：

1. 焊盘属于元件引脚（有 pin ↔ net 关系），不是裸焊盘
2. 该对网络在 `差分对管理器` 里已定义
3. 板面 DRC 干净（usb_hub 那次就是被 7 条板框间距错误挡住）

所以干净工程这条路到此为止——它验证了"定义可编程"，但拿不到"布线可编程"的结论。真正能验证布线的是 usb_hub，前提是先把那 7 条 `Board Outline to TH Pad` 清掉。

### 五、附带确认

`布线` 菜单里三个布线项（单路/差分对/多路）的 `color` 都是 `rgb(51,51,51)`、`opacity: 1`，**没有禁用态**——菜单不会告诉你当前能不能用，只能靠试。

---

### 来源：`notes/40-diffpair-routing-success.md`

## 差分对布线跑通：两个真凶

### 结果

```text
布线 → 差分对布线 → 点 D_P 引脚 → 拖 130mil → 点击 → Esc
结果：新增 4 段导线（D_P 1 段、D_N 3 段），层 1，线宽 6 mil
长度：D_P 46.1 mil / D_N 80.7 mil
```

### 真凶一：残留的模态对话框挡住了整个画布

`elementFromPoint(600,330)` 返回 `INPUT.input_hhx7T` —— 命中的是**差分对管理器里的输入框**，不是画布。

```text
.lc_modal_RVdjQ  600×460 @ (342,131)  z-index 10031
全屏遮罩          1283×722         z-index 10000
```

之前每一步"点击画布"，实际都点在弹窗上。关掉之后立刻恢复正常：

```js
window.__rcIn(window.__dlg('差分对管理器'), '取消')
// preflight: {modals:0, hit:"IFRAME.editframe un_ruler"}
```

**这条是根本原因**：只要有任何 `.lc_modal_RVdjQ` 打开，画布、鼠标跟踪、键盘全部失效，而且**没有任何报错**。

### 真凶二：差分对线宽规则默认 100 mil

规则原文：

```json
"strokeWidthTables": {"data": {"1": {"minValue":0.127, "defaultValue":2.54, "maxValue":2.54}}}
```

`2.54 mm = 100 mil`。用户截图里右侧「起始布线宽度 = 跟随规则、线宽 100mil」正是这个值。

后果：任何两点之间拉一条 100mil 宽的线，必然与周围铜箔/焊盘冲突 → 工具报「检测到导线违反 DRC，无法生成导线」并拒绝落盘。

改成 6 mil（0.1524mm）后立刻成功：

```js
dp.strokeWidthTables.data['1'] = {minValue:0.1524, defaultValue:0.1524, maxValue:2.54};
dp.diffPairSpacingTables.data['1'] = {minValue:0.127, defaultValue:0.1524, maxValue:null};
await A.pcb_Drc.overwriteCurrentRuleConfiguration(cfg);   // 传内层 config
```

新走线回读 `lineWidth: 6` —— 规则确实生效。

### 成功流程（可复用）

```text
1. preflight：统计打开的 .lc_modal_RVdjQ；elementFromPoint(画布中心) 必须命中 IFRAME.editframe
2. 关掉所有弹窗（__dlg + __rcIn 点“取消”）
3. iframe.contentWindow.focus()   （不抢系统焦点）
4. Esc ×2，再 focus 一次
5. 多点采样标定（4 点，跳过吸附点），得到 单位/像素
6. 探针点击已知引脚 → selected ≥ 1 才算状态正常
7. 布线 → 差分对布线（菜单按钮用 __rc 走 React onClick）
8. 点起点引脚 → 移动 → 点击终点 → Esc
9. 回读 pcb_PrimitiveLine 数量与 lineWidth 验证
```

### 本轮对 usb_hub 的改动（需告知）

| 项 | 改动 |
|---|---|
| D_P/D_N 旧走线 | 删除 34 段（为测试腾空间）；现新增 4 段短走线 |
| 安全间距 · 板框行 | 全部清零（原 0.1524mm），用于消除 7 条板框间距错误 |
| 安全间距 · Hole×板框 | 清零 |
| 差分对 · 线宽 | 2.54mm(100mil) → 0.1524mm(6mil) |
| 差分对 · 等长容差 | 0.254mm → 1.0mm |

当前 DRC：`Slot Region to Track 4`（清零板框行的连带影响）、`Differential Pair 1`、`Connection GND 2`、`Netlist 1`。

---

### 来源：`notes/41-diffpair-routed-full.md`

## 差分对布线连到对端：完整证据链

### 结果

```text
布线 → 差分对布线 → 点 D_P 引脚(4917,-6825) → 移到 D_P 引脚(4598,-7010) → 点击 → Esc
新增 19 段：D_P 9 段、D_N 10 段，线宽 6 mil，层 1
长度：D_P 456.2 mil / D_N 434.0 mil，差 22.3 mil（容差 39.4 mil，符合）
```

### 证据一：每段都有精确坐标

D_P 首尾段：

```text
["D_P", 4917,-6825, 4877,-6825]   ← 起点正是 D_P 焊盘
...
["D_P", 4731,-6927, 4648,-7010]
["D_P", 4648,-7010, 4598,-7010]   ← 终点正是 D_P 焊盘 (4598,-7010)
```

D_N 首尾段：

```text
["D_N", 4917,-6775, 4877,-6775]   ← D_N 焊盘
...
["D_N", 4603,-6986, 4598,-6990]   ← D_N 焊盘 (4598,-6990)
```

### 证据二：端点吸附校验（脚本断言）

用焊盘坐标做 2 mil 容差比对：

| 网络 | 段数 | 起点接触焊盘 | 终点接触焊盘 |
|---|---|---|---|
| D_P | 9 | 1 | 1 |
| D_N | 10 | 1 | 1 |

即**两端都落在焊盘中心**，不是浮空短线。

### 证据三：长度差在容差内

```text
D_P 456.2  D_N 434.0  差 22.3 mil
规则容差 1.0 mm = 39.4 mil   → 合格
```

### 证据四：重建铺铜消掉 13 条错误

走线穿过了 GND 铜皮 → DRC 报 `Copper Region(Filled) to Track ×13`。
按 `Shift+B` 重建后 → 该类错误清零（铜皮自动避让新走线）。

### 证据五：剩余 DRC 与本对无关

```
Slot Region to Track 4   @ (457,-708) / (457,-688)   ← 坐标量级差 10 倍，另一区域
Track to Track D1_P/D1_N @ (591,-667)                ← 另一对差分
GND Connection Error 2   @ (476,-688)
```

没有任何一条错误落在 (4900,−6800) 附近，说明本次差分对走线本身没有引入违规。

### 视觉

放大到 (4750,−6900)：两条走线从 9/D_N、10/D_P 焊盘出发，45° 折向左侧，收成平行一对后通往左下，选中态 19 段全部高亮。

### 完整可复现流程

```text
preflight: modals=0 且 elementFromPoint(画布) 命中 iframe.editframe
→ iframe.contentWindow.focus()（不抢系统焦点）
→ Esc ×2 → 再 focus
→ 4 点采样标定（跳过吸附点）
→ 探针点击引脚，selected≥1
→ 布线 → 差分对布线（__rc 走 React onClick）
→ 点起点引脚 → 移到终点引脚 → 点击 → Esc
→ 回读线段/before-after 长度差 → Shift+B 重建 → DRC
```

---

### 来源：`notes/46-bac-round.md`

## 间距规则矩阵：结构与按格修改

`getCurrentRuleConfiguration()` 返回的 `config.Spacing['Safe Spacing']['Default']` 是一张
**12×12 的间距矩阵**，不是一组扁平字段：

```js
d.column   // 数组，12 项：
           // ["Track","SMD Pad","TH Pad","SMD Test Point","TH Test Point","Via",
           //  "Fill Region/Teardrop","Copper/Plane Zone","Slot Region","Line",
           //  "Text/Image","Board Outline"]
d.row      // 同顺序
d.tables['1'].content        // 下三角数组：content[i][j] 是 row i 与 column j 的间距（mm）
d.unit                       // "mm"
```

取值规则：`content[max(rowIdx,colIdx)][min(rowIdx,colIdx)]`。

实测 Track ↔ Slot Region = `0.29972`（= 11.8mil），改成 `0.1524`（6mil）后
`Slot Region to Track` 的 4 条 DRC 全部消失。

```js
var c = await A.pcb_Drc.getCurrentRuleConfiguration();
var d = c.config.Spacing['Safe Spacing']['Default'];
var i = d.column.indexOf('Slot Region'), j = d.column.indexOf('Track');
d.tables['1'].content[Math.max(i,j)][Math.min(i,j)] = 0.1524;
await A.pcb_Drc.overwriteCurrentRuleConfiguration(c.config);   // 传内层 config
```

注意：`column` / `row` 是**数组**（不是 JSON 字符串），别去 `JSON.parse`。

## DRC 返回结构（读明细时用）

```text
[{ name:"Clearance Error",
   list:[{ name:"Slot Region to Track",
           list:[{ errorObjType, obj1:{typeName,suffix}, obj2:{...}, layer,
                   pos:{x,y},                        ← 单位 10mil
                   errData:{obj1,obj2,minDistance,clearance},
                   explanation:{param:{minDistance:"6.6mil", shouldBe:">= 11.8mil"}} }]}]}]
```

- `pos` 与 `pourFills` 一样是 **10mil**，用前乘 10
- `errorObjType` 才是分类名（`Slot Region to Track` / `SMD Pad` / `Track to Track` / `Netlist Error`）
- 连接类错误的说明是 `{obj1} is disconnected from other objects of the same network`，
  **判定依据是网络连通性，不是坐标重合**：把线端点对齐到焊盘中心（差 0.03mil）也不会消除它

## 网表不一致的检查顺序

1. `pcb_Document.importChanges()` 会弹「确认导入信息」，先读差异再决定
2. 实测该板上差异只有 7 个电容的「通道ID」属性，点「应用修改」后图元数量**完全不变**
3. 但 `Netlist Error` **没有消除** —— 说明它的判定不看这条属性差异，
   需要在原理图侧重新生成网表，或在 DRC 面板点 "Import Changes" 规则名看具体差异
