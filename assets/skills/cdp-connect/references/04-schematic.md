# 原理图：搭建、DRC、器件标准化

> 本文件由 `notes/` 逐字合并生成，未做删改：只把标题降了一级。
> 收录：`10-rc-ladder.md`、`11-drc-and-junctions.md`、`19-device-standardization.md`

---

### 来源：`notes/10-rc-ladder.md`

## 三节 RC 梯形网络的搭建实录

### 参数

三节 RC 移相振荡器，`f = 1 / (2π·R·C·√6)`。

取 `C = 0.1 µF`、`R = 13 kΩ`：

```text
f = 1 / (2π × 13000 × 0.1e-6 × 2.449) ≈ 50.0 Hz
```

### 布局（文档坐标，单位 10 mil）

| 器件 | 中心 | 旋转 | 引脚 |
|---|---|---|---|
| R1 | (150,350) | 0° | 130,350 / 170,350 |
| R2 | (310,350) | 0° | 290,350 / 330,350 |
| R3 | (470,350) | 0° | 450,350 / 490,350 |
| C1 | (230,470) | 90° | 230,450 / 230,490 |
| C2 | (390,470) | 90° | 390,450 / 390,490 |
| C3 | (550,470) | 90° | 550,450 / 550,490 |

节点：N1 = x230、N2 = x390、N3 = x550；地线在 y=490。

**注意 y 轴方向**：文档坐标 y 越大，屏幕上越靠上。设计时把电容写在 y=470（以为在下方），实际渲染在电阻（y=350）上方。电气上无差别，但布置时要记住这个反向关系。

### 建线：9 段输入，4 根落地

按引脚坐标建了 9 段导线（N1×3、N2×3、N3×2、GND×1），每段 `create` + `done()` 都返回 ok。

随后 `getAll()` 只返回 **4 根**，因为编辑器按网络把共线且相连的段**自动合并**了：

| 网名 | 合并后的 line |
|---|---|
| N1 | `[170,350, 230,350, 230,350, 230,450, 290,350, 230,350]` |
| N2 | `[330,350, 390,350, 390,350, 390,450, 450,350, 390,350]` |
| N3 | `[550,450, 550,350, 550,350, 490,350]` |
| GND | `[230,490, 390,490, 550,490, 390,490]` |

所以在同一轮里「创建 9 段 → 立刻读回」会看到数量对不上，**必须等一拍再读**。断言应该看网络名与端点覆盖，不要看根数。

### 改数值

元件默认值是 `10K` / `10uF`（快捷器件自带的），必须显式改写：

```js
await A.sch_PrimitiveComponent.modify(id, {
  otherProperty: Object.assign({}, c.otherProperty, {Value: "13k"})
});
```

回读确认 6 个元件全部为 `13k` / `0.1uF`。`name` 字段仍是 `={Value}` 表达式，显示时会解析成实际值。

### 视觉校验

`getCurrentRenderedAreaImage` 出图可直接看出：三只电容并联在公共地线上、三只电阻串联成节点链、导线无断开。这是本阶段最可靠的验收手段。

### 未完成

| 项 | 状态 |
|---|---|
| 放大级（晶体管/运放） | 未做。快捷器件只有 电阻/电容/电感/二极管，晶体管要走器件库 |
| 电源/地符号 | `createNetFlag("Ground", x, y)` 报「数据不符合规范」，参数形态未摸对 |
| DRC | `sch_Drc.check()` 恒返回 false，未拿到问题列表 |
| 转 PCB | 未开始 |

### 当前工程状态

`agent-drill-rc50` / `1. P1`：6 个元件（R1/R2/R3=13k，C1/C2/C3=0.1uF）、4 个网络（N1/N2/N3/GND）、无悬空导线。


---

### 来源：`notes/11-drc-and-junctions.md`

## DRC 打通：返回值、严重级与 T 型分支

### 正确调用方式

`sch_Drc.check()` 返回 **false**，看不出任何信息。必须带 UI 标志才返回问题数组：

