# PCB：转换、板框、布线、铺铜、重灌注

> 本文件由 `notes/` 逐字合并生成，未做删改：只把标题降了一级。
> 收录：`12-pcb.md`、`13-pcb-route-pour-drc.md`、`14-pour-and-width.md`、`15-repour-trace.md`、`17-pour-final.md`、`18-pour-api-map.md`

---

### 来源：`notes/12-pcb.md`

## PCB 阶段：转换、量纲、板框

### 一、原理图转 PCB 的完整链路

```text
1. 设计 → 更新/转换原理图到PCB
   → 生成 PCB 文档（frame 树出现 entry=pcb 的新 frame）
   → 但板上是空的，只有文档，没有器件

2. pcb_Document.importChanges()
   → 弹出「确认导入信息」对话框，列出变更表（C1/C2/C3/R1/R2/R3 各一行「增加元件」）

3. 点对话框右下角「应用修改」（不是"确认"，也不是"确定"）
   → 器件真正落到 PCB
```

对话框还提供：分组依据、包含设计规则、同时更新导线的网络、优先库路径（工程 / 账号 / 标准版公开 / 最近 / 系统 / 团队）、导出报告。

导入后实测：**6 个元件、12 个焊盘**。

### 二、量纲：PCB 是 mil，原理图是 10mil

这是最容易翻车的一处，两边不一样：

| 域 | 单位 | 判断依据 |
|---|---|---|
| 原理图 | 10 mil | 官方文档明写「SCH 坐标单位 10mil」 |
| PCB | 1 mil | R0603 两焊盘间距实测 60 单位 = 1.6 mm，即 60 mil |

所以：

```text
5 cm = 50 mm = 1968.5 mil
```

我第一版按 10mil 思维把器件放在 (30,80,130)，结果间距只有 1.3 mm，0603 元件直接叠在一起。正确间距应 ≥ 150 mil。

### 三、板框：不能用直线，必须 Polyline

`pcb_PrimitiveLine.create` 的签名是 `(net, layer, startX, startY, endX, endY, lineWidth, primitiveLock)`——**是坐标序列，不是点数组**，我第一次按点数组传，一直报「无法创建直线图元」。

更关键：官方备注写明 **板框层（BOARD_OUTLINE = 11）必须用 Polyline 绘制，直线接口不适用**。

正确做法两步：

```js
// 1) 用 MathPolygon 构造闭合多边形，点之间用 'L' 连接
var poly = A.pcb_MathPolygon.createPolygon([
  0, 0, 'L', 1968, 0, 'L', 1968, -1968, 'L', 0, -1968, 'L', 0, 0
]);

// 2) 折线图元落在 11 层
var outline = await A.pcb_PrimitivePolyline.create("", 11, poly, 10, false);
```

回读确认：`layer: 11`、`polygon: [0,0,"L",1968,0,1968,-1968,0,-1968,0,0]`、`lineWidth: 10`。

### 四、PCB 页现在长什么样

| 区域 | 内容 |
|---|---|
| 左侧树 | agent-drill-rc50 → Board1 → Schematic1 → 1. P1 → PCB1 / Panel1 |
| 画布 | 6 个贴片元件（R1/R2/R3 = 13k，C1/C2/C3 = 0.1uF），两排布置，带**蓝色飞线** |
| 右侧 | 层管理器：1 顶层 / 3 顶层丝印 / 5 阻焊 / 7 锡膏 / 9 装配 / 2 底层 / 4 6 8 10 / **11 板框层** / 12 多层 / 13 文档层 |
| 底部 | 库 / 日志 / 器件标准化 / **DRC** / 查找结果 / 属性清单；DRC 面板已列出告警 |
| 工具栏 | 含 DRC 按钮、单位 mil、线宽/栅格 |

飞线存在说明**网络已经从原理图继承过来**（N1/N2/N3/GND），这是转 PCB 成功的硬证据。

### 五、DRC 在 PCB 侧同样可用

`pcb_Drc.check(strict, userInterface, includeVerboseError)`，与原理图侧同签名同行为：`userInterface=true` 才返回数组。

底部 DRC 面板实测已列出：`导线 $1N8 有多个网络名: N1, N1`、`发现元件引脚悬空，建议放置非连接标识在引脚上: R1.1`。

### 六、待办

| 项 | 状态 |
|---|---|
| 铺铜 | 未做，接口 `pcb_PrimitivePour` |
| 自动布线 | 未做，接口 `pcb_Document.autoRouting` / `startAutoRouting` / `getAutoJobStatus` |
| PCB DRC 门禁 | 接口已确认，未跑完整流程 |
| 板框尺寸校验 | 需读回多边形的实际长宽，确认 1968.5 mil（5 cm） |


