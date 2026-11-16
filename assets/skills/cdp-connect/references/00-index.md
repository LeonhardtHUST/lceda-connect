# 索引与速查（先读这一页）

本 skill 的 references 由三类内容组成：

| 类型 | 文件 | 性质 |
|---|---|---|
| 入口 | `00-index.md`（本页） | 速查卡 + 阅读路径 |
| 综合 | `08-capability-model.md` | 能力模型、缺口清单、实验结论总览 |
| 合并卷 | `01`–`07` | `notes/` 逐字合并，含全部原始细节 |
| 配置与契约 | `setup-guide.md`、`launcher.md`、`api-contract.md` | 依赖配置、实例生命周期、对外接口承诺 |
| 扫描工具说明 | `ui-map.md`、`interface-baseline.md`、`expansion-rules.md` | target/iframe 结构、扫描基线、扩展规则 |
| 生命周期 | `restart-and-relaunch.md` | 哪些设置会让客户端自重启、重启后什么失效 |

## 一、按任务找文件

| 我要做的事 | 读哪几份 |
|---|---|
| 连上客户端、认窗口/文档上下文 | `01-windows-and-context.md`、`setup-guide.md` |
| 装依赖、配端口、撤销调试能力 | `setup-guide.md` |
| 生成启停脚本、做常驻入口 | `launcher.md` |
| 端点突然没了 / 改了设置之后连不上 | `restart-and-relaunch.md`、`launcher.md` |
| 被其他 skill 依赖 / 复用连接层 | `api-contract.md` |
| 点控件、键入、画布坐标、防卡死 | `02-input-and-canvas.md` |
| 直接调内部 API（不要点坐标） | `03-extapi.md` |
| 画原理图、跑 ERC、分配立创编号 | `04-schematic.md` |
| 转 PCB、画板框、自动布线、铺铜 | `05-pcb.md` |
| 设规则、划禁止/约束区域、做视觉规范 | `06-guideline-and-rules.md` |
| 查菜单项、快捷键 | `07-menus-and-shortcuts.md` |
| 判断"这事到底能不能自动化" | `08-capability-model.md` |

## 二、九条全局纪律

1. **文档上下文优先**。`pcb_*` 接口只在 PCB 文档激活时可用；切到原理图后调用会抛 `Cannot read properties of null`。同理 `sch_*` 只在原理图文档下有效。
2. **验证看数量与字段，不看面板**。器件标准化的面板计数不实时刷新；铺铜要数 `Poured`，不要看界面。
3. **写操作后查进度条**。`[class*="progress-message"]` 连续 3 次不变（约 6 秒）→ 点 `[class*="progress-tool-close"]` 取消 → 回读图元数量确认没写坏。
4. **按文字定位按钮**。属性面板按钮的 y 会随内容漂移，写死坐标必然点空。
5. **坐标不写死**。用 `getCurrentMousePosition()` 现场标定屏幕↔文档映射，缩放一变就重标。
   标定要**两轴独立最小二乘**（`docX=bx+sx*scrX`、`docY=by+sy*scrY`），两点定比例会被网格吸附带偏。
6. **重建铺铜用属性面板按钮，别用 Shift+B**。Shift+B 按不动（实测几何、fill id、DRC 全不变）。
   可用路径是：`doSelectPrimitives([**单个** pourId])` → 属性面板点「重建铺铜区」。三个坑：
   传多个 id 会变"多对象"选中、按钮消失；面板折叠时按钮不出现，要用「右键 → 属性...」展开；
   **展开后按钮可能跑到视口外（x≈1284 > 宽 1283），必须走 React onClick 而不是点坐标**。
7. **判"选中"要选对信号**。光标移出画布后 `getCurrentMousePosition()` 会静默冻结在上一个画布内坐标；
   空选中时 `getAllSelectedPrimitives_PrimitiveId()` 会返回畸形串（`"rate"+id` 粘连）。
   断言"选中"只用 `getAllSelectedPrimitives().length`，焊盘用 `doSelectPrimitives([primitiveId])` 直选。
8. **退工具用右键，别用 Esc**。右键一次即退且不依赖键盘焦点；Esc 在 CDP 下退不出（事件能到
   iframe DOM，但应用不响应）。选择态右键会弹 `.ctxmenu-ulist` 菜单，而它只认"点画布空白"关闭。
9. **点之前先问命中**。`pcb_Document.getPrimitiveAtPoint(x, y)` 返回该点最上面的图元。
   焊盘中心常被自家走线端点占住、部分焊盘的坐标还落在图形缝上，直接点中心会选错对象。

## 三、关键常量速查

### 单位