```js
var issues = await A.sch_Drc.check(true, true, true);
// 签名：check(strict = true, userInterface = false, includeVerboseError = false)
```

`userInterface = true` 时返回数组，同时界面上会打开 DRC 面板并出现结果列表。

### 返回结构

```json
[{"type":"warn","rule":"ONENETNAME","net":"N1、N1",
  "primitives":[{"primitiveId":"06ec302bd67da6f6","sheet":"e774cb3f7dce7f97","name":"$1N8"}]},
 {"type":"warn","rule":"CHECKFLOATPIN",
  "primitives":[{"primitiveId":"009c38a62733a8b1-e29","designator":"R1","name":"1"}]}]
```

| 字段 | 含义 |
|---|---|
| `type` | `fatal` / `error` / `warn` / `info`，决定能否放行 |
| `rule` | 规则代号，如 `CHECKFLOATPIN`（引脚悬空）、`ONENETNAME`（同名网络） |
| `primitiveId` | 直接给出问题图元，可配合 `get` 定位 |
| `designator` / `net` | 有则给出位号与网络名 |

界面对应面板的统计：`全部(6) 致命(0) 错误(0) 警告(4) 信息(2)`。

### 这次 DRC 抓到了什么

1. **`CHECKFLOATPIN`：R1 引脚 1 悬空** —— 真实问题。这一版电路没有放大级，输入端确实是开路的。DRC 正确识别。
2. **`ONENETNAME`：N1、N2 各报一条** —— 我的走线方式导致的告警，不是电路错误。

### ONENETNAME 的来源与处置

三节移相网络天然存在**三通节点**（一个电阻进、一个电阻出、一个电容到地），用 API 建线时表现为「同一网名落在两段独立导线上」：

```text
N1: [170,350 → 230,350 → 230,450]   +   [230,350 → 290,350]
```

在 (230,350) 补了 `sch_PrimitiveObject.create("Junction", 230, 350)`（连接点图元），告警**没有消失**。说明该规则判的是「同名网络分散在多段导线上」，而不是「缺连接点」。

三条可选处置：

1. **接受告警**：判据放在 `type === "fatal" | "error"` 上，警告只做提示。本次错误数与致命数均为 0。
2. **一段到底**：把每个网络改成一条不回折、不分叉的折线。移相网络的 T 节点决定了这条走不通，除非改拓扑。
3. **换连接方式**：用网络标签（Net Label）给分支命名，而不是给两段导线都赋同一个 net。

实际采用第 1 条：**DRC 作为门禁，只看 错误 与 致命**。

### 连接点图元

```js
await A.sch_PrimitiveObject.create("Junction", x, y);
```

`content` 字段为 `"Junction"`，`width/height = 0`，属于 `primitiveType: "Object"`。删除用 `sch_PrimitiveObject.delete([ids])`。

### 当前 DRC 结论

| 指标 | 值 |
|---|---|
| 致命 | 0 |
| 错误 | 0 |
| 警告 | 3（2 条 ONENETNAME + 1 条 R1 引脚悬空） |
| 信息 | 2 |

门禁通过：没有致命与错误。悬空引脚会在补上放大级后消失。


---

### 来源：`notes/19-device-standardization.md`

## 器件标准化子系统的 API 测绘

### 一、立创编号存在哪

不是 `otherProperty`，是组件的**顶层四个字段**：

```json
{"supplier":"LCSC", "supplierId":"C855609",
 "manufacturer":"YAGEO(国巨)", "manufacturerId":"AT0603BRD0713KL"}
```

`otherProperty` 里只有 `Value`、`Supplier Footprint`、`PCB Layer` 这类描述性字段，没有编号。

### 二、赋值与清空

```js
await A.sch_PrimitiveComponent.modify(id, {
  supplier: "LCSC", supplierId: "C855609",
  manufacturer: "YAGEO(国巨)", manufacturerId: "AT0603BRD0713KL"
});
```