---

### 来源：`notes/13-pcb-route-pour-drc.md`

## PCB 收尾：铺铜、自动布线、DRC 全通过

### 自动布线

```js
var r = await A.pcb_Document.autoRouting({});
```

返回：

```json
{"success":true,"totalNetsCount":4,"successNetsCount":4,"failedNets":[],"duration":1440}
```

耗时 1.44 秒，4 个网络全部布通，`failedNets` 为空。落地结果：**19 段走线**（`pcb_PrimitiveLine`）。

**补充（2026-11-03 终版复核，推翻此前多条误判）**：

- **自动布线的完整机制（2026-11-03 摸底，rpc_trace 抓包 + 实测）**：
  - **设置持久化**：`PCB_ManufactureData.updateAutoRouteRule(params)`（经
    `window._MSG_BUS2_EXTAPI_.rpcCall`，不在 API 根上）。UI 抓包参数：
    `routingRange / isKeep（保留已有导线）/ isDisplay（完成后展示迭代）/ routingEffectPriority /
    routingNetPriority / layers / ignoreNets / ignoreLayers / iterationCount（**字符串** "1"~"100）/
    routingDuration（字符串 "5"~"120"）/ routingPriorityTable（net+padCount+priority+checked）/ setNetPriority`。
  - **执行**：`pcb_Document.autoRouting(t)` 只认自己的参数（`RoutingNets/layers/cornerStyle/
    existingPrimitiveMode/optimization/ignoreNets/ignoreLayers`）；**实测存的规则不影响直调**
    （存了 `ignoreNets:['GND']` 后 `autoRouting({})` 仍布 GND）——要忽略网络必须写进调用参数。
  - **UI 的「运行」走扩展内部引擎**（不经 window 总线，抓不到），质量更好（同板 UI DRC 0、
    RPC 直调 DRC 11）；要 UI 质量只能走界面或 DSN/SES 第三方。
  - **布线预览态**：`isDisplay:true` 时布完进入「自动布线」横幅锁定态（同 topTabTip 机制），
    右下有 确认/取消；须点其一退出，期间 undo 无效。
  - **铺铜网络**：`autoRouting({ignoreNets:['GND']})` 实测 GND 0 段线、其余 3/3 全通——
    有铺铜的板子应把铺铜网络加进 ignoreNets，靠铺铜连接。
- **「历史记录」面板的恢复预览态（视口顶部橙色细横幅）会禁止一切写操作**：
  菜单条目整体变灰、`clearRouting`/`delete` 返回 `true` 但不生效、`autoRouting` 全部
  `failedNets`。此前记录的「清线接口空壳」「自动布线空转」都是这个状态造成的假象。
  关闭面板（右侧叉）即恢复正常。做任何写操作前先确认没有橙横幅。
- 正常编辑态实测（2026-11-03）：`clearRouting()` 50 段线 → 0；`autoRouting({})`
  4/4 网络布通（7.6s）。注意 RPC 布线质量可能不如界面路径（同板 UI 布线 DRC 0，
  裸参数 RPC 布线 DRC 11，差在间距），批量使用前先跑 DRC。
- 传 `RoutingNets: ['VCC33']` 这类数组会得到 `duration: 0`（参数形态无效被丢弃）；
  目前只有 `{}`（全部网络）这一种形态被确认可用。
- **菜单项禁用态的类名是 `eda-menu-item-disable-active_*`**：`-disable_*` 是样式基类，
  所有条目都有，按它判断会得出「全禁用」的错误结论。禁用态随上下文变化
  （例：板子已全布通时 `自动布线...` 会带 `-disable-active`，点了也不弹子菜单）。
- **菜单整体禁用与「板子是否布通」无关**（2026-11-03 对照实验）：在干净状态下，
  已全布通的板子上 6 个菜单 109 项全部可用。RPC 钩子、焦点模拟、合成开菜单、
  89 项选区逐一叠加都无法复现「全部禁用」。结合时间线，最可信的解释是
  **长操作进行中**（autoRouting 单次 4—6 秒、delete/clearRouting 批量调用）应用临时禁用
  编辑菜单，操作结束后自然恢复；另外合成事件打开的菜单对真人输入不响应，观感上等同「点不动」。
  排查手段：等 5 秒重试、按 Esc 清掉残留菜单、`menu_tree.py` 看 `disabled` 计数。
