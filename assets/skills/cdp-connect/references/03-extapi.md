# 扩展 API 总览（_EXTAPI_ROOT_）

> 本文件由 `notes/` 逐字合并生成，未做删改：只把标题降了一级。
> 收录：`08-extapi.md`

---

### 来源：`notes/08-extapi.md`

## 官方扩展 API：绕过坐标点击的正路

### 怎么找到的

坐标点击只能「画上去」，无法保证落在 1mm 宽的引脚上。于是换思路：查页面里有没有内部 API。

- 隔离世界（`createIsolatedWorld`）里 `typeof eda === 'undefined'`——扩展 API 不在隔离世界，**必须在主世界求值**。
- 主世界（`Runtime.evaluate` 不带 `contextId`）的 `window` 上有：
  `SCH`、`electronAPI`、`_EXTAPI_ROOT_`、`_EXTAPI_CLI_COMMAND_SPACE_`、`_MSG_BUS_PCB_`

`_EXTAPI_ROOT_` 就是官方扩展 API 的根对象，键名与 [prodocs.lceda.cn 扩展 API](https://prodocs.lceda.cn/cn/api/reference/) 完全对应。

### 接口清单（实测存在）

| 域 | 对象 | 关键方法 |
|---|---|---|
| 文档 | `dmt_Schematic` | createSchematicPage、getCurrentSchematicPageInfo、getAllSchematicPagesInfo |
| 文档 | `dmt_Board` / `dmt_Pcb` | createBoard、getCurrentBoardInfo |
| 编辑器 | `dmt_EditorControl` | openDocument、closeDocument、activateDocument、zoomTo、zoomToAllPrimitives、getCurrentRenderedAreaImage |
| 选择 | `sch_SelectControl` / `dmt_SelectControl` | getSelectedPrimitives、doSelectPrimitives、clearSelected、getCurrentMousePosition |
| 图元 | `sch_PrimitiveComponent` | create、get、getAll、getAllPrimitiveId、getAllPinsByPrimitiveId、delete、modify、placeComponentWithMouse、createNetFlag、createNetPort |
| 图元 | `sch_PrimitiveWire` | create、get、getAll、getAllPrimitiveId、modify、delete |
| 图元 | `sch_PrimitivePin` / `Text` / `Rectangle` / `Bus` / `Arc` / `Polygon` / `Circle` | 同名 CRUD |
| 网络 | `sch_Net` | getAllNetsName、getNet、getAllNets |
| 网络 | `sch_Netlist` | getNetlist、setNetlist |
| 校验 | `sch_Drc` | check |
| PCB | `pcb_PrimitivePour`、`pcb_Net`、`pcb_Drc`、`pcb_Document.autoRouting` | 铺铜、网络、DRC、自动布线 |
| 系统 | `sys_Setting`、`sys_ShortcutKey`、`sys_Dialog`、`sys_ToastMessage`、`sys_FileSystem` | 设置、快捷键、对话框、文件 |

方法都在**原型**上，`Object.keys()` 返回空数组，必须用 `Object.getOwnPropertyNames(Object.getPrototypeOf(obj))`。

### 调用方式

全部是 `async`，必须 `await` 后再取值，否则 `JSON.stringify` 得到 `{}`：

```js
(async () => {
  var A = globalThis._EXTAPI_ROOT_;
  var list = await A.sch_PrimitiveComponent.getAll();
  return JSON.stringify(list.map(c => ({id: c.primitiveId, des: c.designator, x: c.x, y: c.y})));
})()
```

CDP 侧要设 `awaitPromise: true, returnByValue: true`。

### 读：坐标与引脚（解决 C2/C4）

`getAll()` 实测返回：

```json
{"primitiveId":"009c38a62733a8b1","componentType":"part","designator":"R1","x":200,"y":510,"rotation":0,"symbol":{"name":"电阻"}}
{"primitiveId":"24a00f1e5c6e26bf","componentType":"part","designator":"C1","x":380,"y":590,"symbol":{"name":"Capacitance"}}
```

`getAllPinsByPrimitiveId(id)` 给出引脚绝对坐标：

| 器件 | 引脚 | 坐标 |
|---|---|---|
| R1 | pin1 / pin2 | (180,510) / (220,510) |
| C1 | pin1 / pin2 | (360,590) / (400,590) |

坐标单位是 **10 mil**（文档明确写「SCH 坐标单位 10mil」）。所以 510 = 5.1 英寸。

### 写：导线（解决 C3）

签名（官方文档）：

```ts
create(line: Array<number> | Array<Array<number>>, net?: string,
       color?: string|null, lineWidth?: number|null, lineType?: number|null)
```

三条硬约束：

1. **线段必须水平或垂直**，斜线会被判非法
2. **多段必须首尾相连**，彼此无连接的段会失败
3. **每段至少 3 个数字**。`[[220,510],[360,510]]` 里每段只有 2 个数字＝只有一个点，被忽略，整条路径为空 → `create failed!`

正确写法（一条折线，先横后竖）：

```js
var w = await A.sch_PrimitiveWire.create([220,510, 360,510, 360,590], "N_RC1");
```

**必须再调 `done()` 才落到画布**：

```js
await w.done();     // 不加这句，getAll 里看不到这根线
```

未提交前 `getAll` 查不到，提交后才出现在列表里，且 `line` 会被规范化（端点顺序可能与传入相反）。

### 网络冲突导致的失败

不指定 net 时，若导线两个端点分别落在**两个不同网络**的图元上，`create` 直接失败（文档规则 3）。落在一个元件引脚 + 一个空白点时，跟随该引脚网络。

所以连线时**显式传网络名**最稳，例如 `"N_RC1"`。

### 可靠工具集（实测通过）

| 操作 | 方法 | 结论 |
|---|---|---|
| 读元件 | `sch_PrimitiveComponent.getAll()` | 通过，含 primitiveId / designator / x / y / symbol |
| 读引脚 | `getAllPinsByPrimitiveId(id)` | 通过，绝对坐标 |
| 移动/改属性 | `modify(id, {x, y, rotation, designator, name, …})` | 通过，立即生效（C1 从 y=590 改到 700 立刻可读回） |
| 建导线 | `create(line, net)` + `await w.done()` | 通过，必须 done 才落盘 |
| 删图元 | `delete([id1, id2])` | 通过，接受数组，立即生效 |
| 缩放 | `dmt_EditorControl.zoomToAllPrimitives()` | 通过 |
| 读选中 | `sch_SelectControl.getAllSelectedPrimitives()` | 通过，返回数组 |

#### 一次超时

`sch_PrimitiveComponent.create(component, x, y)` **挂死并触发 20 秒超时**，事后 `getAll` 无残留。组件描述符是对的（`{libraryUuid, uuid, name:"Res_0603"}` 来自现有元件），所以问题不在参数形状，可能是等交互或加载库。

#### 由此定下的放置策略

**鼠标放，API 定位**：

1. `放置 → 快捷器件 → 电阻/电容`，在画布任意位置点一下（位置不需要准）
2. `getAll()` 找到最新元件
3. `modify(id, {x, y})` 改到计算好的精确坐标

坐标精度由 API 保证，鼠标只负责"创建这个元件"。

### 撤销与模式退出（实测）

- 应用用的是**自绘光标**，`getComputedStyle(canvas).cursor` 恒为 `auto`，不能用来判断是否在走线模式
- 判断模式看两处：`getAllSelectedPrimitives()` 的数量、右侧属性面板是「图样」还是「导线」
- **没有焦点时按 Esc 无效**。必须先在画布上点一下或右键，让画布持有焦点，再按 Esc
- 右键单击可以取消当前命令，再 Esc 收尾；两者配合能可靠退出走线模式

### 已知未解决

| 项 | 现象 |
|---|---|
| `sch_Drc.check()` | 恒返回 `false`，未拿到问题列表；可能需要传文档参数 |
| `sch_Netlist.getNetlist()` | 计算过重，触发 WebSocket 20 秒超时；改用 `getAllNetsName` 或 DRC |
| `sch_Net.getAllNetsName()` | 建线后仍返回空数组，网络名未回灌到该接口 |
| `dmt_SelectControl.getCurrentDocumentInfo()` | 从外壳窗口调用返回 `{}`，需要进一步确认调用上下文 |
| `delete` | 返回成功但图元仍在，疑似同样需要 `done()` 提交 |

### 鼠标模拟仍然要留

用户提示：进入导线创建模式后，可以用鼠标移动和点击打折点。这条保留为**兜底通道**，适用于：

- API 不覆盖的交互（拖拽、框选、属性面板内联编辑）
- API 行为随版本变化时的退路
- 需要"人看到的过程"来做验证的场景

优先级：**API 优先，鼠标兜底**。API 给坐标与提交结果，鼠标给可视化验证。

---

### 来源：`notes/42-pad-click-selection.md`

## PCB 选择控制（`pcb_SelectControl`）：全量方法与真实语义

### 方法表（原型链上，`Object.keys` 看不到，要走原型）

```text
clearSelected
doCrossProbeSelect          doCrossProbeSelectByObject
doSelectPrimitives
getAllSelectedPrimitives    getAllSelectedPrimitives_PrimitiveId
getSelectedPrimitives       getCurrentMousePosition
```

注意：`pcb_SelectControl` **没有** `getCurrentFilterConfiguration`。
选择过滤（右侧「过滤」页）不在扩展 API 里，只能看 UI。

### 四个对象的区别

| 方法 | 底层 rpc | 返回 |
|---|---|---|
| `getSelectedPrimitives()` | `getAllSelectedPrimitives` | **原始** PCB 数据（`globalIndex`/`layerId`/`topType`…），不做封装 |
| `getAllSelectedPrimitives()` | 同上 + 按 `pcbItemPrimitiveType` 转成扩展对象 | 只认 Via / Pad / Component / Rect / Circle / Polygon / Image / Dimension / Track / ArcTrack；`Text` 和未知类型**直接丢弃** |
| `getAllSelectedPrimitives_PrimitiveId()` | `getAllSelectedPrimitiveIds` | id 字符串数组 |
| `doSelectPrimitives(idOrIds)` | `doSelectPrimitives` | 传字符串会自动包成数组；返回 `true/false` |

### 三个必须记住的坑

1. **焊盘对象没有 `id` 字段**，只有 `primitiveId`。
   `doSelectPrimitives([p.id])` 会得到 `false` 且不报错。

2. **属性面板里的「ID」不是 `primitiveId`**。
   同一个 D_P 焊盘：面板显示 `e0e14`，API 的 `primitiveId` 是 `e207e53`。
   要喂 API 一律用 `primitiveId`。

3. **空选中时 `getAllSelectedPrimitiveIds` 返回畸形串**，例如 `"rate207e53e272e35"`
   （`rate` + 本焊盘 id + 同网络另一焊盘 id 粘连），而同一时刻
   `getAllSelectedPrimitives()` 返回 `[]`、属性面板「选中数量」为 0。
   所以这个接口**不能用来判断"选中了几个"**，只能在已知有选中时读 id。

### 判定"选中态"的可靠读法

```js
// 图元数量：可靠（空就是空）
var n = (await A.pcb_SelectControl.getAllSelectedPrimitives()).length;
// 二次确认：UI 侧地面真值（属性面板头部）
// 「选中数量 N」——用 DOM 取，不受 rpc 畸形串影响
```

### `pcb_Event` 监听的正确签名

```js
A.pcb_Event.addMouseEventListener(id, eventType, callFn, onlyOnce)
A.pcb_Event.addPrimitiveEventListener(id, eventType, callFn, onlyOnce)
```

签名是四参数，**第三个才是回调**（早期把回调放在第二位，静默不生效）。

注册其实**是成功的**，缺口在派发：

| 观测 | 结果 |
|---|---|
| `_EXTAPI_ROOT_.extensionUuid` | 字符串 `"eda"`（占位身份，不是真扩展 uuid） |
| `addMouseEventListener(...)` | 不报错 |
| `isEventListenerAlreadyExist(id)` | 返回 **true** —— 记录确实进了事件表 |
| 真实点击后回调 | `mousedown/mouseDown/MouseDown/down/click/mouseup/mousemove` 七种 eventType 全部不触发 |

即派发侧按扩展身份过滤，非扩展身份收不到。**不要用它观测命中图元**——
用 `pcb_Document.getPrimitiveAtPoint`（见下节），一次 RPC 就有答案。

### 命中查询：`pcb_Document.getPrimitiveAtPoint(x, y)`

```js
await A.pcb_Document.getPrimitiveAtPoint(4916.9, -6825.5)
// → Pad / Line / Component / Via / null（该点最上面一个，含 primitiveId、net）
```

| 项 | 说明 |
|---|---|
| 返回 | 只给最上面一个（封装层 `return r[0]`，底层 rpc 返回的是数组） |
| Polygon/铺铜 | 抛 `单多边形验证不通过`（封装把 `pathString` 包成数组，自身 bug）→ 必须 try/catch |
| 空结果 | 画布重绘瞬间会返回空数组；同坐标连续 8 次查询本身稳定，重试一次即可 |
| 原理图 | `sch_Document.getPrimitiveAtPoint` 同名同签名 |

它是画布点击用的那套命中判定，所以能直接回答"这一点点下去会选中谁"。
用法与坑（采样步长、焊盘中心被走线占据、焊盘坐标不在图形上）
见 `02-input-and-canvas.md` 第四节与第五节。