**清空必须传 `null`，传空字符串无效**：

| 传值 | 结果 |
|---|---|
| `{supplierId:""}` | 没有变化，编号仍在 |
| `{supplierId:null}` | 清空成功，回读为空 |

这条是硬坑：`modify` 内部按 `!== undefined` 判断，空字符串会被当成"赋值成空串但引擎侧不落盘"。

### 三、库检索接口

```js
lib_Device.search(key, libraryUuid?, classification?, symbolType?, itemsPerPage = 10, page = 1)
```

返回条目字段（实测）：

| 字段 | 示例 |
|---|---|
| `uuid` / `libraryUuid` | 器件与库标识 |
| `name` | `AT0603BRD0713KL` |
| `classification` | `["电阻","贴片电阻"]` |
| `symbolUuid` / `symbolName` | 符号 |
| `footprintUuid` / `footprintName` | `R0603` |
| `description` | `电阻类型:薄膜电阻;阻值:13kΩ;精度:±0.1%;…` |
| `manufacturer` / `manufacturerId` | `YAGEO(国巨)` / `AT0603BRD0713KL` |
| `supplier` / `supplierId` | `LCSC` / `C855609` |
| `otherProperty` | JSON 串，含 `LCSC Part Name`、`Supplier Part` |

另有 `getByLcscIds([ids], libraryUuid?, allowMultiMatch?)` 按编号反查，返回结构比 search 精简（实测只稳定拿到 `name`）。

### 四、结果可信度校验（必须做）

同一条查询，首条结果可能是**系统占位条目**，直接采用会把错误数据写进 BOM。

实测对比：

| 查询 | 首条 | 判定 |
|---|---|---|
| `13k 0603` | `AT0603BRD0713KL` / YAGEO / `C855609` | 可用 |
| `0.1uF 0603` | `name:"0603"` / 制造商空 / `C9900021180` | 拒 |
| `0.1uF 50V 0603` | `CAP_JNC_7R5MM`，直插封装，制造商空 | 拒 |
| `100nF 0603` | 前两条均为 `C99…` 占位 | 拒 |

三条硬规则：

1. `supplierId` 以 `C99` 开头 → 系统占位，不是真实商城料
2. `manufacturer` 为空 → 无法追溯，拒
3. `name` 与 `footprintName` 同名（如都叫 `0603`）→ 只是封装占位，拒

### 五、面板结构（原理图文档下）

底部标签 `器件标准化`。**只在原理图文档有数据，PCB 文档下显示「没有数据」**。

| 区域 | 内容 |
|---|---|
| 过滤 | 全部 / 待确定 / 待分配编号 / 完全匹配 / 不检查，各带计数 |
| 工具 | 刷新列表、设置为不检查、设置为检查、位号聚合、显示推荐、导出BOM、立创商城元件下单、嘉立创SMT备料下单 |
| 表头 | 序号、位号、操作、供应商编号、供应商、备注、封装、数量、制造商编号、制造商 |
| 操作列 | 按钮「分配立创编号」 |

### 六、坑

1. **计数不实时**：`modify` 写入后，面板计数仍显示旧值；点「刷新列表」计数也不变（列表内容会变）。判定成功只能读组件字段，不能看面板数字。
2. **切标签会收起面板**：从 `器件标准化` 切到 `库` 再切回，面板区域会塌掉，需要重新点标签。
3. **PCB 文档下无数据**：不切回原理图就看不到待分配列表。
4. **同值多件会被聚合**：`位号聚合` 开启时，R1/R2/R3 只显示一行（以 R3 为位号），数量列反映总数。

### 七、当前工程状态

| 位号 | 值 | 立创编号 | 制造商 |
|---|---|---|---|
| R3 | 13k | `C855609` | YAGEO(国巨) |
| R1/R2 | 13k | 空 | — |
| C1/C2/C3 | 0.1uF | 空 | — |

R3 是唯一按校验规则通过并写回的；电容因检索结果全是占位条目，未采用，已回滚为未分配。