- **合成点击打开的菜单不可交互**：用 `dispatchEvent`/React `props.onClick` 点开顶级菜单后，
  菜单会渲染出来，但条目对真人鼠标没有反应、悬停也不出二级菜单（实测：全部条目文字色
  统一为 `rgb(134,134,134)`，子菜单不渲染）。要真点，必须走真实指针事件序列
  （`mouseMoved` → `mousePressed` → `mouseReleased`），且窗口在前台；否则请人工点。
- **清线类接口是空壳**：`pcb_Document.clearRouting()` 与 `pcb_PrimitiveLine.delete(ids)`
  都返回 `true`，但走线一条不少（实测 50 → 50）。要真清线只能走界面
  「布线 → 清除布线」（二级菜单），或用 `undo` 回退。

`startAutoRouting` / `getAutoJobStatus` / `getAutoJobLog` / `cancelAutoJob` 这一组是**空实现**（`startAutoRouting` 直接返回 `{jobId:""}`），不要用它们做任务轮询，直接调 `autoRouting` 同步等待。

`autoRouting(t)` 的 `t.layers` 可指定布线层；不传时自动取 `type` 为 `SIGNAL`/`PLANE` 的层。

### 铺铜

```js
var poly = A.pcb_MathPolygon.createPolygon([20,-20,'L',1948,-20,'L',1948,-1948,'L',20,-1948,'L',20,-20]);
var pour = await A.pcb_PrimitivePour.create("GND", 2, poly);
```

实测：**只有三个参数能用**（net, layer, polygon）。多传 `clearance`、`lineWidth` 会报「无法创建覆铜边框图元」。

- 层 2 = 底层，网络 GND
- 内缩 20 mil，避开板框
- 返回值带 `primitiveId`，可回读校验

### DRC 门禁

```js
var issues = await A.pcb_Drc.check(true, true, true);
```

实测返回 **空数组**（0 条问题），底部 DRC 面板显示「全部 (0)」。

与原理图侧同签名同行为：第三个参数位（`userInterface`）为 true 才返回数组，否则返回 boolean。

### 最终板面状态

| 项 | 数量 |
|---|---|
| 元件 | 6（R1/R2/R3 = 13k，C1/C2/C3 = 0.1µF，R0603） |
| 焊盘 | 12 |
| 走线 | 19 段 |
| 覆铜 | 1（底层 GND） |
| 板框 | 1（Polyline，层 11） |
| 过孔 | 0（单层布通，不需要换层） |
| DRC | **0 问题** |

板框 1968 × 1968 mil = 5 cm × 5 cm，元件在 (300..1300, -400..-700) 区域内，留足边距。

### 完整链路（从零到出板）

```text
1. Shift+N 建工程（Agent 窗口自动跟随）
2. 放置 → 快捷器件 → 电阻/电容，鼠标落位
3. getAll → modify 精确坐标 + rotation
4. getAllPinsByPrimitiveId → 引脚绝对坐标
5. sch_PrimitiveWire.create(折线, net) + await done()
6. sch_Drc.check(true,true,true) → 按 error/fatal 做门禁
7. 设计 → 更新/转换原理图到PCB
8. pcb_Document.importChanges() → 对话框点「应用修改」
9. modify 重排器件（PCB 单位是 1 mil！）
10. MathPolygon + PrimitivePolyline.create("",11,poly,10) 画板框
11. pcb_Document.autoRouting({}) 自动布线
12. PrimitivePour.create(net, layer, poly) 铺铜
13. pcb_Drc.check(true,true,true) → 0 问题
```

全程只有第 2 步依赖鼠标，其余都是 API，可重放。


---

### 来源：`notes/14-pour-and-width.md`

## 走线宽度、双层铺铜、缝合孔

### 一、按网络改走线宽度

没有「按网络设规则」的 API（`_EXTAPI_ROOT_` 里不存在 rule/constraint 类对象），但可以直接改图元：

```js
var lines = await A.pcb_PrimitiveLine.getAll();
var ids = lines.filter(l => l.net === "N1").map(l => l.primitiveId);
for (var id of ids) await A.pcb_PrimitiveLine.modify(id, { lineWidth: 20 });
```

实测：N1 的 5 段从 9.99997 mil 全部改为 20 mil，回读确认。

布线规则本身在 `设计 → 设计规则...` 对话框里（还有 `PCB设计规则...`、`网络类管理器...`、`差分对管理器...`），属于 UI 层，扩展 API 未暴露。

### 二、让 GND 不参与自动布线

用户提示的这条是对的，而且接口支持：

```js
await A.pcb_Document.clearRouting();                       // 先清空已有走线
await A.pcb_Document.autoRouting({ RoutingNets: ["N1","N2","N3"] });
```