| 域 | 单位 | 换算 |
|---|---|---|
| 原理图 | 10 mil | 坐标 510 = 5.1 英寸 |
| PCB | **1 mil** | 5 cm = 1968.5 mil |
| 设计规则 | mm | 1 mm ≈ 39.37 mil |

### 层 id（PCB）

| id | 层 | id | 层 |
|---:|---|---:|---|
| 1 | 顶层 | 2 | 底层 |
| 3 / 4 | 顶层/底层丝印 | 5 / 6 | 阻焊 |
| 7 / 8 | 锡膏 | 9 / 10 | 装配 |
| **11** | **板框（只能用 Polyline）** | 12 | 多层 |
| 13 | 文档层 | 15+ | 内层 |

### 区域规则类型（`pcb_PrimitiveRegion` 的 `ruleType`）

| 值 | 含义 |
|---:|---|
| 2 | 禁止元件 |
| 5 | 禁止布线 |
| 6 | 禁止填充 |
| 7 | 禁止覆铜 |
| 8 | 禁止内电层 |
| 9 | 约束区域（局部规则） |

### 常用快捷键（guideline §18.1，需按版本核对）

| 操作 | 键 |
|---|---|
| 重建铺铜 | **Shift+B**（CDP 注入下按不动，见纪律 6；实际用属性面板「重建铺铜区」） |
| 左/右/顶/底对齐 | Ctrl+Shift+L / R / O / B |
| 水平/垂直居中 | Ctrl+Shift+E / H |
| 对齐网格 | Ctrl+Shift+G |
| 走线时改参数 | Tab |
| 切换走线拐角 | Ctrl+Shift+Space |
| 新建工程 | Shift+N |

## 四、三条最容易踩的坑

1. **`create` 不等于产物**。铺铜只建框，要 `Shift+B`；导线要 `await w.done()` 才落盘；器件规则写回要 `overwriteNetRules(整表)`。
2. **多传参数会被拒**。`pcb_PrimitivePour.create` 只认 3 个参数；`pcb_PrimitiveLine.create` 是「起终点坐标」不是点数组。
3. **清空字段要用 `null`**。原理图元件改 `supplierId: ""` 无效，必须 `null`。

## 五、验证手段优先级

```text
1. 读图元数量/字段（最快、最硬）
2. 读 DRC 问题数组（check(false, true, true)）
3. 出纯画布图（Page.captureScreenshot 裁到 iframe.editframe；人看）
4. 整页截图（最后手段，会带入 UI 干扰）
```

`dmt_EditorControl.getCurrentRenderedAreaImage()` 在 4.1.78 上返回 `undefined`，
不要再用它出图（见 `notes/51`）。

## 六、现成脚本

| 脚本 | 用途 | 关键参数 |
|---|---|---|
| `scripts/check_environment.py` | 环境自检（CDP 端口、窗口、上下文、版本指纹） | `--json` `--expect-fingerprint` |
| **`scripts/board_check.py`** | **板子体检：图元统计、网络长度、DRC 分类+坐标、规则值** | `--title --json --drc-detail` |
| `scripts/uimap.py` | UI 地图扫描 / 菜单枚举 / 打开页面 | `scan` `menus` `entries` `open` `close` `diff` |
| `scripts/open_doc.py` | **切文档走 API**（`openDocument` + `activateDocument`），不点页签/工程树 | `list` / `active` / `open --name\|--uuid` |
| `scripts/diffpair_define.py` | 差分对定义 / 核对 / 删除（走 `pcb_Drc.createDifferentialPair`，回读门禁） | `--title --list --pair --delete --verify-ui` |
| `scripts/diffpair_route.py` | 差分对布线全链路（前置检查→框选→标定→焊盘断言+命中采样→点击链路断言→布线→端点校验→重建铺铜→DRC） | `--title --start-pad --start-xy --end-xy --nets --dry-run --no-frame --skip-probe` |
| `scripts/netclass_manage.py` | 网络类建类 / 加减网络 / 改名 / 删除 / 写类规则 | `--title --list --create --nets --add --remove --rename --delete --rule` |
| `scripts/aesthetics_check.py` | 美学校验（字高 / 旋转 / 同排对齐 / 过孔等距 / 位号方向 / 丝印压铜）+ 丝印层出图 | `--title --only --json --sheet out.png` |
| `scripts/eval_cdp.py` | 通用求值器，把任意 JS 丢进指定窗口 | `--expr` / `--api` / `--file` |
| `scripts/diag_ns.py` | 枚举 `_EXTAPI_ROOT_` 命名空间与原型链方法表 | `--ns pcb_SelectControl,pcb_Drc` |

`diffpair_route.py` 退出码：`0` 成功 / `2` 前置失败 / `3` 标定失败 / `4` 断言失败 / `5` 布线无产出。