实测结果：`totalNetsCount: 3, successNetsCount: 3, failedNets: []`，落地 12 段走线（N1=5、N2=5、N3=2），**GND 一段都没有**。

`RoutingNets` 还接受 `"selected"` / `"selectedComponents"` 两种特殊值。

### 三、双层铺铜

```js
var poly = A.pcb_MathPolygon.createPolygon([20,-20,'L',1948,-20,'L',1948,-1948,'L',20,-1948,'L',20,-20]);
await A.pcb_PrimitivePour.create("GND", 2, poly);   // 底层
await A.pcb_PrimitivePour.create("GND", 1, poly);   // 顶层
```

两个铺铜框都建成，`getAll` 回读为 `[{layer:2,net:"GND"}, {layer:1,net:"GND"}]`。

### 四、缝合孔（关键：参数顺序）

```js
await A.pcb_PrimitiveVia.create("GND", x, y, 12, 24);
```

参数是 **`(net, x, y, 孔径, 外径)`**，不是「外径、孔径」。

踩坑记录：先按 `(24, 12)` 传，DRC 立刻报

```
Physical Error / Via Size / viaSize
The outer diameter of the via hole of {obj1} is 12mil, which should be 19.7mil ~ 393.7mil
```

改成 `(12, 24)` 后 6 个过孔全部合规，过孔报错清零。

布置了 6 个：四角 (150/1850, -150/-1850) 加两个中点 (1000, -150/-1850)。孔径 12 mil、外径 24 mil、网络 GND。

### 五、未解决：铺铜只建了框，没有灌注

`pcb_PrimitivePour.create` 建的是**铺铜边框**。真正铜皮是 `pcb_PrimitivePoured`，实测数量恒为 **0**。

后果：DRC 报 1 条 `Connection Error: GND` —— GND 的焊盘只连着铺铜框，没有实际铜皮，所以判为未连接。

试过但无效的路径：

| 尝试 | 结果 |
|---|---|
| `pcb_Document.save()` | 保存成功，`Poured` 仍为 0 |
| 找 `pcb_Document` 里 pour/rebuild/refill 方法 | 一个都没有 |
| `_EXTAPI_CLI_COMMAND_SPACE_.run("repour" / "pcb.repour" / "PCB_REPOUR")` | 全部 `success:false` |
| 菜单 布线 / 布局 / 设计 | 无「重建铺铜」项 |

菜单里只有 `放置 → 铺铜区域`、`放置 → 缝合孔`、`布线 → 清除布线`。

**结论**：扩展 API 目前不提供「重建铺铜」。需要人工在画布上右键铺铜框 → 重建铺铜，或检查是否有未暴露的文档级命令。这一步标注为未验证完成。

**后续实测补正**（`notes/45-shift-b-not-working.md`）：

| 路径 | 结果 |
|---|---|
| **Shift+B**（传闻的快捷键） | **CDP 注入下按不动**：走线压在铺铜上制造 `Copper Region` 违例后，按键前后 `fills=73 / verts=117`、fill id、DRC 全不变；选中铺铜再按也一样 |
| 选中铺铜 → 右键 | 菜单有 取消/交叉选择/复制/剪切/重复/移动/删除/阵列/锁定/板子形状/裁剪/适应选中/高亮/网络/组合/xNet/扇出布线/偏移/旋转/翻转/翻面/属性.../复用模块，**没有"重建铺铜"** |
| 右键 → 属性... | 能开属性面板，但 `doSelectPrimitives(pourIds)` 选出的是多对象（15 个），面板无「重建铺铜区」按钮 |

要出现「重建铺铜区」按钮，得先**只选中一块铺铜**；用坐标点击目前没打通
（点到的常是板框 Polyline）。脚本里 `repour()` 只做"按键 + 回读校验"，几何没变就如实报告。

**当天稍后：可用路径已打通**（`notes/45-shift-b-not-working.md` 末节）

```text
1. doSelectPrimitives([单个 pourId])     → 选中 1 个 Region（传两个 id 会变 15 个"多对象"，按钮消失）
2. 面板折叠时：右键画布 → 「属性...」     → 展开属性面板（右键不改动选中）
3. 按文本找到「重建铺铜区」，走 React onClick（不要点坐标）
```

第 3 步必须走 React 事件：面板展开后按钮在 **x≈1284**，而视口宽只有 **1283**，
真实鼠标点击落在窗口外，前后 DRC/fills 全不变，很容易误判成"按钮无效"。

效果验证：造一条压在铺铜上的 VCC 线（DRC 报 `Copper Region(Filled) to Track`），
执行上述三步后该违例消失；`fills/verts` 可能不变（几何恰好一样），所以要看 DRC 而不是只看几何。

### 六、当前板面状态

| 项 | 值 |
|---|---|
| 元件 / 焊盘 | 6 / 12 |
| 走线 | 12 段（N1 加粗到 20mil，GND 无走线） |
| 铺铜框 | 2（顶层 + 底层，均 GND，未灌注） |
| 缝合孔 | 6（GND，孔径 12 / 外径 24） |
| DRC | 1 条 Connection Error（GND，因铺铜未灌注） |


---

### 来源：`notes/15-repour-trace.md`

## 重建铺铜的前端链路追踪

### 结论先说

「重建铺铜区」按钮背后发的是消息总线上的 **`rebuildSingleCopper`**。它**不经过扩展 API**，由编辑器内部引擎完成，所以没法用 `pcb_PrimitivePoured.create` 复现。

### 追踪方法

三步：定位按钮 → 打桩扩展 API → 记录消息总线。

#### 1. 按钮在哪

```
property_6MCf8 → value_section → lc_btn_hCDak（文字：重建铺铜区）
```

在右侧属性面板的「填充设置」分组里，同一组还有 `填充样式 全填充`、`保留孤岛 否`、`制造优化 是`、`最小优化宽度`。

**按钮位置随面板内容浮动**（出现过 y=499 与 y=461 两种情况），必须每次按文字定位，不能写死坐标。

#### 2. 扩展 API 不是它的入口

给 `pcb_PrimitivePoured.create / delete / modify` 打桩后点击按钮：

- 铜皮确实从 2 个变成 3 个
- **桩日志为空**

说明重灌注由编辑器内核（几何引擎）直接完成，扩展 API 只是读取结果的窗口。

#### 3. 消息总线上的真实命令

PCB 编辑器在 `entry=pcb` 的 iframe 里，有独立的 window 全局。其 `MSG_BUS_PCB` 暴露：

```
messageBus / messageBus2 / globalMessageBus / windowBridge / workerBus / extensionApiMessageBus2
每个都有 publish / subscribe / push / pull
```

包装 `publish` 记录频道名，点一次按钮，抓到完整序列：

```text
pcb/extensionAPI/copper-getAll
checkRemoveAllPlane
attributePlane
rebuildSingleCopper      ← 真正的重灌注命令
checkRemoveAllPlane
attributePlane
pcb/extensionAPI/poured-getAll
updateRtree / updateConnectRelation / refreshTearDrop / updateDRC
```

### 能不能自己发这条消息

试过，没成功：

| 尝试 | 结果 |
|---|---|
| `publish("rebuildSingleCopper")` | 无变化 |
| `publish("rebuildSingleCopper", primitiveId)` | 无变化 |
| `publish("rebuildSingleCopper", {primitiveIds:[id]})` | 无变化 |
| 换 `messageBus` / `globalMessageBus` 发 | 无变化 |

订阅同一频道想抓真实载荷时，点击没触发（按钮位置漂移导致点空），载荷结构仍未拿到。

### 目前可靠的路径

```text
1. 选中铺铜（API 或画布框选）
2. 按文字定位「重建铺铜区」按钮
3. 点击
4. 回读 pcb_PrimitivePoured.getAllPrimitiveId() 数量增加 → 成功
5. pcb_Drc.check(true,true,true) 复核
```

注意：**API 选中后按钮不一定生效**（出现过点两次都没反应的情况）。判定成功的唯一依据是 `Poured` 数量变化，不是「点了」。

### 顺带的清理经验

重复建铺铜会叠加。`pcb_PrimitivePour.delete([ids])` 会连同其灌注结果一起移除：

| 操作前 | 操作后 |
|---|---|
| 铺铜 6 个（层序列 2,1,1,2,1,2），灌注 4 个 | 铺铜 2 个（每层各一），灌注 2 个 |

删完 DRC 仍为 0，说明剩下的双层铺铜已足够覆盖 GND。

### 未完成

- `rebuildSingleCopper` 的载荷结构未知，未能用 API 直接触发
- 若后续拿到载荷，可完全脱离 UI；否则「API 选中 + 按钮点击」是当前最优解


---

### 来源：`notes/17-pour-final.md`

## 铺铜收尾：双层铜皮、缝合孔、分层验证

### 最终状态（实测回读）

| 项 | 值 |
|---|---|
| 元件 | 6 |
| 走线 | 12 段 |
| 铺铜框 | 2（层 2 与层 1，均 GND） |
| 灌注结果 | 2（id 与铺铜框一一对应） |
| 缝合孔 | 6（GND，外径 24 / 孔径 12） |
| 板框 | 1（Polyline，层 11） |
| DRC | **0 问题** |

GND 网络的图元构成：**3 个焊盘 + 2 个 Copper Region + 6 个过孔**。焊盘来自 C1/C2/C3 的下引脚，说明铜皮确实把这三处地接上了。

### 分层视觉验证

`pcb_Layer` 提供可见性控制：

```js
await A.pcb_Layer.setLayerInvisible(1);   // 关顶层
await A.pcb_Layer.setLayerVisible(2);     // 开底层
```

关掉顶层后截图：底层铜皮是**深蓝色整片**，覆盖板框内大部分区域，边缘内缩均匀，6 个过孔以圆环形式分布在四角与上下中点。恢复 `setLayerVisible(1)` 后回到常规视图。

这条方法可复用：想确认某一层到底有没有东西，把其它铜层关掉再出图，比看 DOM 可靠。

### 完整铺铜动作序列

```text
1. MathPolygon.createPolygon 构造内缩多边形
2. pcb_PrimitivePour.create(net, layer, polygon)   建铺铜框（每层一个）
3. 选中铺铜 → 点右侧属性面板「重建铺铜区」        ← 不点这步等于没铜
4. pcb_PrimitivePoured.getAllPrimitiveId() 计数增加 → 判定成功
5. pcb_PrimitiveVia.create(net, x, y, 孔径, 外径)  打缝合孔
6. pcb_Drc.check(true,true,true)                  门禁
```

第 3 步是最容易漏的：`create` 只建边框，`Poured` 数量为 0 时 DRC 会报 `Connection Error`。

### 缝合孔的作用验证

两层铺铜都是 GND，过孔也是 GND 且贯穿全层，因此上下铜皮通过 6 个过孔连通。DRC 为 0 是最硬的证据——若上下铜皮未连通或与焊盘断开，会直接报 Connection Error。

### 层可见性接口速查

```
setLayerVisible(id) / setLayerInvisible(id)
getCurrentLayer() / selectLayer(id)
setTheNumberOfCopperLayers(n) / getTheNumberOfCopperLayers()
getAllLayers() / getCurrentPhysicalStackingConfiguration()
```

层 id 常量：1 顶层、2 底层、3/4 丝印、5/6 阻焊、7/8 锡膏、9/10 装配、11 板框、12 多层、13 文档层。


---

### 来源：`notes/18-pour-api-map.md`

## 铺铜子系统的 API 测绘

> 这一份是接口地图，不是操作记录。目标是「换一块板、换一个版本，仍然知道该调什么」。

### 一、对象模型：两层

```text
PCB_PrimitivePour（铺铜框）
   │  用户画的多边形 + 网络 + 层 + 填充方式
   ▼  （几何引擎计算，不可直接写）
PCB_PrimitivePoured（灌注结果，派生对象）
   └─ pourPrimitiveId → 指回哪个框
      pourFills[].path.complexPolygon → 实际铜皮轮廓（含圆弧避让）
```

**关键字**：`Pour` 是意图，`Poured` 是结果。写 `Pour` 不等于有铜；`Poured` 只能由重建触发，扩展 API 没有它的 create 入口（打桩验证过，调用数为 0）。

### 二、Pour 的数据结构（实测 get 返回）

```json
{"primitiveType":"Pour","net":"GND","layer":2,
 "complexPolygon":{"polygon":[20,-20,"L",1948,-20,1948,-1948,20,-1948,20,-20]},
 "pourFillMethod":"solid","preserveSilos":false,
 "pourName":"POUR1","pourPriority":1,"lineWidth":0.2,
 "primitiveLock":false,"primitiveId":"b23e740940103618"}
```

| 字段 | 含义 | 实测值 |
|---|---|---|
| `net` | 网络名 | `"GND"` |
| `layer` | 层 id | `2` 底层 / `1` 顶层 |
| `complexPolygon.polygon` | 轮廓，`[x,y,'L',x,y,…]` 平铺 | 内缩 20 mil 的矩形 |
| `pourFillMethod` | 填充方式 | `"solid"`（全填充） |
| `preserveSilos` | 保留孤岛 | `false` |
| `pourName` | 名称，自动编号 | `"POUR1"` |
| `pourPriority` | 优先级，多个铺铜重叠时生效 | `1` |
| `lineWidth` | 铜皮到障碍的间距量纲 | `0.2` |
| `primitiveLock` | 锁定 | `false` |

### 三、Pour 的方法面

| 方法 | 签名要点 | 说明 |
|---|---|---|
| `create` | `(net, layer, polygon[, lineWidth, primitiveLock])` | **只接受 3 个参数**：多传第 4、5 个会报「无法创建覆铜边框图元」 |
| `getAll` | `(net?, layer?, primitiveLock?)` 三个可选过滤 | 实测无参可用 |
| `getAllPrimitiveId` | 同上 | 只返回 id |
| `get` | `(id)` 或 `([ids])` | 返回对象或数组 |
| `modify` | `(id, patch)` | 见下 |
| `delete` | `([ids])` | 连带删除其 Poured |

`modify` 的可改字段（从实现体读出，逐一调用 `setState_*`）：

```
net · layer · complexPolygon · pourFillMethod
preserveSilos · pourName · pourPriority · lineWidth · primitiveLock
```

### 四、Poured 的数据结构

```json
{"primitiveType":"Poured","pourPrimitiveId":"3ce5692e69ab46a8",
 "pourFills":[{"path":{"complexPolygon":[
    [194.4,-194.4,"L",2.4,-194.4,2.4,-2.4,194.4,-2.4,194.4,-194.4],
    [44.83,-67.09,"ARC",53.67,44.25,-68.22,"L",44.25,-71.77,"ARC",…]
 ]}}]}
```

要点：

- `pourFills[].path.complexPolygon` 是**数组的第一个元素是外轮廓，后续是挖空**（孔、避让）
- 轮廓里会出现 `"ARC"`，因为铜皮要绕开圆形焊盘
- `pourPrimitiveId` 指回源框，可据此判断某个框是否已灌注

方法面：`get / getAll / getAllPrimitiveId / delete / modify`，没有 `create` 的实际实现路径。

### 五、多边形工具 pcb_MathPolygon

| 方法 | 用途 |
|---|---|
| `createPolygon(arr)` | 单轮廓，`[x,y,'L',x,y,…]` 平铺 |
| `createComplexPolygon(arr)` | 多轮廓（带挖孔），参数为轮廓数组 |
| `splitPolygon(polys)` | 把复杂多边形拆成简单多边形数组 |
| `discretize(...)` | 把含 ARC 的路径离散成折线点 |
| `calculateWidth / calculateHeight / calculateBBoxWidth / calculateBBoxHeight` | 量尺寸 |
| `convertImageToComplexPolygon(...)` | 位图转轮廓 |

### 六、同族区域图元对比

| 图元 | create 参数个数 | 用途 |
|---|---|---|
| `pcb_PrimitivePour` | 9（实际只用 3） | 覆铜 |
| `pcb_PrimitiveFill` | 6 | 填充区域（实心，不避让） |
| `pcb_PrimitiveRegion` | 6 | 区域（挖槽 / 禁止 / 约束） |
| `pcb_PrimitivePolyline` | 5 | 折线；**板框层 11 必须用它** |

四个都是同一套 `create / delete / modify / get / getAll / getAllPrimitiveId`。

### 七、重建走的是消息总线，不是 API

点属性面板「重建铺铜区」时，`MSG_BUS_PCB` 上依次出现：

```text
checkRemoveAllPlane → attributePlane → rebuildSingleCopper → attributePlane
```

`rebuildSingleCopper` 是真正的重灌注命令。试过 `publish("rebuildSingleCopper", …)` 三种载荷都不触发，说明载荷结构不对或需特定上下文——**目前只能靠 UI 按钮触发**。

PCB 编辑器在 `entry=pcb` 的 iframe 里，有自己的 window；`MSG_BUS_PCB` 挂在它的全局上，含 `messageBus / messageBus2 / globalMessageBus / windowBridge / workerBus / extensionApiMessageBus2`，每个都有 `publish / subscribe / push / pull`。

### 八、坑清单

1. **create 不等于有铜**：`Poured` 数量为 0 时 DRC 必报 `Connection Error`
2. **多传参数会被拒**：Pour 只认 3 个参数
3. **批量删铺铜会卡进度条**：一次 `delete([4 个 id])` 触发大范围重算，进度条停在 66% 不走完；要么单个删，要么删完等收敛
4. **按钮位置会漂**：属性面板按钮 y 值随内容变化，必须按文本定位
5. **打桩会污染 toString**：一旦 `pcb_PrimitivePoured.modify` 被包装，后续读该方法的源码得到的是包装函数，要刷新页面才恢复
6. **层可见性影响视觉判断**：验证某一层必须先 `setLayerInvisible` 其它铜层，否则看到的是叠加色

> 补充：孤立铜定位、过孔围栏、`clearRouting` 会删缝合孔、`pourFills` 单位为 10 mil，见 `06-guideline-and-rules.md` 末节（源 `notes/24`）。

---

### 来源：`notes/25-batch3-silk-and-align.md`

## 批 3 收尾：丝印文字与对齐

### 一、丝印文字：`pcb_PrimitiveString.create` 的确切签名

```ts
create(layer, x, y, text, fontFamily, fontSize, lineWidth,
       alignMode, rotation, reverse, expansion, mirror, primitiveLock)
```

13 个参数，实测可用的最小写法：

```js
await A.pcb_PrimitiveString.create(3, 300, -260, "RC OSC 50Hz",
    "default", 70, 10, 3, 0, false, 0, false, false);
```

| 参数 | 取值 | 说明 |
|---|---|---|
| `layer` | `3` | 顶层丝印（4 = 底层丝印） |
| `x` / `y` | mil | PCB 坐标 |
| `text` | 字符串 | 内容 |
| `fontFamily` | `"default"` | 必须是已导入的字体，否则抛「字体列表里没有这种字体」 |
| `fontSize` | mil | 字号（高度） |
| `lineWidth` | mil | 笔画宽度 |
| `alignMode` | `3` | 左下对齐（实测） |
| `rotation` | `0` | 角度 |
| `reverse` / `expansion` | `false` / `0` | 反相与反相扩展 |
| `mirror` / `primitiveLock` | `false` | 镜像 / 锁定 |

回读确认三个字段：`text`、`layer`、`fontSize`、`lineWidth` 全部与传入一致。

#### 字号按 guideline §16.4 换算

guideline 用 mm，PCB 用 mil（1 mm ≈ 39.37 mil）：

| 用途 | 规范 mm | 实际取值 mil |
|---|---|---|
| 模块标题 | 1.5–2.0 | **70**（1.78 mm） |
| 产品名/版本号 | 2.0–3.0 | **80**（2.03 mm） |
| 接口标注 | 1.0–1.2 | **45**（1.14 mm） |

笔画宽度同步取 10 / 12 / 6 mil（规范 0.20–0.30 / 0.15–0.20 mm）。

### 二、对齐快捷键：顺序错了就不生效

`Ctrl+Shift+O`（顶对齐）实测有效，但**必须按这个顺序**：

```text
1. 点画布空白处 → 让画布持有焦点
2. API doSelectPrimitives([ids]) → 建立选中
3. 发 Ctrl+Shift+O（modifiers = 10，即 Ctrl+Shift）
4. 回读坐标确认
```

反例（无效）：

- 先 API 选中、再发键 → 无反应（画布无焦点）
- 先点画布、再发键 → 选中被点没了

实测：R2 被挪到 y=-520，选中三个电阻按 `Ctrl+Shift+O` 后回到 y=-400，与 R1/R3 齐平。

可用键位（guideline §18.1）：
`Ctrl+Shift+L` 左对齐 / `R` 右 / `O` 顶 / `B` 底 / `E` 水平居中 / `H` 垂直居中 / `G` 对齐网格。

### 三、落地的丝印布局

按 guideline §16.6 的推荐模式：

| 内容 | 位置 | 字号 |
|---|---|---|
| 模块标题 `RC OSC 50Hz` | 左上 (300,-260) | 70 mil |
| 版本 `V1.0` | 右上 (1700,-120) | 80 mil |
| 接口标注 `J1 UART DEBUG` | 左侧 (300,-1100) | 45 mil |

出图确认三处文字都在顶层丝印、渲染正常、无遮挡。

**注意**：`J1 UART DEBUG` 是示意标注，板上实际没有 J1 连接器——真实项目里丝印必须与实际器件对应，这条属于反面示例。

### 四、批 3 最终状态

| 条目 | 状态 |
|---|---|
| 过孔围栏 | ✅ 38 孔等距 + 1 补岛孔 |
| 孤立铜定位与修复 | ✅ DRC `pos` → 补孔 → 重建 → 0 问题 |
| 丝印文字 | ✅ API 直接创建，字号按规范换算 |
| 对齐 | ✅ 快捷键链路打通（顺序敏感） |
| 扇出 / 等长 | 🟡 菜单项确认存在，缺差分/多引脚上下文，未执行 |
| 泪滴 | ❌ 无可见入口、无 API |
| 安装孔 NPTH | ❌ `放置 → 焊盘` 存在，未验 |

板面：6 元件 / 19 走线 / 2 铺铜+2 灌注 / 39 过孔 / 3 处丝印 / **DRC 0 问题**。
