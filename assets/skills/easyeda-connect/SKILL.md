---
name: leonskill-easyeda-connect
description: "按 PCB Layout 规范在本机嘉立创EDA专业版上做板与审查：双通道自动选路（官方 API 优先、桌面视觉兜底），完成开工程、读板、设规则、禁布区、放件、布线、差分对、铺铜缝合、丝印、出图、规范审查与 Gerber/BOM 导出；每个动作产证据包与 DRC 前后快照。当用户说「按这份规范把这块板画出来」「照 guideline 把这板子做完，要能过 DRC」「帮我审查这块板合不合规范」「给我一份板子审查报告」「导出 Gerber 和 BOM」时使用。只做任务级编排，不负责界面结构探查与 CDP 通道维护；不做阻抗与载流计算；写操作前必须列明对象、影响与回滚并取得确认。"
version: 1.13.31
agent_created: true
---

# 嘉立创 EDA 双通道编排：按规范做板与审查

把 PCB Layout 规范变成可执行、可审查的动作序列：用官方 API 与桌面视觉两条通道操作本机嘉立创EDA专业版，从建工程一路做到制造文件，每一步都给证据。

## 适用范围

- 按规范从零做板：开工程、放件、设规则、禁布区、布线、差分对、铺铜缝合、丝印。
- 审查已有板子：读板、跑 DRC、按规范逐条断言、出图供人判断。
- 导出制造文件：Gerber、BOM、贴片、测试点。
- 每个动作按路由表选通道，首选失败才换次选，换不了如实降级。

不负责：界面结构探查、CDP 通道自身的维护与测绘（属 `leonskill-easyeda-cdp-connect`）；官方接口文档查询与扩展开发（属官方 easyeda-api 技能）；阻抗、PDN、载流与安规计算（外置计算器或人判断）。

## 用户会这样说

- 「按这份规范把这块板画出来」
- 「照 guideline 把这板子做完，要能过 DRC、能直接打样」
- 「帮我审查这块板，看合不合规范」
- 「这块板子布局布线合规范吗？给我一份审查报告」
- 「用官方接口把 Gerber 和 BOM 导出来」

这些说法不要接：只说「连一下我的立创EDA」「扫一下界面结构」「做个界面地图」时交给连接层技能；说「嘉立创EDA，启动！」时交给官方 easyeda-api 技能；问某个芯片资料时与本技能无关。

## 硬前提

1. 客户端为专业版 4.1.x。版本不符先停，不要凭经验操作。
2. 两条通道至少一条可用：官方 API 通道（bridge 服务 + 客户端扩展）或视觉通道（客户端带调试端口启动）。只有一条时按单通道执行，不反复尝试另一条。
3. Python 3.10 及以上，脚本只用标准库。

## 第零步：环境自检

```bash
python scripts/check_environment.py --json
```

按返回的 `channel_state` 走：

| channel_state | 含义 | 下一步 |
|---|---|---|
| `both` | 两条通道都在 | 直接进路由决策 |
| `bridge-only` | 只有官方 API 通道 | 跳过视觉类与差分对动词，其余按表执行 |
| `cdp-only` | 只有视觉通道 | 工程管理与制造导出降级，其余按表执行 |
| `none` | 都不可用 | 只给配置步骤，不做任何设计操作 |

探测结果缓存 60 秒；同一通道连续两次失败，本会话内不再尝试它。

## 第一步：查路由表

不知道去哪个文件找时先跑 `python scripts/lookup.py <关键词>`（跨九个来源一次检索，逐条带「文件 + 字段」出处；退出码 `1`＝零命中，别编），用法见 [references/routing.md](references/routing.md)。逐动词的优先序列读 `@references/capability-map.json`。

五条元规则：

1. 唯一通道可用时单路径执行，失败直接走该项的降级列，**不要自己发明第三条路**。
2. 两条通道都验证过时官方 API 优先，视觉通道作次选。
3. 只有一侧验证过时先用已验证侧；另一侧完成一次最小验证后重排，重排结果写回路由表。
4. 失败信号必须机器可判定：超时、退出码、返回结构缺字段、身份校验不符。禁止凭感觉切换。
5. 换路最多两层：首选、次选、降级声明。涉及用户的降级先说明再执行。

## 第二步：执行

**文档上下文前置门**：每个动词执行前确认当前文档类型与动词域一致（PCB 接口只在 PCB 文档下有效，原理图同理）。不一致先切文档；切不过去就停，不要硬调用——那会得到空结果或空指针，看起来像接口坏了。

读动词直接执行；写动词先过闸口（见下）。

动词层入口是 `scripts/eda_verbs.py`，所有动词共用一套参数（`--window` / `--out` / `--json` / `--confirm`）：

```bash
python scripts/eda_verbs.py list                 # 动词与路由状态
python scripts/eda_verbs.py read_board_state     # 读板面统计
python scripts/eda_verbs.py run_drc              # 跑 DRC，按类别分组
python scripts/eda_verbs.py canvas_image --fit         # 出图，自动挑 PCB 文档页面
python scripts/eda_verbs.py export_review        # 出审查报告
python scripts/eda_verbs.py manufacture_export --kind gerber --download

# 布局（内置求解器）：干跑 → 确认；可选退火精修
python scripts/eda_verbs.py plan_layout --anneal 800
python scripts/eda_verbs.py auto_place --confirm --clear-routing
python scripts/eda_verbs.py silk_annotate --text "REV A" --x 300 --y -260 --confirm
```

不加 `--confirm` 时，写动词只打印对象、影响与回滚，退出码 0，**不动任何数据**。加 `--confirm` 才执行，并把写前状态写进证据包。

底层通道入口：官方 API 用 `scripts/bridge_client.py`（`discover` / `health` / `windows` / `select` / `execute`）；视觉通道用连接层技能提供的脚本，按其接口契约调用。

## 第三步：验证

每个写动作执行完，按四件套回读：

1. **计数与字段**：图元数量、坐标、层、网络名，与预期逐项比对。
2. **DRC 增量**：改动前后各跑一次，比较新增与消失的问题。接口返回按问题类别分组（连接类、间距类、差分类等），门禁看类别与数量对比，写前写后各存一份进证据包。
3. **画布图**：需要人判断布局与美学时出纯画布图，标注层组合。
4. **版本指纹**：客户端与接口版本，写进证据包。

判定成功的依据是回读一致，不是「执行没报错」。回读不一致按该动词的换路链处理；换路后仍不一致，回滚并如实报告。

## 第四步：出报告

- **证据包**：每个动作一节，含命令、返回摘要、版本指纹、DRC 前后、画布图路径。原始接口输出不做脱敏，属调试管道，不要直接贴进公开材料。
- **审查报告**：按规范章节逐条给结论，标注证据类型（自动断言 / 几何计算 / 人工观察）与未覆盖项。未验证的写成「未验证」，不写成结论。
- **制造文件**：文件名含层与版本，导出后核对大小非零。

## 写操作闸口

执行前逐条说明并取得确认：

1. 对象：改哪些图元、哪条规则、哪层、哪个网络。
2. 影响：是否牵扯同网络对象、是否全局规则、预计新增段数与过孔数。
3. 回滚：改前的值（规则整表备份、图元坐标、铺铜框标识）与恢复步骤。

一次确认只对一次动作有效。绝对不做：保存或覆盖工程、删除工程、上传工程数据、替用户登录、读凭据、点下单类入口。

**闸口结论是返回字段，不是纪律。** `--confirm` 时每个写动词都会带回下面三个键，报告直接引用，不要自己复述：

| 字段 | 取值 | 怎么读 |
|---|---|---|
| `gate` | `checked` / `skipped:<reason>` / `exempt:recovery` / `exempt:read` / `unsupported:cdp-only` | `skipped` 是**没查成**，不等于通过 |
| `blockers_before` / `blockers_after` | `modal-form` / `modal-ack` / `history-preview` / `overlay-transient` | 非空即不可写；`after` 非空说明写完之后才弹框 |
| `verdict` | `verified-change` / `verified-noop` / `unverified` / `blocked` / `inconclusive` | `inconclusive` 是判不了，不许写成「无变化」 |

恢复类（`undo` / `rollback`）与读动词一律放行——否则「弹窗在场 → 写失败 → 回滚」会死锁。
逐条语义见 `references/ui-state-semantics.json`，现场取景用 `scripts/scene.py`。

### 临时板：`createPcb()` 返回 id ≠ 文档已切过去

`dmt_Pcb.createPcb()` 拿到 id 只说明板建出来了，**不说明 `openDocument(id)` 生效**。
2026-11-10 实测过这个坑：一个探针以为自己在临时板上作业（读到的却是原板的
`strings=3 / pads=12 / vias=39 / components=6`），最后把**原板**留在了 4 层 + 内电层状态。

写临时板前必须三件事齐全，缺一不许开写：

1. `openDocument(id)` 之后**回读** `dmt_EditorControl.getSplitScreenTree().tabs`，确认目标 id 是活动页签；
2. 读一次「新板应有」的计数（空板 = 0 焊盘 / 0 器件），**与预期不符就是没切过去**；
3. 收尾 `deletePcb(id)` 后回读 `getAllPcbsInfo()` 与基线四项，逐项对回。

判断「板没了」也只看 `getAllPcbsInfo()`——页面重载会让临时板直接消失，
`deletePcb` 这时返回 `false`，但那不代表失败。

## 弹窗与浮层（预期 → 检测 → 处置）

弹窗不是偶发噪声，是**会吞掉结果的一等公民**：它替操作保管失败原因，也替操作保管「还没生效」这件事。
浮层（右键菜单 / tooltip / 下拉）不阻塞接口，但会**吃掉坐标**——同一个坐标点下去落到别的元素上。
处置口径在 `references/dialog-taxonomy.json`，工具是 `scripts/dialogs.py`；一次看全用 `scripts/scene.py`。

### 1. 先有预期

| 操作 | 预期（taxonomy id） | 现象 |
|---|---|---|
| `importChanges`、工具 - 导入变更 | `confirm-import-changes` | 变更表，按钮 导出报告 / 应用修改 / 取消 |
| 同上，但原理图与 PCB 不在同一板下 | `pick-schematic-for-import` | 标题写「错误」，正文是一道选择题 |
| `importProjectByProjectFile`、文件 - 导入 | `ack-error` | 「导入失败！文件格式错误!」，底部日志另有一句更具体的 |
| 导出类（3D 外壳等） | `ack-error` | 「导出失败，未发现3D外壳图元…」 |
| 跨工程 `openProject` | `save-changes` | 保存 / 不保存 / 取消，三个按钮都会改状态 |
| 任何走界面路径的写 | 未登记 → `unknown` | 按 `never-auto` 处理 |

通用规律：凡「应用 / 导入 / 变更 / 生成 / 导出」这类会把结果落到设计或文件上的入口，默认按「会弹框」准备；纯读接口实测不弹。

### 2. 三个动作

```bash
python scripts/dialogs.py --list --classify      # 现在有什么框、属于哪类
python scripts/dialogs.py --watch 8 --auto-ack   # 长操作期间盯 8 秒，回执类当场点掉
python scripts/scene.py --guard                  # 一次看全：模态 / 浮层 / 图层 / 选区
```

**`--watch` 不是可选装饰**：`importChanges` 实测 2.75 s 返回 `true`，弹窗在返回之后才渲染，单点检查必然漏。

### 3. 谁能用缺省值点

| 分类 | 默认动作 | 说明 |
|---|---|---|
| `ack-error` | `dismiss` | 先读正文（那就是失败原因），再点 |
| `confirm-import-changes` | `cancel` | `--dismiss` 会拒绝；要应用必须显式 `--button 应用修改` |
| `pick-schematic-for-import` / `save-changes` | `never-auto` | 改工程结构或替用户决定存/丢，只能 `--cancel` 或显式 `--button` |
| 未登记 | `never-auto` | 先 `--list` 再决定 |

`--cancel` 是最安全的退路；`--button` 是越权通道，只有用户明确要求才用，用完必须在报告里写明点了哪个。
判据不止看按钮文案：框里**有控件**（输入框 / 表格 / 复选框 / 列表项）就一律不是回执。

### 4. 三条实测硬事实

1. **回执类不阻塞 bridge**（连跑 34 次，25–68 ms 全部正常）；**表单类会顶到 30 s 服务端上限**（`--timeout` 传更大无效）。所以「有弹窗就超时」与「有弹窗也不影响」都不成立。
2. **`importChanges` 返回 `true` 不等于生效**：`true` 只表示请求已受理，落盘要等「应用修改」被点。拿返回值判成功会写出假绿报告。
3. **标题「错误」不代表可以点**：实测撞到一个标题「错误」、按钮「确认/取消」的框，正文是原理图选择列表。故判据取「结构优先」——控件比按钮文案可靠。

### 5. 收尾

- 每个写动词跑完，报告里回答一句：**「这次有没有弹窗？弹了什么？怎么处置的？」** 没有也要写「无」。
- 留着的框会挡住后续界面路径操作；收工前跑 `python scripts/scene.py --guard`（有阻塞 exit 3），确认为 0。
- 误点了应用类按钮：立刻用 `details_hash` 复读比基线，变了按《写操作闸口》回滚，并写明点了哪个按钮。

## 依赖与降级

配置与撤销步骤见 [references/setup-guide.md](references/setup-guide.md)。

| 缺失项 | 立即影响 | 仍可做 |
|---|---|---|
| 官方 API 通道 | 工程管理、制造导出不可用；自动布线改走视觉通道 | 读板、DRC、规则、区域、铺铜、丝印、差分对、出图 |
| 视觉通道 | 无视觉回路；差分对与重建灌注不可用 | 开工程、读板、DRC、规则、区域、布线、铺铜建框、丝印、导出 |
| 两者都缺 | 无法操作客户端 | 只输出配置步骤 |

## 实现面与不支持清单（先看这节，再看速查）

台账（`references/capability-map.json`）登记的是「这项能力存在、且验到什么程度」，**不等于「能一条命令跑」**。三个面分开看：

| 面 | 怎么查 | 覆盖 |
|---|---|---|
| 知识台账 | JSON 的 `verbs` 数组 | 全部登记项 |
| 可执行面 | `python scripts/eda_verbs.py list` 里 `implemented: true` | 二十余个（= `IMPLEMENTATIONS` ∪ `layout_verbs.HANDLERS`，唯一真值源是命令输出） |
| 接口文档索引 | `python scripts/lookup.py <词> --kind api` | **只覆盖 `pcb_` / `ipcb_`**；工程、文件、历史模块查不到 |

**`implemented: false` 不代表接口坏了，代表本层没有实现**：要跑只能走
`python scripts/bridge_client.py execute --code '<表达式>'` 手写表达式，再按该 verb 的 `verification` 与 `verify` 手工判定；直接 `python scripts/eda_verbs.py <verb>` 会以 exit 3「未实现的动词」退出。
`route_diffpair` / `place_component_sch` 有子命令但只打印「由别处承担」，故同样是 `false`；`export_review` 是审查报告入口，不在台账。

`tests/test_verb_surface.py` 钉住三件事：`list` 每项都带 `implemented`、可执行集合等于那两张表、每个可执行项都有 argparse 子命令。

### 只能走界面、不要承诺自动化的能力

| 能力 | 结论 | 界面入口 | 依据 |
|---|---|---|---|
| 工程版本控制（分支/节点/版本树） | **不支持** | 文件 - 版本控制；工作区 - 工程 - 版本 | `dmt_Project` 真实方法表 14 个，无一项版本/分支/节点；`cn/project/file-version-control.md` 只有界面说明 |
| 云端备份（自动 10 / 手动 15） | **不支持** | 文件 - 创建版本 / 切换版本 | 同上；「切换版本」以新建工程实现 |
| 工程历史（查看/还原/对比） | **不支持** | 文件 - 工程历史 | 只有界面说明；本技能唯一相关实现是「历史预览态禁写」护栏 |
| 叠层结构 / 介质厚度 / 阻抗 | **不支持** | 右侧图层-叠层面板 | 叠层族 10 个方法全不可用：5 个写桩返回 `false`、4 个空体读桩返回 `undefined`、1 个列举接口返回空数组；只有层数与板材类型可写 |
| 内电层重建 / 平面分割 | **不支持** | 图层属性里手工重建灌注 | 全仓零实现（没有平面层重建接口；`pour_rebuild` 是铺铜不是平面层） |
| 内层切成内电层（PLANE） | **支持**（需先有板框） | — | `set_board_stackup --plane-layers 15`；宿主 `PP.modifyLayer` 的 `CanRemoveLayers` 门要求「目标层空」且「layer 11 非空」，无板框返回 `blocked=missing_board_outline` |
| 丝印层画直线（`PrimitiveLine`） | **不支持** | 画线工具（UI 走的是别的图元） | `pcb_PrimitiveLine.create` 在 layer 3/4 对所有参数组合恒报「无法创建直线图元」，同参数在铜层成功；文档 `TPCB_LayersOfLine` 却列了 `TOP_SILKSCREEN` ⇒ 文档与实际不符。替代：`pcb_PrimitivePolyline.create('', 3, createPolygon([x,y,'L',x2,y2]), width, false)` |
| 文字宽度/包围盒（读） | **不支持** | — | `ipcb_primitivestring` 34 个方法里没有 bbox/width/bound，只有 `fontSize`/`lineWidth` 这类样式字段；`silk_metrics` 的 0.58em 只能靠截图标定（见 CHANGELOG 1.13.9） |
| 库文档历史记录 | **不支持** | 库编辑器 - 文件 - 历史记录 | 接口层无方法 |

**版本控制与工程历史是两条死路**：官方有完整界面，但接口表面没有任何版本/分支/节点/备份入口（`copyProject` 空体、`deleteProject` 是 `return!1`）。遇到「帮我建个版本」「回到上周那版」，直接给上表入口、让用户点，**不要试 API**。

### 看起来能做、其实不能做的四件事

1. **删除工程**：`dmt_Project.deleteProject` 是 `deleteProject(t){return!1}` 硬编码桩，建了删不掉（实测残留 `B6_PROBE_42139436`，登记在 `scripts/audit_residue.py` 的 `KNOWN_RESIDUE`）⇒ 新建工程属不可逆操作。
2. **`saveFile` 落盘**：返回 `Promise<void>`，「没报错」不等于落盘。2026-11-09 复核：`existsPathInFileSystem(uri)` 对 12 种路径恒返回 `false`（连确实存在的系统目录也是），`saveFileToFileSystem(uri,blob,name)` 返回 `{error:"路径不允许"}`（与归档写的 `Promise<boolean>` 不符），磁盘无文件 ⇒ 外部交互权限/路径白名单未开，落盘不可判，只能保持 `unverified` 或由用户目视确认。
3. **叠层面板的「另存为默认 / 覆写」**：即使点得动也不可撤，且本机读不回来，无法验证。
4. **盲埋孔规则项创建**：唯一入口 `pcb_Drc.overwriteCurrentRuleConfiguration` 是全量覆写、schema 未知，写错就是整表规则丢失——不要拿它「顺便建一条」。

## 动词速查

| 想做的事 | 动词 | 首选通道 | 无次选时 |
|---|---|---|---|
| 按名称开工程 | `open_project` | 官方 API | 请用户手动打开 |
| 读板状态 | `read_board_state` | 官方 API | 视觉通道体检脚本 |
| 跑 DRC | `run_drc` | 官方 API | 视觉通道同名接口 |
| 出画布图 | `canvas_image` | 视觉通道 | 请用户截图 |
| 放元件 | `place_component` | 官方 API | 视觉通道落位 |
| 写设计规则 | `apply_design_rules` | 视觉通道 | 官方 API |
| 改画布自由文本 | `modify_pcb_string` | 官方 API | 双击文本在属性面板改 |
| 改铜箔层数 | `set_board_stackup` | 官方 API | 图层管理器 |
| 读层表/铜层数 | `read_layer_stackup` | 官方 API | 图层管理器 |
| 锁层/解锁 | `lock_layer` | 官方 API | 图层面板锁图标 |
| 改图层配色/透明度 | `configure_layer_appearance` | 官方 API | 图层管理器 |
| 新建自定义层 | `add_custom_layer` | 官方 API | 图层管理器 |
| 切换活动层 | `select_active_layer` | 官方 API | 图层面板点选 |
| 导出工程/文档文件 | `export_project_file` | 官方 API | 文件 - 导出 |
| 读文档源码/库清单 | `read_document_content` | 官方 API | 无次选 |
| 放禁止区 | `add_keepout` | 视觉通道 | 官方 API |
| 自动布线 | `route_net` | 官方 API | 视觉通道 |
| 差分对 | `route_diffpair` | 视觉通道（连接层脚本承担） | 无，报告退出码 |
| 建铺铜与缝合孔 | `pour_create` | 官方 API | 视觉通道 |
| 重建灌注 | `pour_rebuild` | 视觉通道 | 请用户手动重建 |
| 丝印文字 | `silk_annotate` | 官方 API | 视觉通道 |
| 美学检查 | `aesthetic_lint` | 视觉通道 | 官方 API 读图元后自查 |
| 视觉审查材料 | `render_review` | `canvas_image` 出图加人工确认 | 请用户截图 |
| 制造导出 | `manufacture_export` | 官方 API | 给出菜单路径 |
| 分云 | `cluster_components` | 本机计算 | 无网表时按锚点归属 |
| 布局计划 | `plan_layout` | 本机计算 | 无次选 |
| 差分对走廊 | `plan_layout --pair-corridors` | 本机计算（盒到线段距离判定） | 无次选 |
| 自动布局 | `auto_place` | 官方 API 批量写回 | 干跑表交人工 |
| 位号布局 | `place_designators` | 本机计算排版 | 写回接口待探明 |
| EDA 内置布局 | `eda_builtin_place` | `--via api|bus|menu|auto`（默认 auto 依次降级）：api=官方接口（有返回值，主路径）/ bus=`publish('pcb/autoLayout')`（只依赖 CDP、无返回值、靠几何判定）/ menu=点布局菜单 | 视觉通道「布局」菜单（位号布局仍只能走它，且要点「运行」） |
| 对齐/分布 | `align_components` | 本机计算 + 批量导入 | 干跑表交人工 |
| 布局+布线闭环 | `relayout_route` | 本机计算 + 批量导入 + 自动布线 | 分段手工执行 |
| 外部布线 | `route_external` | DSN 导出 + FreeRouting CLI + SES 导入 | 内置布线 |
| 铺铜重建 | （管线内置） | 选中铺铜 → 「重建铺铜区」→ 等灌注 | 手动重建 |
| 撤销 | `undo` | 命令总线 `MSG_BUS_PCB.publish('undo')` | Ctrl+Z（键盘）/ 按证据包回滚 |
| 菜单树（脚本 menu_tree.py） | `menu_tree` | 视觉通道 DOM | 无（一次性只读） |
| 调用链跟踪 | `rpc_trace.py`（工具脚本，非 verb，不在路由表） | 视觉通道 RPC 钩子 | 无 |
| 布局回滚 | `rollback` | 批量导入基线 / 逐件恢复 | 无次选 |
| 列出全部工程（只读） | `list_projects` | 官方 API | 无次选 |
| 导出 Altium 工程包 | `export_altium` | 官方 API | 无次选 |
| 定义差分对（只配对，不布线） | `define_diffpair` | 官方 API | 无次选 |
| 整表覆写设计规则 | `write_rule_table` | 官方 API | 无次选 |
| 原理图放元件并精确定位 | `place_component_sch` | 官方 API | 视觉通道落位 + 坐标精修 |
| 导入外部 EDA 工程文件 | `import_project_file` | 官方 API | 给「开始页 - 导入其他」路径，用户手动导入 |
| 导出 DSN（喂外部布线器） | `export_dsn` | 官方 API | 给出菜单路径 |
| 按层显隐画布 | `filter_layer_visibility` | 官方 API | 给出菜单路径 |
| 原理图放圆弧 | `place_sch_arc` | 官方 API | 给出菜单路径 |
| 原理图放内嵌图像 | `place_sch_image` | 官方 API | 给出菜单路径 |
| 管理复用模块（CBB） | `manage_cbb` | 官方 API | 给出菜单路径 |
| 开关底部库面板 | `toggle_lib_panel` | 官方 API | 给出菜单路径 |
| 只导 Gerber 压缩包 | `export_gerber` | 官方 API | 无次选 |
| 原理图放 CBB 实例 | `place_cbb_instance` | 官方 API | 无次选 |
| 新建面板库（库对象） | `create_panel_lib` | 官方 API | 无次选 |
| 放置/修改尺寸标注 | `annotate_dimension` | 官方 API | 给出菜单路径 |
| 新建面板文档 | `create_panel_file` | 官方 API | 给出菜单路径 |
| 单位换算（inch↔mm 等） | `switch_unit` | 官方 API | 无次选（显示单位切换无 API） |
| 多边形并/交/差/异或 | `boolean_polygon_op` | 官方 API（只算几何） | 写回另调图元接口 |
| 算多边形/铜箔面积 | `measure_polygon_area` | 官方 API | 无次选 |
| 取库句柄（libraryUuid） | `resolve_library_uuid` | 官方 API | 无次选 |
| 原理图按图元 ID 建选区 | `select_sch_primitives` | 官方 API | 无次选 |
| 原理图交叉选择（按位号/引脚/网络） | `cross_probe_select` | 官方 API | 无次选 |
| 列出工程内全部 PCB 文档 | `list_pcbs` | 官方 API | 无次选 |
| 新建 PCB 文档 | `create_pcb_doc` | 官方 API | 无次选（只能不传参；传 `boardName` 静默失败） |
| 开关左右/底部面板并切标签页 | `toggle_side_panel` | 官方 API | 给出菜单路径 |

本表是**常用动词的摘要**，不是完整动词表：完整清单以 `references/capability-map.json` 的
`verbs` 数组为准（`python scripts/eda_verbs.py list` 同源）；非 `verified` 的完整清单见下节机器
生成的表。**本表不写死条数**——动词批次还在增加，写死会让它每批都过期一次。

**未验证动词（declared / partial / single-path，勿直接调用）**：下表由脚本从
`references/capability-map.json` 现算生成——**清单与数量以该文件的 `verbs` 数组为准，本文不写死**
（写死会让并发新增或升级动词后本表立刻过期；本节手写版就整表过期过一次，故改为机器生成）。

**门禁含义**：`status` 不是 `verified` 的动词**不得进入执行路径**。`scripts/validate_output.py`
把**一切非 verified** 动词进 `steps[].realizes` 判为违规（早期只挡 `partial`，已收严）；唯一放行
方式是把 id 显式写进 `--allow-unverified` 或环境变量 `ALLOW_UNVERIFIED_VERBS`，且结论里必须如实
写「未验证」。三档的区别是**缺证据的形式不同**，不是「能调/不能调」：

- `declared`：只到接口/声明级（方法存在、签名接受），未在真实板子上执行过。
- `partial`：某通道或某子功能跑通过，其余未验证。
- `single-path`：通道受限——只有一条界面路径，且这条路径也没做过端到端回归。

改本表**不要手改**：跑 `python scripts/sync_skill_verb_table.py`，再用 `--check` 验是否最新
（`--check` 不一致会打印 diff 并 exit 1，可直接当门禁用）。

<!-- BEGIN:declared-verbs（由 scripts/sync_skill_verb_table.py 生成，勿手改） -->
| 想做的事 | 动词 | status | 首选通道 | 说明 |
|---|---|---|---|---|
| 放置/修改尺寸标注图元 | `annotate_dimension` | `declared` | 官方 API（bridge） | 接口级（2026-11-08 分诊）：归档 pro-api.pcb_primit… |
| 把 PCB 侧的变更（位号重排、器件替换）反向导入原理图，保… | `import_pcb_changes_to_sch` | `declared` | 官方 API（bridge） | 本机未实测（blocked_by_risk）。这条改的是原理图↔PCB 一致性状… |
| 按 BOM 走元件下单检查（静默或交互），通过后打开立创商城… | `order_components_bom` | `declared` | 官方 API（bridge） | 故意未实测：该接口会真实生成下单资料并打开立创商城下单页（外部副作用，误触会在账… |
| 仅做单位换算（inch↔mm 等），不含编辑器显示单位的切换 | `switch_unit` | `declared` | 官方 API（bridge） | 边界：显示单位切换只有 UI 偏好（98 命名空间全扫，仅 sys_Unit 换… |
| 把客户端切到指定工作区（不传 uuid 即切到个人工作区） | `switch_workspace` | `declared` | 官方 API（bridge） | 未实测（有意跳过）：切工作区会把整窗上下文（活动工程/文档/选区）整体切走，并行… |
| 按规范检查丝印字号区间、旋转方向、文字压焊盘/压过孔/出板框… | `aesthetic_lint` | `partial` | 视觉通道（cdp） | 判据 2026-11-10 变更：主判据是**包围盒相交**（text-over… |
| 对两个铜箔/区域多边形做并、交、差、异或，拿到结果多边形组 | `boolean_polygon_op` | `partial` | 官方 API（bridge） | 只算几何，写回要另调图元接口（本批未验证，别当已通）。实测只对「包含/相离」类用… |
| 对比两份设计：网表对比（元件/网络差异）、PCB 对比（图元… | `compare_designs` | `partial` | 官方 API（bridge） | 缺口：schematicComparison 只跑通「同一张图被拒」这一支，正向… |
| 把 Altium Designer 库文件（.SchLib/… | `convert_altium_lib_to_easyeda` | `partial` | 官方 API（bridge） | 缺口：本机**没有真实的 .SchLib 样本**，真库转换未验。已确认的坑：该… |
| 在个人库新建 Ngspice 仿真模型（.model 语句或… | `create_lib_simulation_model` | `partial` | 官方 API（bridge） | 无回读通道：lib_SimulationModel.get() 在本机抛『错误：… |
| 读 / 改 PCB 器件实例的位号、关联库封装、坐标 X、所… | `edit_pcb_component_props` | `partial` | 官方 API（bridge） | 两条缺口 + 一条口径：(1) setState_OtherProperty 只… |
| 把系统库/团队库里的某个器件或复用模块（CBB）导出成 el… | `export_lib_item_file` | `partial` | 官方 API（bridge） | 缺口：复用模块分支在本机被权限挡住（lib_Cbb.search() 能列出 C… |
| 把同 Board 下原理图的改动（新增/删除器件、网络、位号… | `import_sch_changes_to_pcb` | `partial` | 官方 API（bridge） | 三条缺口实测：① 首次 importChanges() 返回 true 但 PC… |
| 初始化 PCB 光线追踪渲染引擎，为 3D 光追预览/出图做… | `init_raytracer_engine` | `partial` | 官方 API（bridge） | 缺口（本机不可用/不可同步等待）：init() 30 s 内未 resolve，… |
| 在个人库检索/复制/改名 3D 模型，并（理论上）导入 ST… | `manage_lib_3d_model` | `partial` | 官方 API（bridge） | 本机 V4.1.78 上 lib_3DModel.create 是静默失败：ST… |
| 在器件库里新建符号、改名/改属性、复制符号、在符号编辑器里打… | `manage_lib_symbol` | `partial` | 官方 API（bridge） | 三个坑：① copy 对「刚 create 的空符号」返回 undefined … |
| 把当前 PCB 导出成制造与交换文件：DXF、3D 模型/3… | `manufacture_export` | `partial` | 官方 API（bridge） | 与 `export_gerber` 的分工：Gerber 压缩包由那条 verb… |
| 把工程移动到工作区里的文件夹（或用 undefined 移回… | `move_project_to_folder` | `partial` | 官方 API（bridge） | 缺口：只跑通「跨空间」这一种（个人空间工程 → 团队工作区文件夹），返回 tru… |
| 把 PCB 画布视口定位到指定数据坐标，或缩放到板框（截图 … | `navigate_pcb_view` | `partial` | 官方 API（bridge） | 缺口已补（2026-11-10）：`dmt_EditorControl.getC… |
| 把库器件/封装绑到鼠标游标，交给用户点击落位（半自动放置的交… | `place_pcb_item_with_mouse` | `partial` | 官方 API（bridge） | 只实测了失败分支，成功分支故意没跑：一旦绑定成功，器件跟着鼠标走，必须人工点击或… |
| 查某个矩形区域内的 PCB 图元（框选范围的程序化版本），用… | `query_pcb_primitives_in_region` | `partial` | 官方 API（bridge） | **真实板面上会抛错（2026-11-09 独立复核）**：原证据只在一张「2 … |
| 读取当前 PCB 的图层表与铜箔层数（判断几层板、内层是否启… | `read_layer_stackup` | `partial` | 官方 API（bridge） | **2026-11-13 结论（离线支路可读叠层，6 层已对上）**：离线 --… |
| 把内存里的 Blob/File（BOM 表、CSV、导出包）… | `save_file_to_disk` | `partial` | 官方 API（CLI invoke） | **2026-11-12 结论（CLI 通道已能落盘）**：CLI `--ext… |
| 把某个图层设为当前编辑层（后续布线/放置落在该层） | `select_active_layer` | `partial` | 官方 API（bridge） | 缺口：没有可用的回读信号——getCurrentLayer() 恒 undefi… |
| 把备份 / 外部准备好的网表推回 PCB（「更新网表」，等价… | `set_pcb_netlist` | `partial` | 官方 API（bridge） | 三条缺口：(1) 返回值 true 不代表网表有效 —— 传 NOT_A_NET… |
| 控制画布视口：缩放到指定坐标/区域、适应全部图元、适应选中图… | `zoom_canvas` | `partial` | 官方 API（bridge） | 缺口/坑：① zoomTo 必须同时给 x、y、scaleRatio，缺 sca… |
| 重建灌注，让铺铜生成实际铜皮 | `pour_rebuild` | `single-path` | 视觉通道（cdp） | **2026-11-10 真机：可用，且已走命令总线（不是模拟按键）。** 首选… |
| 开/关实时 DRC 校验，并读取当前是否处于实时校验状态 | `toggle_realtime_drc` | `single-path` | 官方 API（bridge） | 缺口：三个接口都在实时方法表里（kind=function）但恒返回 false… |
<!-- END:declared-verbs -->

`menu_tree` 是路由表里的 verb（本表按 `menu_tree` 记，脚本文件叫 `menu_tree.py`）；
`rpc_trace.py` 是连接层的**工具脚本，非 verb**，不在 `capability-map.json` 的 `verbs` 里，也不补进去。

## 通道策略：RPC 优先

按「坐标点击不可信、UI 状态有暗坑」的教训，操作尽量落在 RPC。当前边界：

| 类别 | 动词 | 通道 | 说明 |
|---|---|---|---|
| 已是 RPC | `open_project`、`read_board_state`、`run_drc`、`place_component`、`route_net`、`pour_create`、`silk_annotate`、`aesthetic_lint`、`manufacture_export`、`auto_place`、`place_designators`、`align_components`、`relayout_route`、`route_external`（DSN/SES 也是 RPC）、`rollback` | 官方 API | 布局写回走「导入布局 JSON」一次原子应用 |
| 只读 CDP（安全保留） | `canvas_image`、`menu_tree`；另有连接层工具脚本 `rpc_trace.py`、`state_check.py`（**脚本，非 verb**） | CDP | 不发点击、不碰状态；截图本身无 RPC 替代 |
| 仍需 UI | `place_designators --builtin`、`eda_builtin_place --designator`（同一个「布局 → 自动位号布局...」菜单项；不加 `--run` 只到表单对话框，加了才代点「运行」并按位号坐标确认真的动了；透传主题试过 7 种载荷/总线组合都不弹框）、`pour_rebuild`（铺铜多边形不可读，RPC 重建不可行） | 菜单 | 元件布局已走 `pcb_Document.autoLayout()`（锁定件算跳过不算失败）；`undo` 已走命令总线，键盘只是回退 |
本表只按**通道归属**归类，不重复判状态；某动词验没验过一律看 `capability-map.json` 的
`status`（非 verified 的清单见上节机器生成的表）。这里原先还有一行「未验证 | apply_design_rules /
add_keepout / pour_rebuild / route_diffpair」，已删除：JSON 里前三条与 `route_diffpair` 都已是
`verified`，`pour_rebuild` 是 `single-path`（通道受限，不是没验）——同一事实存在两处副本时，
两处会各自漂移。

**命令面（`references/ui-command-surface.json`）**：顶部菜单/工具栏的每个命令最后都汇进客户端自己的一个
`switch` 分发器，每个 `case` 只做三件事之一 —— `publish("<主题>", 载荷)`、`publish(t, 载荷)`（主题 = 命令 id
本身）、或 `rpcCall("<方法>", 载荷)`。这张表把 266 个命令 id 的落点全抽出来了，用它可以把「点菜单」换成
「发一条总线消息」：`undo` 就是这么从 Ctrl+Z 改成 `publish('undo','')` 的（零键鼠，2026-11-10 真机）。
查法 `python scripts/lookup.py undo --kind cmd`。

- 总线取 **iframe 里那份**：`document.querySelector('iframe.editframe').contentWindow.MSG_BUS_PCB`。
  顶层同名对象没有订阅者，往那儿发是静默无效。
- rpcCall 走 **iframe 里那条**：`document.querySelector('iframe.editframe').contentWindow` 的 `MSG_BUS_PCB.messageBus.rpcCall(方法, 载荷)`。真机（2026-11-10）`getCanvasParam` / `getGridRange` / `getDifferentailOptions` 都有真实应答；顶层 `chameleon_bus_*` 是**另一条**总线，往上发没有 PCB 侧订阅者（早前把它当 rpc 通道是错的）。`save` 是例外：20 s 无应答且会把整条 `Runtime.evaluate` 拖死，`file_save` 的 **rpc 入口**至今没有真机证据。
  但**扩展 API** `pcb_Document.save()` 真机可用（2026-11-10：20–35 ms 返回 `true`；写一条丝印文本 → save → 重载页面，探针仍在且 primitiveId 不变；删掉再 save → 重载后确实没了）。两条不是一回事，别拿 API 的结果去给 rpc 行背书。**本 skill 不代做保存**（「写操作闸口」的绝对不做）：要落盘请用户自己在客户端按 Ctrl+S。记这条只为两件事——别把「rpc 不通」误当成「没法保存」，以及排查「改完重载就丢」时知道该看哪个接口。
- **整表 static-only**：只证明「代码这么写」，不证明「真机能跑」；要写板面的命令先在演练板验。

**禁令**：不要用坐标发 `Input.dispatchMouseEvent`——曾误点窗口关闭按钮弹出退出确认。
需要点 UI 时只用「React props 文本定位点击」（`menu_click` 的做法），且先截图看一眼再动手。

## 标准操作：自动布局与位号

一条可照抄的完整链路。全程先干跑、看指标、再确认，任何一步异常都能从上一步回滚。

```bash
# 0) 自检与目标确认：PCB 文档、元件数、网络数、DRC 基线
python scripts/check_environment.py --json
python scripts/eda_verbs.py read_board_state --json
python scripts/eda_verbs.py run_drc --json

# 1) 分云：看云数与云心是否合理（单云通常意味着网表把全板串起来了）
python scripts/eda_verbs.py cluster_components --json

# 2) 布局干跑：不写板，只看指标与预览
python scripts/eda_verbs.py plan_layout --iterations 80 --anneal 600 --json

# 3) 确认写入：需要重布时加 --clear-routing，否则保留原走线（会大面积断开）
python scripts/eda_verbs.py auto_place --iterations 80 --anneal 600 --confirm

# 4) 位号：先干跑看统计，再写回
python scripts/eda_verbs.py place_designators --json
python scripts/eda_verbs.py place_designators --confirm

# 5) 出图复核：先缩放到板框，避免缩放造成误判；有对话框先关掉
python scripts/eda_verbs.py canvas_image --fit --image out/layout-check.png

# 6) 不满意就回滚：先位号、后元件（反序会让位号相对偏移漂移）
python scripts/eda_verbs.py rollback --from out/place_designators-<时间戳> --confirm
python scripts/eda_verbs.py rollback --from out/auto_place-<时间戳> --confirm
```

**看哪几个指标**（`plan_layout` 的 metrics）：

| 指标 | 合格线 | 不达标怎么办 |
|---|---|---|
| `overlaps` | 0；密集板至少小于 `overlaps_before` | 加迭代、放宽 `legalize_max`、检查是否有硬锁件挡路 |
| `utilization` | 0.2–0.5（板越小越偏高） | 调 `target_utilization`；已接近 1 的板不会被强行铺开 |
| `hpwl` | 明显低于 `hpwl_before` | 开退火；或降低 `cross_cloud_weight` 让云更独立 |
| `clouds` / `centers` | 云数与功能区块数相当 | 只有一云时检查电源网络权重与锚点前缀 |
| `anneal.cost_best` | 不高于 `cost_before` | 加迭代或提高初始温度 |

**参数调优速查**：`target_utilization`（默认 0.5，控制铺开程度）、`anneal_iters`
（默认 1500，20 件以内 600 已够）、`k_gravity`（云内聚拢）、`cross_cloud_weight`
（默认 0.08，越小云间越独立）、`k_anchor`（默认 0.04，越大越贴近原位）。

**差分对走廊**（`--pair-halo` / `--pair-corridors`，默认关闭）：

```bash
python scripts/placement.py --board-json board.json --json \
  --pair-halo 2.5 --pair-corridors '[{"a":"U1","b":"USB3"},{"a":"U1","b":"USB4","width":3.0}]'
```

- 走廊 = 锚点对中心线外扩 `width/2` 的胶囊；`width` 缺省取 `--pair-halo`，`0` 表示只查间距不设禁入区。
  锚点对从哪来：连接层 `pair_anchors.py`（`_P/_N` → 每条网络焊盘最多的两个元件）。
- 两条约束：① 锚点对边缘净距 ≥ `max(gap, width)`；② 第三方元件到中线的距离 ≥ `width/2`。
  判定用「元件盒到线段的最小距离」，**不是**轴对齐矩形（斜向矩形会把禁入区放大 3~5 倍）。
- 结果里的 `pair_constraints`：`{enabled, corridors, moves, violations}`。`violations` 非空即
  `ok=false`——soft 锁件被夹在 `_origin ± soft_delta` 内仍进/出不去时，会写进 `violations`
  （`reason` 为「软锁元件无法退出走廊」/「软锁元件无法拉开到走廊宽度」）而不是静默放过。
  这条承诺无条件成立：走廊推离/拉开、`legalize` 接受落点、退火（`--anneal`，默认关闭）收尾
  都会把 soft 件夹回 `_origin ± soft_delta`（退火夹紧件数见 `anneal.soft_clamped`）。
  `violations` 有数值容差 `max(0.005, 尺度×1e-3)`，0.6 µm 级收敛误差不算违规；
  走廊模式下 `legalize` 单次调用有 12 万探针工作量上限，撞线时 `legalize.search_truncated=true`。
- 不传这两个参数时，求解结果与未加该特性的版本**逐字段一致**。

**修差分对 skew：走廊补丁 + 外科式增量布线**（usb_hub 实测 D 对 319.6 → **7.1 µm**，其余四对逐项不变）

> ⚠ **这两个数字的历史性质（2026-11-03 补注）**：cdp **2.18.0 之前**所有 skew 数值都来自
> `fastroute --multi-start=4`（**打乱顺序跑 4 遍取最好**），是**随机过程的单次抽样**，
> 不是确定性目标。所以 7.1 µm 是「best-of-4 抽到的好签」，不能当作 `--multi-start 1` 下的
> 预期值或验收线；基线必须在 `multi-start=1` 下**重新确立**。

```bash
python scripts/eda_verbs.py relayout_route --corridor-patch \
  --pair-corridors '[{"a":"USB1","b":"U1","width":2.5}]' \
  --incremental --router fastroute --pair-tol-um 100 --max-rounds 3 --confirm --json
# 撕网粒度：默认 --rip-mode surgical（外科）；要复现 P3 的整网撕用 --rip-mode whole
```

关键做法与四个实测坑：

1. **只挪挡路件，不要整体重解**。`--force-layout` 会把整板压紧（HPWL 628→245），引脚挤进 1/4 板面
   → 18 条未布通、DRC 209，走廊红利被吃光。`--corridor-patch` 只动 1 件（C1），其余 17 件坐标不变。
2. **撕网范围决定成败**。撕整网（GND 43 段 + VCC33 3 段 + D 对 28 段 = 74 段）：DRC 11、2 条未布通、
   skew 83.5 µm；只撕「端点落在被挪焊盘附近的走线 + 目标对」（41 段）：**skew 7.1 µm、其余对零扰动**
   （同上：这两个数都是 best-of-4 单次抽样；`--multi-start 1` 下重测可能更好也可能更差）。
   撕得越少，布线器要重建的上下文越少，结果越好——与直觉相反。这条已代码化为
   `--rip-mode surgical`（默认）：集合 = 目标对全部线段 ∪ 被挪件网「端点落在焊盘 1.5 mm 内」的线段，
   按**线段 id** 撕（契约 6.19 的 `--ids`），结果透出 `rip_mode / ripped_lines /
   whitelist_skipped(+_ids) / whitelist_source`。
   取不到线段几何、或线段与焊盘不在同一坐标帧时**如实降级**为整网撕（`rip_fallback` 写原因），不静默硬算。
3. **SES 导入是追加语义**。增量模式不调 `clearRouting`，每轮 SES 都含既有过孔 → 必须去重
   （`import_ses.py` 按 DSN 坐标去重，`vias_skipped` 可见）。不去重会每轮叠加：19 对重合孔
   = 19 个 `Hole to Hole`，把 DRC 从 11 顶到 34。
4. **导出 DSN 的两处规则缺陷必须在导出后补**：`(rule(clear 6.05))` = 0.154 mm 低于实际要求 0.2 mm
   （`--min-clearance-mm 0.203` 提升，向上取整到 8 mil）；`(padstack via0)` 无 hole 子形状。
   不补则新走线贴着保留走线布，clearance 成片爆。

**已知残留（也是 P8 未通过的根因）**：布线器在 **DSN 帧**下判「不可布」的短连接，最终会暴露为
`Connection Error`。**但成因不是「撕掉后补不回来」** —— 定标板上查明是元件移动留下的焊盘外空隙
（见下条「该设想已证伪」）：`--rip-mode surgical` 的白名单目前**只是兜底**。

> **去向已定（2026-11-08 决议）**：**接受这条残留，不再修**。`conn≠0` 与 DRC 劣化如实上报，验收门继续判不过；
> **不得**为让它变绿而摘除 `connection` 判据、新增忽略开关、改基线读数，或在报文里塞「已接受」字段 ——
> 那是同型假绿（删端点让 `unrouted` 归零 / 排除铺铜网），两条都已被判死。**增量真跑的产物不可直接交付生产。**
> 依据：离线证伪报告 `dist-same-round-falsify-20261108.md`（实验）与决策包 `dist-route-quality-decision-20261107.md` §9（决议）；按文件名可在本仓检索到。

- **那个被三次误读的常数（fastroute 报的 117.3 mil）**：既不是线长、也不是 EDA 焊盘净距，而是 fastroute 在
  **DSN 帧**上报的待连长度（`unrouted[].length_mm`，字段实为 mil/1000），真值 **117.3 mil ≈ 2.98 mm**。
  EDA 侧同一对焊盘边缘净距实测 **0.8217 mm**。教训：**跨量纲的常数不要当几何真值用**
  （取证见仓库 `research/docs/pad-field-probe.md`，该目录为内部取证、不随技能包发布）。
- **因果也不成立**：同网焊盘仅「近距」并不会 unrouted —— 实测布线器用 0.254 mm 短线直接短接
  （`junction=short`）。不可布是「近距 ∧ 邻网包围」的合取，**只有布线器自己知道**。
  所以现行 `pad_gap`（同网焊盘净距 < 0.2 mm + 链路拓扑）判据**只作兜底**，不要拿它当因果解释；
  usb_hub 上四网最小净距 0.6985–0.8217 mm 全 >0.2 ⇒ `tight_pairs=0`、保护 0 段（实测）。
- **该设想已证伪，不是「待落地」**：曾设想「读上一轮快照的 `unrouted` 连接当判据、映射回铜链后下一轮不撕」。
  离线同构实验判定不成立：全连通板上这一步拿不到清单；把被撕的铜复原后待连数也不下降 —— 真正的缺口是
  **元件移动**留下的焊盘外空隙（定标板实测 55.699 mil ≈ 1.41 mm，旧铜末端在新焊盘外 26.434 mil ≈ 0.671 mm）。
  ⇒ 不撕只是把**孤儿铜**留在板上。该方向只在「撕网原因 ≠ 元件移动」时才可能有意义，**不要照它落地**。
- 现行实现仍保留 `pad_gap` 判据（读到焊盘几何时 `whitelist_source="pads"`；读到上一轮报告时
  `"feedback"`；都读不到时 `"none"`）作为**第一轮无反馈数据时的兜底**；
  焊盘几何**必须从 EDA 读**（`pcb_PrimitivePad.getAll()`）——板模型焊盘尺寸是 0.6×0.6 占位值，
  用它算会把 0.8217 mm 算成 1.66 mm；官方 AutoLayout JSON 的 `components[].nets` 也不可靠
  （实测只覆盖 108 个焊盘里的 56 个）。读不到时白名单为空、`whitelist_source: "none"` 并警告。
- **作用域 = 全部网络（含目标对）**，连通性优先。
- 结果透出 `whitelist_skipped`（条数）+ `whitelist_skipped_ids`（**具体线段 id**）：实测相邻
  长度只差 0.0177 mm（0.2896 vs 0.3073），只报计数会让两次实验的差异无法归因。
  `legacy_len_whitelist_count` 是「按旧线长判据会保护多少段」的对照数，**不参与决策**。
- **P8 验收结论：未通过**（Connection Error 4 要求 0、DRC 13 要求 ≤8；skew 98.4 µm 相对 100 µm
  是擦线、且是预期 ~7 µm 的 14 倍，**不得当作达标引用**）。计划内 ≤100µm 与 ≤20µm 两处口径并列，
  不择一。
- **白名单到底有没有在工作，只看两个数**：`tight_pairs`（读到的不可布焊盘对数）与
  `protected_chains`（实际认出来的承载铜链数）。`tight_pairs > 0` 而 `protected_chains == 0`
  时 `rip_warnings` 会逐网写出告警——这时**先怀疑判据/几何读取**，不要直接采信 `ripped_lines`。

**坐标帧陷阱（算外科撕网必读）**：`eda.pcb_PrimitiveLine/Via/Pad.getAll()` 返回的是**画布 mil**，
而板模型（`board_from_autolayout`）是**毫米且已平移到第一象限**。两处差异（单位 + 板框原点）
任一漏做，几何判定都不报错、只会**静默全空**：一条都不撕，还以为「周围没有走线」。
`read_board_lines()` / `read_board_pads()` 负责换算，`lines_frame_check()` 用「端点落在同网络
焊盘上的比例」自检：至少 2 个端点命中且比例 ≥ 5% 才算同一帧（单命中可能只是巧合），
比例 < 20% 额外标 `weak`；不达标即判帧不自洽并退回整网撕。

**用 EDA 内置布局做对照**（4.1.78 的入口在「布局」菜单，不在设计/布线）：

```bash
python scripts/eda_verbs.py eda_builtin_place              # 干跑：只给计划，不连客户端
python scripts/eda_verbs.py eda_builtin_place --confirm              # auto：api → bus → menu
python scripts/eda_verbs.py eda_builtin_place --via bus --confirm    # 只依赖 CDP（bridge 挂了也能用）
python scripts/eda_verbs.py eda_builtin_place --designator --confirm        # 开表单，需人工点「运行」
python scripts/eda_verbs.py eda_builtin_place --designator --confirm --run  # 代点「运行」并回读位号坐标
```

内置引擎**不认本 skill 的锚定模型**，也不产出回滚表——用之前自己存一份坐标基线；
拿它做 HPWL 对照时，要写清基线是原板还是内置结果。

**布线器选择**：`--router builtin | external | fastroute`。fastroute 是 Rust 版 Freerouting
（GPL-3.0，免费商用），同板 0.85–1.4 秒出结果（FreeRouting 24 秒）、DRC 持平（5），
`route_external --fastroute` 即可用。
**定点重布**：`--only-nets D1_P,D1_N` 只清/只布指定网络，其余走线原样保留
（实测：机制可用，但单对重布会与既有走线冲突——usb_hub D1 重布后 DRC 5→11，不推荐作为默认）。fastroute 的差分对**真的生效**（`--pairs=FILE`，注意必须是等号形式；空格会被静默丢弃）。
usb_hub 实测 5 对全部进入预布：D1 耦合 0.15→0.82 mm，D2/D3/D4 因相邻焊盘短连接报
`no room beside the pair`（几何限制而非功能问题）。FreeRouting 则完全忽略 pair。

**等长检查**：`cdp-connect/scripts/net_skew.py --title <片段> --auto` 读每对 P/N 长度
（单位 µm）算 skew，超 ±100µm 退出码 3。usb_hub 实测 D 对 319.6µm 超差，其余 ≤100µm；
fastroute `--tune=` 可补蛇形但该板报 `no room for meanders`——几何受限，非工具问题。

**差分对**：`dsn_pairs.py` 可按规范注入 `(pair ...)`，但 **FreeRouting 2.5 忽略之**（实测逐项一致）；
`--protect-diffpairs`（保留对线）实测更差（DRC 49 vs 5）。当前最优：清空 + 全量外部布线 + 铺铜重建
（usb_hub 实测 DRC 5，优于作者基线 7）。

**真实板护栏**：`relayout_route` 在 >12 器件或 ≥2 个差分对网络的板子上**默认拒绝整体重布局**
（实测 usb_hub 18 器件/10 对差分对：HPWL 628→234 后布线器留下 24 条未布通、DRC 180）。
真实板应只布线不挪布局：`route_external`。确需重排加 `--force-layout`。

外部布线（headless 全链路）：`route_external --passes 30 --confirm` 一次做完
「导出 DSN → FreeRouting 无头布线 → 清线 → 导入 SES → DRC 复检」，不碰任何 UI。
实测演练板 DRC 0（内置 RPC 直调为 DRC 11）。**真无头**：FreeRouting v2.5.0 +
`--gui.enabled=false`（JRE 25 在 `~/.workbuddy/binaries/java25/`，不弹任何窗口）；
v1.9.0 虽配 Java 23 但必须弹 GUI，仅作降级备选。DSN/SES 走连接层契约
`export_dsn.py` / `import_ses.py`。

闭环：`relayout_route` 一次做完「解布局 → 批量导入 → 清线 → 布线 → DRC 复检」。
**自动布线默认不保留已有导线/过孔**（`existingPrimitiveMode:'remove'`，等价于设置里
取消勾选「保留已有导线/过孔」），除非显式 `--keep-routing`；RPC 缺省是 keep，不显式传
就会把新线叠在旧线上。
清线在编辑器里可被 `undo` 撤回（撤销栈覆盖导入/清线/布线），但正式回滚仍用 `rollback`。

对齐与分布：`align_components --mode left|right|center-x|top|bottom|center-y|distribute-x|distribute-y`，
可选 `--refs C1,C2` 限定范围、`--gap` 指定固定间距；按包围盒计算，另一轴不动。

写回方式：`auto_place` 优先用「官方布局 JSON 批量导入」（一次原子应用、位号跟随、走线保留、
回滚=重导基线），失败才逐件 `modify`。结果里 `via` 字段会写明走的哪条路。

**四条硬教训**：

1. 单位是两套——求解器用毫米，EDA 图元用 mil；写回由脚本换算，手写调用时别混。
2. 位号随元件平移但不自动转向，写回必须显式给 rotation，否则标签方向和元件脱节。
3. 布局后 DRC 数字没有回归意义：元件动了、走线没动，连接类错误必然暴涨，判定要看重布之后。
4. 硬锁件（连接器、安装孔）不参与云平移，也不参与消解挪动；它们重叠时只能靠人。
5. 批量导入会保住走线，但**会在元件新位置处切分线段**：反复「应用→还原」后线数会小幅增长
   （实测 19→21），电学仍连通、DRC 可回 0，但别把线数当不变式。
6. **「历史记录」恢复预览态会禁止一切写操作**（视口顶部橙色细横幅）：菜单整体变灰、
   `clearRouting`/`delete` 返回 `true` 但不生效、`autoRouting` 全部失败——看起来像接口空壳，
   其实是被预览态挡住。任何写操作前先确认没有橙横幅。正常编辑态下
   `clearRouting` + `autoRouting({})` 全部有效（实测 4/4 布通）；
   `RoutingNets` 数组参数无效（`duration:0`），只能 `{}` 全部网络。
   裸参数 RPC 布线质量可能不如 UI（同板 DRC 11 vs 0），闭环跑完必须 DRC 复检。
   **有铺铜的板子**：把铺铜网络（如 GND）填进 `relayout_route --ignore-nets GND`，
   实测被忽略网络 0 段线、其余全通，靠铺铜连接。注意存的规则（updateAutoRouteRule）
   不影响直调——`ignoreNets` 必须写在调用参数里。UI 的引擎走内部通道、质量更好，
   要 UI 质量走界面或 DSN/SES。
7. bridge 单请求上限 30 秒：整板自动布线会超时，`relayout_route` 已改为**逐网络**调用，
   每个网络的结果（`successNetsCount` / `failedNets`）都会如实记录。
   实测演练板 4 个网络全部失败——布线失败不等于布局错，需结合 DRC 分类判断。
8. **写操作前置检查**：历史预览态（顶部橙横幅）与模态对话框会静默吞掉写操作，
   本 skill 的写动词在 `--confirm` 时先查状态再执行；手工调用前用 `python scripts/dialogs.py --guard`
   （有弹窗 exit 3）与 `--list --classify`（看是哪一类、默认怎么处置），处置口径见《弹窗》一节。
9. 位号没有批量接口：`modify` 传数组会报 `t.isAsync is not a function`，只能逐件写；
   想批量只能走 EDA 内置「自动位号布局」（`place_designators --builtin`），但那不认本 skill 的朝向策略。

## 标准操作：丝印多格式排版与检查（2026-11-10）

**一句话**：一个 `pcb_PrimitiveString` 只能有一种格式（字体/字号/反相），所以「多格式段落」只能拆成
多个 run；本 skill 用一个纯离线编译器算坐标，再逐 run `create`。**粗体/斜体不是 API 字段，是字体面**。

### 字体面（实测，别按 CSS 思路写 `bold:true`）

| 样式 | 字体面 | 实测 |
|---|---|---|
| 常规等宽 | `JetBrains Maple Mono Medium` | 0.58em/字符，与字形无关 |
| 粗体 | `JetBrains Maple Mono Bold` | 与 Medium **同宽**，加粗不跑位 |
| 更粗 | `JetBrains Maple Mono ExtraBold` | 同上 |
| 斜体 | `Arial Italic` | 需 `sys_FontManager.addFont('Arial Italic')` 注册；比 Arial 宽约 3% |
| 中文 | `HarmonyOS Sans SC` / `default` | 0.961em/字（default 面 4 字实测；其它 CJK 面未标定，按同一常量估算） |

`modify(id,{bold:true,italic:true})` **返回对象但不生效**（未知字段静默忽略），这是本 skill 不提供
`--bold/--italic` 开关的原因：不是没接线，是 API 里根本没有这两个字段。

### 字宽：没有测量 API，只能算

`pcb_PrimitiveString` 不返回文字宽高。估算口径在 `scripts/silk_metrics.py`：
等宽 **0.589em**（三字重实测 0.5886/0.5895/0.5886）、CJK **0.961em**、`default` 比例字体逐字符查
`DEFAULT_OVERRIDES`（I/l 0.247、i 0.301、W 0.787、M/w 0.679、m 0.841、0-9 0.383~0.652、空格 0.30），
全部来自 2026-11-10 真机截图量**簇间距**。
实测偏差：固定 0.6em 在 `IIIIII` 上高 2.4×、`WWWWWW` 上低 24%——**比例字体不能用固定值**。
标定表 `references/silk-calibration.json` 与内置常量同源，**Δ=0 只证明读取链路通**；
要重测走 `scripts/silk_calibrate.py spec/measure`（链路见本节「丝印字宽标定」）。

### 排版编译器

```bash
python scripts/silk_layout.py --runs runs.json --json      # 看坐标与告警
python scripts/silk_layout.py --runs runs.json --js        # 出 bridge 函数体，不执行
```

`runs.json`：`{"width":500,"align":"left|center|right","layer":3,"font_size":100,"line_width":12,
"line_height":1.5,"origin_x":0,"origin_y":0,"runs":[{"text":"电源 ","font":"default"},
{"text":"VCC","font":"JetBrains Maple Mono","bold":true},{"text":" 3.3V","font":"Arial","italic":true,"size":70}]}`

输出每个 run 一行 `{text,x,y,fontFamily,fontSize,lineWidth,alignMode:3,...}`，`alignMode` 一律 3（左下锚点），
x 按「占位宽 = advance + lineWidth」累加，换行只改 y。**已知代价**：run 内部字距/词距改不了；
一段 = N 个独立图元、没有 group，改一个字要整段重建；`--js` 只是 payload，落盘要自己走 bridge。

### 检查（`aesthetic_lint`）

判定已从注入浏览器的 JS 搬到 `scripts/silk_lint.py`，七条规则：
`rotation`（只许 0/90）、`font-size`（35.43–118.11 mil）、**`text-over-pad`（包围盒相交，error）**、
**`text-over-via`（包围盒 × 过孔圆相交，零阈值，error）**、
`text-near-pad`（锚点到焊盘中心 <20 mil，仅 legacy 提示）、`via-clearance`（阈值型，需 `via_clearance_mil`）、
`text-outside-board`（需 `--board-box x1,y1,x2,y2`）。

**阈值口径**（取证见 CHANGELOG 1.13.0 与 `references/capability-map.json` 的 aesthetic_lint 条目）：规范 §16.5 对焊盘/过孔/板边
**只有定性要求，没有任何 mil 数值**，所以「至少 N mil」这类规则一律没有出处——现在的 20 mil
是历史自造值，只保留为 warn。**能量化的是「相交」**（容差 0），这才是主判据。

- **`text-near-pad` 不是主判据**：长文本锚点可能离焊盘 200 mil 却压住焊盘，旧判据判不出来；相交优先。
- **板框读不到**：索引里没有 boardOutline getter，`pcb_Primitive.getPrimitiveBoardLine` 只算单个图元
  且归档实测 Promise 不 settle ⇒ 不给 `--board-box` 时该规则进 `skipped`，**不当作通过**。
  `board_edge_tolerance_mil` 只作用于这条，不影响焊盘/过孔避让。
- **`coverage` 四档**（`none` / `unreadable` / `strings-only` / `full`）：`none` 必须写「丝印未覆盖」，
  `unreadable` 必须写「记录缺失不是违规为 0」（两者都不能报「0 违规」）；位号丝印走
  `pcb_PrimitiveAttribute`（key=Designator、valueVisible、layer 3/4）。
- 输出 `findings` 截断 80 条（**截断前按严重度排序，error 优先**），`findingCount` / `findingCounts`
  是全量——别拿 `findings` 长度当违规总数。`dropped` 记被丢弃的 null 坐标条数。
- **`--board-box-from FILE`（推荐）**：直接吃 `export_autolayout` 导出的 JSON，取 `boardOutline.path`
  的外接框，内部**按毫米→mil 换算**（×1000/25.4），换算结果写在返回值的 `board_box` 里可复核。
  例：`python scripts/eda_verbs.py aesthetic_lint --board-box-from out/autolayout.json --json`。
  与 `--board-box` 互斥（同时给 = 前置检查失败 exit 3）。外接框对 L 形/异形板是宽松判据（凹口内文字会漏报）；
  **register 不到板框时仍然 skipped，不当作通过**。

### 彩色丝印与位图对象

```bash
python scripts/eda_verbs.py manufacture_export --kind gerber --color-silk --download
python scripts/eda_verbs.py set_pcb_embedded_object --image logo.png --layer 3 --x 2000 --y 3000   # 干跑
python scripts/eda_verbs.py set_pcb_embedded_object --image logo.png --layer 3 --x 2000 --y 3000 --confirm
python scripts/eda_verbs.py set_pcb_embedded_object --id <id> --x 2100 --lock --confirm
```

- `--color-silk` 只对 `--kind gerber` 生效，调 `getGerberFile(undefined, true)`。**2026-11-10 真机已验证**：
  彩色包比普通包多 3 个文件——`Fabrication_ColorfulTopSilkscreen.FCTS`、
  `Fabrication_ColorfulBottomSilkscreen.FCBS`、`Fabrication_ColorfulBoardOutlineLayer.FCBO`
  （实测 9 项 → 12 项，4349 B → 9592 B）。返回的 `color_silkscreen` 仍只表示「本次是否请求」，不是能力探测。
- 导出的 zip 名由 EDA 给，**不带彩色标记**：同一天导普通 + 彩色会同名互相覆盖。本 skill 在
  `--color-silk` 时落盘名加 `-color` 后缀（`Gerber_X.zip` → `Gerber_X-color.zip`）。
- `set_pcb_embedded_object`：坐标单位 mil，图片 ≤2 MB（按原图字节，不是 base64 长度）且编码成 data URI
  （裸 base64 会被 create 拒）；`--lock/--unlock`、`--mirror/--no-mirror` 是成对的显式 false 通道；
  `--layer 0` 直接拒（不静默改成 3）；`nan/inf` 前置拒。
- **换图不可用**（2026-11-10 真机证伪）：`modify({binaryData})` 与 `setState_BinaryData()+done()`
  都返回对象、回读 image key 不变。所以要换图只能 **delete 旧对象 + `--image` 重建**；
  `--id` + `--image` 现在直接 `VerbError(3)`，不给你「以为改了」的机会。
- 回读：`getState_BinaryData()` 返回的是 **64 位 image key**（两张不同图 key 不同），不是 data URI，
  别拿长度或内容比；payload 里的 `image_key` 只作诊断。其余字段逐项比对（数值容差 1e-6）。
- 返回里的 `props.binaryData` 是脱敏串（保留 mime 前缀 + 32 字符），不是原文。

### `text-outside-board` 的两种判据（`--board-box-from`）

`--board-box-from` 默认**同时**取外接框与多边形顶点，`text-outside-board` 优先用多边形：

| 判据 | 什么时候用 | 代价 |
|---|---|---|
| 多边形 | 默认（`--board-box-from`） | 凹口/异形板判得准；渲染 `N 个顶点 + 外接框` |
| 外接框 | `--board-box-rect-only`，或手写 `--board-box` | L 形/凹口板**漏报**：凹口里的文字落在框内、实际在板外 |

`board_outline_mode` 会写进返回值（`polygon` / `rect` / `none`），findings 里每条也带一份——
**看结论前先看这个字段**，`none` 表示两条判据都没用上（此时该规则进 `skipped`，不是「0 违规」）。

多边形解析失败（例如 path 退化）会降级到外接框并在 `board_polygon_error` 里留痕，
**不 exit 3**——外接框仍能给保守结论，硬失败会把另外六条规则本来能给的结论一起丢掉。

已知偏宽松：`board_edge_tolerance_mil` 的实现是「四边内缩」，45° 斜边上实际放行
`tolerance × √2`。要精确到 mil 就别依赖它。

### 截图量丝印（`scripts/canvas_crop.py`，离线）

```bash
python scripts/canvas_crop.py detect --image shot.png --json   # 画布 rect / 背景色 / confidence
python scripts/canvas_crop.py probe  --image shot.png --json   # 画布内丝印像素数 + 条带 + used_rgb
python scripts/canvas_crop.py mark   --image shot.png --out marked.png   # 画出 rect / 条带 / 字符簇
python scripts/canvas_crop.py crop   --image shot.png --out canvas.png [--rect x1,y1,x2,y2]
```

- **为什么必须先裁**：整窗截图里工具栏/工程树的图标会被颜色阈值算成「丝印」——
  实测整图 4432 个假命中、画布内 0 个真命中。
- **`detect` 在多窗格布局下不可信**：相邻的深色面板会被并进 rect。先 `mark` 看一眼，
  不对就用 `--rect` 手填。`probe` 的结论可用来反问：`silk=0` 时先怀疑裁剪，再怀疑板子。
- `bands` 默认 `gap=2`：**两行之间只空 1 行时会被合并**（`gap=1` 不合并）。实测 `lint_board`
  上 `gap=1` / `gap=2` / `silk_calibrate.bands` 三者都是 **9 条**，所以这是**潜在**差异而不是常态；
  把本模块的 mask 转喂 `silk_calibrate.measure` 时，显式传 `gap_px=1` 以免两边对不上。
- `detect --strict`：候选不止一个时直接判失败（exit 2）并列出每个候选的评分与彩色占比。
  默认**不开**——默认压分会让本来正确的自动路径全部变成「必须先手填矩形」。

### 视图/高亮类命令的判据：画布差分（`scripts/canvas_diff.py`，离线）

```bash
python scripts/canvas_diff.py --a before.png --b after.png --rect 0,173,2561,1061 --out res.json
# exit 0 有差异 / 1 逐像素相同 / 2 输入坏（缺文件、尺寸不同、rect 越界） / 3 用法错
```

- **这类命令没有别的判据**：`publish('adaptAll','1')` 之类不动板面，六信号快照读不出；视口与
  高亮又没有 getter——`dmt_EditorControl.zoom` 是 `zoom(t,i){return!1}` 空壳，
  `zoomToRegion(left,right,top,bottom,tabId)` **返回 true 但画面不动**（补上 tabId 也一样）。
- **必须先做正控**：视图已处于目标状态时，「做成了」与「命令是死的」给出同一个读数（0 差异）。
  先把画面挪开（`selectAll` + `adaptSelect`），再发被测命令。2026-11-10 就因为没做正控，
  一度把 `adaptAll` 判成死的。
- 已真机点亮：`adaptSelectionView`（`adaptSelect`）、`fitview`（`adaptAll` + payload `"1"`）。
  飞线族 `toggleRatlineNet` 的四种组合（GND / 空网名 × show / hide）全是 0 差异，但
  「画面本来有没有飞线」这个基线不可知 ⇒ 记 **inconclusive**，不要下「命令死了」的结论。

### 丝印字宽标定（`scripts/silk_calibrate.py`，真机可复跑）

先记住结论：**字宽只能靠截图量，而量的对象是「簇间距」不是「整段墨宽 ÷ 字数」。**

```bash
python scripts/silk_calibrate.py spec  --out .workbuddy/tmp/spec.json \
    --chars I,W,M,0,1,2,3,4,5,6,7,8,9 --no-groups --row-pitch 130 --reference-mil 600
python scripts/silk_calibrate.py measure --image canvas.png --spec .workbuddy/tmp/spec.json \
    --out references/silk-calibration.json --rgb 255,204,0 --reference-cap 0
python scripts/silk_calibrate.py check --table references/silk-calibration.json
```

`--chars` 是**逗号分隔的单字符列表**，不认区间写法（`0-9` 会被当成一个三字符探针）。
`--no-groups` 去掉 `123456`/`电源电源` 这些组均值行：行数从 13 降到 9（单字体面 10→6），
块高约减半，同一视口下 px/mil 从 ~0.7 升到 ~1.2。

真机链路（2026-11-10 跑通，全程写在 `silk_calibrate.py` 顶部注释）：

1. `dmt_Pcb.createPcb()` **不传参**建临时板 → `dmt_EditorControl.openDocument(uuid)`；
2. 丝印参考线**只能用折线**：`pcb_PrimitivePolyline.create('', 3, pcb_MathPolygon.createPolygon([0,0,'L',600,0]), 12, false)`
   （`pcb_PrimitiveLine.create` 在 layer 3 恒报「无法创建直线图元」，见能力表）；
3. 文字按 `board_y = -plan_y` 放（数据坐标 y 向上、图像行序自上而下），对齐用 `alignMode=3`（左下）；
4. 画布不重绘时 `setLayerInvisible(3)` + `setLayerVisible(3)` 刷一次；
5. `dmt_EditorControl.zoomToAllPrimitives(tabId)` → `getCurrentRenderedAreaImage(tabId)` 取**纯画布** PNG；
6. `deletePcb(uuid)` 收摊，回读 `getAllPcbsInfo()` 确认计数回原值。

三个必须知道的坑：

| 坑 | 现象 | 处置 |
|---|---|---|
| 参考线端点帽长 | 旧代码按「+一个 lineWidth」定标，实测是**平头**（300/600 mil 两条线同图对照解出帽长 −1.0 mil） | `--reference-cap 0`；不传则沿用旧口径 |
| 字内部件被切成两条带 | `iiiiii` 的点与主干隔 ~4mil（font 100）→ 条带数比计划多 1，探针**整体错位一格** | `measure` 按 `0.12×字号` 阈值合并（font 100 时 12mil），且**参考线永不参与合并**、合并后高度超 `1.6×字号` 就拒绝 |
| `getCurrentRenderedAreaImage()` 不带 tabId | 取「最后输入焦点的画布」，可能是**另一个文档**（PCB1 而不是 PCB2），量出来的是别人的丝印 | 一律显式传 `tabId`（`openDocument` 的返回值） |

**advance 模型的量级**（实测，别再用旧表）：`I/l=0.247`、`i=0.301`、`W=0.787`、`w=0.679`、
`M=0.679`、`m=0.841`；数字不等宽，`1=0.383`、`4=0.652`、`0/2/3/5/7/8=0.625`、`6/9=0.599`；
CJK 0.961em。旧表给 `I=0.207` 是因为分母用了 `n` 而不是 `n-1`：六字串量出来只有真值的 5/6（少 16.7%，真值 0.247 比 0.207 高 19%）。

**验证过的一致性**：同一个字在 1.3767 与 2.28 px/mil 两张图上复测，偏差 < 0.2%；
`IIIIII` 的墨宽 135.1mil 与 `5×24.70+11.6` 逐项对得上（不是只对总宽）。

## 已知边界

1. 差分对定义与重建灌注在两套接口里都没有直接入口，只能走界面路径；无视觉通道时降级为人工。
2. 泪滴、网络类、扇出、蛇形等长在官方接口里没有创建入口，属连接层的攻坚项；本技能在缺口补上之前不承诺这些动作。
3. 无视觉通道时不能给出布局美学的机器结论，只能给 A 类自动断言与人工观察。
4. 阻抗、叠层数值、载流、安规由外部计算确认。**本技能把确认后的层数（2..32）与板材类型落进软件；叠层结构、介质厚度、阻抗参数落不进去**——叠层族 10 个方法全是空桩（读侧 `getCurrentPhysicalStackingConfiguration` 返回 undefined、`getAllPhysicalStackingConfigurations` 返回 `[]`；写侧 `save/rename/delete/setAsDefault/overwrite` 一律 `false`），只能给数值由人工在界面填写。
5. 一个客户端可能同时开着多个工程窗口；执行前先确认目标窗口，不要对着 A 窗口下 B 窗口的指令。
6. **布局动词使坐标作废**：自动布局等价于批量移动 + 旋转，之后先前采到的引脚/焊盘坐标一律不可信；连线、差分对、命中检查必须用时现取。`layout_epoch` 记在 `out/state.json`，与取坐标时的纪元不一致就重取。
7. **位号是属性图元**：位号不是独立文字，而是 `pcb_PrimitiveAttribute`（key=Designator），随元件平移但不自动转向；改位号就是改该属性的坐标/旋转/字号。
8. **布局会让既有走线作废**：元件移动后，原走线与焊盘不再连接，DRC 会因网络断开而暴涨（实测 18 件板从 7 条升到 923 条）。`auto_place` 只动元件；要么先加 `--clear-routing` 清线再布局、随后用路由动词重布，要么接受「布局后必须重布」，别把布局后的 DRC 数字当回归结论。
9. **`net_skew --auto` 只按 `_P`/`_N` 后缀配对**：板上差分对若叫别的名字（DRC 的 `ids` 字段可证，
   如 `["N1","N2"]`），它报「没有可检查的差分对」≠ 板上没有差分对——**skip 是工具盲区，不是板卡
   属性**。且失败时 stdout 完全为空（物证：0 字节 json 文件），skip 与崩溃在输出上不可区分。
10. **`aesthetic_lint` 的包围盒已接标定表，但仍是估算**：`silk.text_bbox` 2026-11-10 起 ASCII
    宽度取 `silk_metrics.advance` 的实测值（`W/M/m` 从低估 25~31% 修正），**CJK 仍按 1.0em**
    （advance 0.961 比全角墨迹窄，保持 1.0 是保守方向）；高度恒等于字号、不随字形变。
    字体面固定按 `default` 算——lint 侧还没把每个文字的 `fontFamily` 带进来。后果按字符分两向，
    **不是统一保守**：`W` 偏宽 0.9%、`M` 偏宽 10.2%、`1` 偏宽 39.9%，而 `I`/`l` **偏窄 58.1%**
    （`default` 的 `I`=0.247 vs 等宽 0.589）、混合字母串偏窄 15~26%。所以等宽字体里的窄字会把框
    算得过窄，「压住焊盘」有漏报风险。根因在取数层：板面读出的字符串根本没带字体面，
    `text_bbox` 不是忘了传。
    `text-over-pad` 的判据只在「框与焊盘相交」这个量级上可信，**别拿框当字形精确边界**。
11. **`pour_rebuild` 的成功判据是 `poured>0`（全板灌注图元总数）**：重建是**替换**不是新增，
    计数恒定（实测 2→2 而重建确实发生了）。**判重建只看 DRC 的 `Copper Region(Filled) to
    Track` 计数下降，不看任何计数**——`poured>0` 在 DRC 恶化时也成立。
12. **`fastroute --pairs` 对 EasyEDA 导出的 DSN 不触发**（pair 阶段日志根本不出现）→ 差分对被当
    普通网络布，产生 `Differential Pair Error`；**解法在差分对识别，不在 clearance 参数**。
13. **一次 `import_ses` = 1 个撤销单元**（`import_ses` / `pour_rebuild` / `rip_nets` 各 1）：
    回退给 `--times 2` 会连撤上一步的 `rip_nets`；**逐次回退并每步回读**——`undo` 到栈底仍
    `rc=0`，退出码不回答「撤了什么」。

## 停止条件

出现任一情况，停止并如实说明：

- 客户端版本不是 4.1.x，且带参数启动确实开不了端口。
- 两条通道都不可用，用户又不愿补齐。
- 需要登录或授权才能继续。
- 需要改安装文件、注入进程或打补丁才能拿到通道。
- 用户拒绝对写操作授权，而该动作无法降级。

## 判据与证据纪律（2026-11-04 起，写断言或下结论前必读）

> 来源：D4 全链路复验（cdp 仓 `notes/56` §六）。每条都对应一次真实误判，不是抽象原则。
> 总检验方式：**判据必须对「做成了」和「没做成」给出不同的值——两个值一样，它就不是判据。**

### 假断言五族（写测试断言时逐族自检）

| 族 | 形态 | 自检问法 | 真实实例（全部踩过） |
|---|---|---|---|
| ① 过窄 | 只查键存在 / 只查 `rc!=3` | **它什么情况下会红？** | 10 个字段只 `assertIn`，其中 5 个接错值也绿 |
| ② 退化 | 取值域被压成单值：期望值与被测恒相等 / 字段缺席时断言恒成立 | **字段缺席时它还成立吗？** | `stale_nets` 只在非空时输出，「为空」被缺席冒充 |
| ③ 过宽 | `if/else` 两分支都接受 | **A→B 行为迁移它感觉得到吗？** | 兜底改中止，双分支用例不红 |
| ④ 错位 | 断言指称的不是契约 | **只看用例名，知道它锁了什么吗？** | `test_..._reports_anchor` 实际断言的是 None |
| ⑤ 基准预设 | **替身里出现与被测代码同构的计算** | **替身在接收结果参数，还是在算被测的东西？** | 替身 `via_count += js.count("(via ")` → outcome 判据在替身里恒真 |

前三族造成**假绿**（沉默），④ 造成**假红**（诱人修没坏的东西），⑤ 是唯一**代码评审看不见**
的——必须专门读替身。④ 有三子型：**越权**（实现比契约强→退断言）、**欠约**（该升契约→升后
再留）、**覆盖错觉**（用例名与断言不符→改名+补正例）；判别问法：「愿意在契约里为它背书吗？」
**断言若会因为「实现变得更完整」而红，它锁的是实现细节，不是契约。**

### 字段缺失的三种语义（代码形状一样，处置相反）

| 语义 | 代码形状 | 处置 | 实例 |
|---|---|---|---|
| 漏传（bug） | 只在异常分支赋值 | **必须始终输出**（空为 `[]`） | `stale_nets` |
| 值域外 | 分支不赋值 | **记 `null`**（值域里的一格） | `divisor_anchor` 无锚点 |
| 未定 | 刻意不传 | **不许有该字段** | `wire_policy` 开关冲突时 |

判别问法：**「这个字段在这里有没有一个确定的值可填？」** 有→必须填；没有→不该有。
看到「字段不一致」先归这三类再动手——把「未定」统一成某个值，看起来像修 bug，实际是抹掉语义。

### 字段单位契约（字段名必须名副其实）

第三方工具给的字段若**单位与名字不符**，必须在**读取边界换算**，不许靠注释提醒调用者。
「要记得换算」是需要自觉的规则，不是护栏；机械换算才是。

- 实例（2026-11-07）：fastroute `--report` 的 `unrouted[].length_mm` 实为 **mil/1000**
  （= mm/25.4）。`incremental_route.py` 的注释早写过这一点，但报表仍原样透传，于是一次
  根因分析把 0.1173 当成 0.1173 mm，写出「0.2 mm 规则下没有走线空间」的结论；真值
  **2.98 mm**（DSN `(library)` 里两焊盘中心距 117.27 mil），成因其实是通道被约 190 条
  `(type protect)` 旧铜占满 —— 方向完全错。
- 修法：`offline_route.unrouted_length_mm()` 在边界换算，`length_mm` 存真实毫米，原始值
  另存 `length_raw_mil_1000`；`tests/test_unit_contract.py` 钉住 `0.1173 → 2.9794 mm`
  并与真板坐标实算的 `2.9787 mm` 对账。
- 自检问法：**这个字段的值，能不能直接用它的名字当单位？** 不能就在边界换算，
  别把「要小心」写进文档当护栏。

### 状态汇报（三行格式，全部命令取，不手打）

```bash
git rev-parse --short HEAD
git status --short
T=".workbuddy/tmp/pt-$(date +%Y%m%d%H%M%S)-$RANDOM" && mkdir -p "$T" && python -m pytest tests -q -p no:cacheprovider --basetemp="$T/base" --junitxml="$T/junit.xml"
```

**status 非干净时不跑测试**——半写状态的文件让数字既不可比也不可跑（实测读到
`Ran 68/2 errors`，实为测了一个不存在的状态）。**hash 相同 ≠ 内容相同**（未提交改动叠加其上）。

**为什么测试行每次都要全新的 `--basetemp`**：口径沿用 `CHANGELOG.md:358`（「验收用
`basetemp` 必须是尚不存在的全新路径」）——对已存在的 basetemp 执行 `rm -rf` 会撞宿主
护栏 `SAFE_DELETE_BULK_CONFIRM_REQUIRED`（阈值 50 由外部 helper 的诊断报出，不在 shim 里）：
junit 已写完 `failures=0`，进程却返回 `rc=1`，是假红。另一个坑是 `pytest ... | tail`：
只返回 `tail` 的 0，吞掉 pytest 的失败码，是假绿。⇒ 判定必须**同时看 junit 与退出码**，
`failures=0` 且 `rc=0` 才算过，缺一不可。

第三行的形状：`mkdir -p "$T"` 先建父目录（pytest 建 basetemp 用 `os.mkdir` 非递归，
父目录缺失直接 WinError 3），只让 `$T/base` 一级由 pytest 建；时间戳 + `$RANDOM` 保证每次全新；
`-p no:cacheprovider` 关掉 `.pytest_cache`；产物落 `.workbuddy/tmp/`（已 gitignore，不随包发布）。
实测 `rc=0`、junit `failures="0" errors="0"`。**收集数随 `tests/` 增长，以当次 junit 为准，
本文不写死**——写死会让下次加用例时这一行立刻变成过期口径。

**适用边界**：① 本行只管「状态汇报的全量判定」；`tests/test_board_reader_v2_*.py` docstring
里的 `--basetemp=.workbuddy/tmp/s-p0` 等是单文件定向诊断示例、固定路径，重复跑前须换全新目录
（否则撞同一护栏），本命令不沿用。② basetemp 落仓内只为「不写本机绝对路径 + 产物进 gitignore」，
不是因为仓外会红：`tests/test_map_rel_display.py` 一类「跨 basetemp 口径」回归锁曾因仓外
`tmp_path` 触发 `Path.relative_to(ROOT)` 抛错，`_rel()` 补仓外分支后，仓内/仓外两种全新
basetemp 实测均 18 passed；护栏只与「旧目录被清理」有关，与仓内/仓外无关。

### 证据规则（说「验证过」之前）

1. **四档判定**：①触发过+留证+当时字段已存在→真机 ②触发过无证→仅离线（另记「曾触发」）
   ③从未触发→仅离线 ④留证但字段当时没发明→仍仅离线。**证据必须晚于它所证明的契约**——
   旧存档证不了后加的字段（存档里 `wire_policy=null` 是因为字段当时还没发明）。
2. **「真机」要写成路径**（文件+日期+HEAD），不是词。**留证不入版本库等于没留**（`out/` 未跟踪）。
3. **零写入的证据强度取决于环境独占**：非独占下 `before==after` 只证明净变化为零
   （一写一撤也成立）。
4. **没有采集点的现象等于没有证据**——采集必须在跑之前设计，事后补不出来。

### 守卫价值（要不要给一段代码留测试 / 删掉）

| 情形 | 判定 |
|---|---|
| 真实输入触不到 + 无测试构造 | **价值为零，删** |
| 真实触不到 + 有测试构造 | 留（守假设场景） |
| 真实触得到 + 有测试 | 留，优先维护 |
| 真实触得到 + 无测试 | **最危险**（代价在真机才付），补测试 |
| 上行 + 替身预设了它的结论 | 最危险且最隐蔽，补测试**并改替身** |

### 三句总纲

- **人只是执行者，文件才是仲裁者**——两个结论必须落到同一个可 `cat` 的文件上。
- **能机械执行的规则优于需要自觉的规则**——把「要小心」换成「不做就错」。
- **数据不会说话，拆对了维度它才开口**——数字「看着正常」往往不是没数据，
  是没按网络 / 类别 / 段拆开（实例：`GND 53` 总数视角完全正常，按网络拆出 `Δ0` 才否掉错误归因）。

## 质量自查

- 跑过环境自检，`channel_state` 与后续动作对得上。
- 每个动词执行前查过路由表，换路有机器可判定的依据。
- 写操作有对象、影响、回滚三要素与确认记录。
- 每个写动作都有回读证据；结论里没有「点了没报错」这类依据。
- 证据包含版本指纹；报告里没有账号、邮箱、手机号、客户编号。
- 视觉结论标注为人工判断，未验证项没有被写成结论。
- 制造文件导出后核对过大小与命名。
- 状态汇报用三行格式（`rev-parse` + `status` + 测试行，全部命令取）；status 非干净时不跑
  测试、不报数——半写状态的数字既不可比也不可跑（见「判据与证据纪律」）。

## 反模式（看到这些组合就别急着下结论）

1. **`whitelist_source: "none"` 时不许说「白名单已保护」**。它表示焊盘几何没读到、白名单为空；
   此时 `whitelist_skipped` 也是 `null`（没算过），不是 0（算过但没保护）。两者语义不同，
   别把「不适用」读成「已生效」。
2. **`tight_pairs > 0` 而 `protected_chains == 0` 时，先怀疑判据/几何读取**。这组合意味着
   「读到了不可布焊盘对，却一条承载它的铜链都没认出来」——要么这对焊盘本来没连（正常），
   要么链路聚类/坐标帧/焊盘解析出了问题（会静默撕掉载体链 → Connection Error）。
   `rip_warnings` 会把这种网逐条列出来，**先看它，再决定要不要相信 `ripped_lines`**。
3. **别用 `ripped_lines` 变小说「撕得更精准了」**。先核对 `whitelist_skipped_ids` 与
   `protected_chains`：少撕可能是因为判定失效（一条都没认出），这时撕得少恰恰更危险。
4. **别把参数的默认值当成验收标准**（P8 就是这么错的）。`--pair-tol-um` 的默认 100 µm 是
   **收敛停止条件**，不是"过没过"的判据；把默认值抄成验收线，等于让「参数怎么设」冒充
   「什么叫质量达标」。验收线必须**单独论证**（能力上限、业务需求、上一轮实测），并写明
   **生效时间**——否则它会被事后追溯修改，那验收线就失效了。
5. **不可复现的轮次产出，不能当验收证据**。轮 3 变体（`pair-skew` 收紧）实测同 sha 连跑
   得 283.0 / 72.8 / 283.0 µm（轮 1/轮 2 稳定）。带差分对的增量验收固定用
   `--max-rounds 2`；要报 skew 必须同时报 `iterations[]` 全轮次与"最后一轮"，不许用
   `best_round`（它只记录、不回滚）冒充终态。
6. **别用「DRC 总数」对比下结论**（如「DRC 12→1」）。撕网后 / 导入后 / 铺铜后三个状态的
   **类别集合**不同，总数对比必误导；逐类列出，且 `cat` 与 `sub` 都写——`Track to Track`
   的 cat 可能是 `Differential Pair Error`，只写 sub 会让人当成普通间距问题去调参数。
7. **别把 `--dry-run` 的 rc 当「能不能跑」的判据**。dry-run 只预演**能判定的结果**，
   不预演**无法判定的输入**——两个互斥开关（如 `--drop-protect-wires` +
   `--keep-protect-wires`）同时给时仍 `rc=2`，与是否 dry-run 无关。
8. **别把「真机撞上过」当「真机验证过」**。判定要四件套：触发过 + 留证 + 当时字段已存在 +
   环境独占；旧存档证不了后加的字段（实例：存档里 `wire_policy=null`，只因字段当时还没
   发明——哪怕那次行为上真被拦了，也证不了这个 token）。详见「判据与证据纪律」。

## skew 数值的口径（2026-11-03 定性变更，务必先读）

**cdp 2.18.0 之前的所有 skew 数字，都是 `fastroute --multi-start=4` 的「打乱顺序跑 4 遍取最好」
采样结果**（`--help` 原文：`rerun the autorouter with N-1 shuffled orders in parallel`）。
这意味着：

1. **不可跨版本比较**：`2.18.0` 之后管线固定 `multi_start=1`（同输入同输出）。旧数字（319.6 /
   98.4 / 83.5 / 7.1 µm 等）与新数字**不是同一个抽样机制**，任何「改善/恶化 N 倍」的对比都不成立。
2. **基线要重立**：在 `multi-start=1` 下重跑一遍基线（`route_external --fastroute --confirm`），
   以此为后续对比基准。
3. **结果变差不等于配方退化**：best-of-4 取的是 4 次里最好的，关掉它（`multi_start=1`）后
   **单次结果变差是预期的**。看到 skew 变大先确认 `multi_start`，不要急着改配方。
4. 「预期 ~7 µm」这类说法一律标注为 **best-of-4 下的单次观测**，不是确定性目标，更不是验收线。

## 发布物边界（打包/上架前必读）

仓库根 = 技能根，**整个目录会被当成技能包**。因此下面两类必须分开，否则本机绝对路径、
云工程 uuid、账号下工程名会随包外发。

**必须入包**：`SKILL.md`、`README.md`、`AGENTS.md`、`LICENSE`、`CHANGELOG.md`、`skill-dependencies.json`、
`scripts/`、`references/`（含逐页台账 `doc-manifest.json` 与 API 索引）、`tests/`、`requirements.txt`。

**不得入包**：

| 目录 | 内容 | 理由 |
|---|---|---|
| `research/` | 取证/实验/计划文档 | 含本机绝对路径、**云工程 uuid**、账号下**工程名清单** |
| `out/` | 运行产物（DSN/SES/证据包） | 产物快照，非技能内容 |
| `logs/` | 运行日志 | 同上，且日志里会带绝对路径（本仓库曾误把 `logs/freerouting.log` 纳入版本库） |
| `docs/` | 文档存档原文 + 采集/压缩工程记录 | 3553 页正文与图片只服务开发期复现；台账与 API 索引属运行时产物，已落在 `references/` |

**打包前验证（两条都要过）**：

```bash
# ① 候选包内不得出现绝对路径。
#    注意模式里写 Us[e]rs / Proj[e]cts：让这条命令**不匹配它自己**（否则自证失败）。
#    扫仓一律 git grep，禁用 xargs grep —— 它会吞结果。
git grep -n -I -E "(C|D):[\\/]{1,2}(Us[e]rs|Proj[e]cts)|/c/Us[e]rs/" -- \
    SKILL.md README.md AGENTS.md LICENSE CHANGELOG.md skill-dependencies.json \
    scripts references tests requirements.txt
# 期望：无输出（2026-11-03 已全清；若出现命中，先按「发布物边界」上表判断它是否该入包）

# ② 排除清单生效：把实际打包内容列出来，逐项对照上表
#    例：ls <包根> 后确认没有 research/ out/ logs/ docs/
#    （research/ 与 docs/ 已由 .gitattributes 的 export-ignore 自动排除；out/ logs/ 未被跟踪）
```

**配远端前的硬关卡（不可绕过）**

脱敏只改了工作区文件，**git 历史里的 uuid / 工程名 / 绝对路径仍是原文**。
因此：**在执行 `git remote add` 或首次 `git push` 之前，必须先做出一个明确决定**——

- **清历史**：用 `git filter-repo` 重写，**会让所有引用旧 sha 的文档与 `evidence-<sha>/` 目录名失效**，
  需同步更新本仓 `research/` 内的 sha 引用；
- **接受**：明确写下"已知历史含本机路径/工程 uuid，接受其随仓库公开"，
  并确认远端仓库的可见性符合预期。

⚠ 这个决定**只能在无远端时低成本完成**。一旦 push，再清需要强推 + 所有协作者重克隆；
若届时才发现，代价由整条协作链承担。**未做此决定前不要配置 remote。**

**当前机制状态（诚实标注）**：`research/` 与 `docs/` 已由 `.gitattributes` 的 `export-ignore`
自动排除（`git archive` 生效）；`out/` 与 `logs/` 本就未被 git 跟踪，天然不在包里。
但本仓库**仍然没有** `.skillignore` / `manifest.json`，也没有打包脚本，所以本节是
**部分自动 + 人工清单**，不是全自动约束，上面两份清单仍需人对照。若将来引入支持
`.skillignore` 的打包链，请从上面两份清单机械生成，不要再手抄一遍。

> 相关：绝对路径/密钥类的"扫描干净"结论**必须用 `git grep` 复跑**，见《Harness 运行纪律》→「扫仓一律 git grep」。

## Harness 运行纪律（实测沉淀，代理执行本 skill 时必须遵守）

- **确定性前提**：求解器结果依赖 Python 的 set 迭代顺序（`cloud_adjacency`），跨
   `PYTHONHASHSEED` 可能漂移（实测同板同 seed `moves=46/32/77`、violations 0~2 随机跳）。
   排查可复现性问题时先设 `PYTHONHASHSEED=0` 再跑两遍对比。已修复并加了 DeterminismTest，
   但任何新的集合迭代→浮点累加代码都要警惕这条链。
- **先干跑后确认**：所有写动词先跑 dry-run（不加 `--confirm`），核对 `would` 列表、
   撕网/忽略集合、`patch.refs` 与预期一致，再加 `--confirm`。干跑不写板。
- **自动门与回退**：`relayout_route --incremental` 自带验收门（DRC 不劣化 ∧ 目标对
   skew ≤ tol ∧ 无未布通 ∧ violations 空）；门不过自动 undo 回基线（上限 14 步）。
   **带目标差分对的验收一律用 `--max-rounds 2`**：轮 3 起走 `pair-skew=0.05` 变体，实测同 sha
   两次跑出 283.0 / 72.8 µm（根因是 fastroute 的 `--multi-start` 打乱多起点，连接层已默认关掉，
   但轮 3 的实时几何重算叠加变体仍不宜作证据）。给 `--max-rounds ≥3` 时输出会标
   `nondeterministic_risk: true` 并在 `rip_fallback` 写明「不得作为验收证据」。
   门与回退的判定是**客观四键**（`lines/vias/comps/drc` 逐键比对），`revert_failed` 会写
   `revert_note` 指名哪个键不符；恢复走 undo + 每步重读，**不按目标态 snap**。
   `reverted: true` 是正常业务结果不是错误；`revert_failed: true` 才需要人工介入。
   人工只在自动回退失败时出手。
   **分轮循环中途抛错走同一条路**：任一契约调用（撕网/导出 DSN/布线/导入 SES）失败时，
   补丁已写回、前几轮已撕已布，代码会捕获异常 → `auto_revert()` → 结果里给 `error` +
   `error_round` + `reverted`（`--no-auto-revert` 时 `reverted=false` 且 message 明说
   「板面停在半途」）。已跑完的轮次保留在 `incremental.iterations`，不回退到看不见。
- **证据目录**：每次 confirm 在 `out/<verb>-<时间戳>/` 落 DSN/SES/pairs/回滚表与
   `transactions.jsonl`（写前事务日志：每进入一个改板面的步骤**先落一行再执行**，用于回退对账）与
   fastroute 报告；失败排查先看这里的 `fastroute-r*.json`（未布通明细）与
   `board-r*.dsn`（规则是否被提升）。
- **`revert_failed` 是「板面泄漏」，不是「实验失败」**。它意味着板子可能停在中间态，必须人工
   介入到**四键 + 五对 skew 全部复原**才算结束（只比 lines/drc 会漏，按目标态猜会误伤）。
   判定看三个数：`revert_attempts`（试了几次）、`revert_steps_effective`（真生效几次）、
   `revert_mode`；`snapshot` = 撤销栈已失效（进程被硬杀会打断撤销历史，此时连撤多次状态不动）。
   唯一可靠的兜底路径（实测）：`import_autolayout --file <快照>`（把元件位移归 0）→
   `route_external --fastroute --confirm` 重布 → **逐项复核五对 skew**。
- **写操作前的板面基线**：记录 `lines/vias/comps/drc` 四键。任何写后核对这四键，
   差异超出预期即 undo（走命令总线的路径**只回读走线数、不跑 DRC**，键盘回退才带 drc 读数；
   所以 `--via auto` 判中总线时不要拿 `drc` 当「撤销后没变化」的证据，DRC 要单独 `run_drc`）。
- **别信汇总数字，量原始坐标**：DRC 报 `Hole to Hole ×19` 时，逐对量过孔中心距才发现
   是重合孔（重复导入）而非间距不足。类别名会骗人，坐标不会。
- **扫仓一律 `git grep`，禁用 `xargs grep`**（实测近失事故）：`git ls-files | xargs grep ...`
   在这台 Git Bash 下会**吞结果**——曾把一处明明存在的绝对路径扫成"零命中"，差点据此报出
   「发布物扫描干净」的反向结论。同理，任何"扫描类"结论（密钥/绝对路径/禁止文件）都必须
   用 `git grep -n -I -E` 或 `grep -r` 复跑一遍再写进报告；**"没扫到"和"没有"是两件事**。
- **自证命令的扫描范围必须覆盖「承载错误的那个文件」**（实测事故 3 次）：本轮连续出现三种
   "验证本身有盲区"的形态 —— ① `xargs grep` 吞结果；② 正则匹配到自己（`grep "0\.117"` 写在
   被扫文件里）；③ 范围漏掉 CHANGELOG 自己（`grep scripts/ SKILL.md references/` 不含 CHANGELOG.md）。
   写自证命令时先问：**错误可能出现在哪个文件？那个文件在扫描集里吗？** 范围优先用
   `git grep <pat>`（全仓、跳过未跟踪、不受 shell 参数长度限制）。
- **写进文档的验证命令，必须先自证不命中**（实测事故）：`git grep -E "(C:|D:)[\\/]{1,2}(Users|Projects)"`
   会**匹配它自己写在本文档里的那一行**，于是"期望：无输出"永远不成立。一条看起来对、实际自证的
   命令**比没有验证更危险**——它要么让人误以为"已验证通过"，要么永远报错从而被忽略（狼来了）。
   做法：把关键字写成字符类（`Us[e]rs` / `Proj[e]cts`）让它不匹配自身，**写完再跑一次确认不报自己**。

## 布局规范约束（PCB Layout Guideline v0.1，2026-11-07）

> 规则包 `references/rules/pcb-layout.rules.json`：13 条 + 1 unresolved + 5 not_checkable + 3 deferred；
> 每条带 `evidence{anchor,hash}`，按 `sha256(该行原文)[:12]` 现场重算，文件路径见 `statute.path`；
> 原文**只在仓库内可读**（L4 隔离：guideline 正文不进分发包）⇒ 包内 `verify-pack` 须 `--allow-absent-statute`，会打印 `hash_verified=false`；`conformance` 退回 null。

三态：`pass=0` / `fail=2` / `unverified=3`（本脚本自有码表，与 `eda_verbs.py` 的 2/3 同号不同义）：

```bash
python scripts/board_geometry.py --role-map <映射表> --out out/geom-<hash>.json
python scripts/guideline_rules.py check --geometry out/geom-<hash>.json
```

**进相位先取该阶段子集（别整包读）**：`python scripts/guideline_rules.py brief --stage routing_width`
（阶段：`board_setup` `placement` `routing_width` `routing_clearance` `routing_via` `signoff`；每段硬上限 7 条）。
brief 顶部会点名**未答的板级决策**，对应规则按 `unverified` 处理；表里带「违反时改什么 / 例外 / 谁负责这个数」。

**四条硬纪律**：① `tracks=null` ⇒ `unverified`，`[]` ⇒ `pass`，不许合并；② `netclass` 未分类 ⇒ `unverified`；先 `--derive-roles`（按焊盘数，不看名字）出草案，**草案不得阻断**（`provisional` ⇒ 只诊断、不回退）；
③ 过孔只归类不判违规，`unclassified>0` ⇒ 整包至少 `unverified`；④ `severity: block` 授权来自本项目策略
（`authority.binding=project_policy`），statute 表头是「建议起始线宽/间距」，报告不得写成「规范强制」。

**接线到验收门（已落地）**：`relayout_route --guideline-geometry out/geom-<hash>.json [--guideline-ledger out/<proj>/compliance.jsonl]`
即启用第五键。`fail` 会把 `gate["pass"]` 置 False（现有自动回退随即接管）；`unverified`/`absent` 只告警、不阻断，且绝不冒充 `pass`。
**不传几何不会静默**：默认走 `absent` 分支（`GUIDELINE_ABSENT` 告警、出 `guideline` 键、不阻断）；确实不做判定须显式 `--allow-no-guideline`（留 `GUIDELINE_DISABLED` 痕迹）。

## 知识库检索（先查这里，别翻文件）

要定位「这件事该怎么做」，不要一页页翻 `references/`——一条命令同时打穿九个来源：

```bash
python scripts/lookup.py <关键词> [--kind verb,rule,check,hint,api,doc,dialog,skill,menu,cmd] [--limit N] [--json]
```

| `--kind` | 来源 | 命中给出什么 |
|---|---|---|
| `verb` | `capability-map.json` | 动词 id、通道序列、意图、回读判据；有对话框落点时一并给 `对话框 › 分组` 与规则键 |
| `rule` | `rules/pcb-layout.rules.json` | 阶段、该阶段的规则 id、适用前提 |
| `check` | `harness-contract.json` | 输出校验规则 id、代码、判据 |
| `hint` | `doc-hints.json` | 该动词的库预置兜底页与关键参数 |
| `api` | `lceda-api-index.json` | 模块、方法名、映射到的文档页 |
| `doc` | `doc-manifest.json` + `doc-sections.json` | 页面标题与存档路径（3553 页）+ **正文 H2–H6 小节标题与行号（9812 条）** + 该页 `scope`（这页讲什么） |
| `dialog` | `dialogs.json` | 对话框 › 左树路径 › 字段，附规则键（`config.Physics['Blind/Buried Via']`）与文档锚点 |
| `skill` | `SKILL.md` | 章节标题与行号 |
| `menu` | `context-menu.json` | 右键菜单项、上下文、候选 API、verdict/equivalence |
| `cmd` | `ui-command-surface.json` | 客户端命令 id → 总线主题 / rpcCall 方法（静态抽取） |

多个词默认 AND，全库零命中才放宽为 OR 并在结果头标 `[放宽]`，不静默换口径。每条命中都带「文件 + 字段」出处，没有出处的结论不许用。

**`doc` 命中有两种**：`badge` 为空的是**页面标题**命中（指向整页），`badge=小节` 的是**正文小节**命中（带 `路径:行号`）。查「某个设置在哪」时看小节——文档作者把对话框左树写成了小节标题（`design-design-rule.md` 的 间距/物理/平面/扩展… 就是设计规则对话框的 8 个分组）。小节索引由 `python scripts/lceda-doc-index.py sections` 生成，`verify` 会现场重扫比对页数/小节数。

页命中还带一行 `scope`（取该页 H2 标题拼成），用来分辨「在哪设」和「怎么放」：查「盲埋孔」时 `place-blind-buried-via.md` 的 scope 是「布线模式下放置盲埋孔」，`design-design-rule.md` 的是「规则管理/规则编辑/间距/物理/平面/扩展…」。**别只看标题就下结论**——同名页面讲的可能是另一件事。

要落到「第几个分组、哪个字段、对应哪个键」，用 `--kind dialog`：`dialogs.json` 记录 对话框 › 左树路径 › 字段，字段带 `rule_key`（如 `.blindVia.table[].startLayer`）与文档锚点。`--kind verb` 命中时也会把 `对话框 › 分组` 和规则键一并打出来。

**退出码就是判据**：`0` 有命中 / `1` 零命中 / `2` 用法错误。拿到 `1` 就停手换词或读手工路由表，**不要凭印象补一条指引**——检索不到不等于不存在，更不等于可以编。

```
$ python scripts/lookup.py 铺铜 --limit 1
[verb]  pour_create    verified
        能力  design-write
        通道  bridge → cdp
        意图  建铺铜框与缝合孔
        回读  铺铜框计数增加；过孔坐标序列等距
        → references/capability-map.json  verbs[pour_create]
```

命中不够细时再按出处打开原文件；完整用法表见 [references/routing.md](references/routing.md) 的「零、先用检索，再读表」。

## API 文档索引（立创 EDA 说明书 v3.2.x）

> API 用法不确定时先查 `references/lceda-api-index.md`（全量 420 个模块 / 2603 个方法页；重建须带 `--all-modules`）。
> 覆盖率按**四口径并列**报，数字取自同目录 `lceda-api-index.json` 的 `stats`（索引重出后须重取，
> 别拿旧数字当现状）：有「实际调用 → API 方法页」映射 107/124、有证据页 28/124、任一文档来源 115/124、
> 全无任何文档 9/124。**未建映射 ≠ 不需要**——四口径分开看，是因为「有方法页」和「有证据页」
> 是两种强度完全不同的证据，混成一个数会让人把「归档里有这页」当成「这个调用验过」。
> 四个分母都是 `stats.verbs_total`，所以**每加一批 verb 这四个分数都会变**；
> `tests/test_skill_verb_table.py` 把本行数字钉在 `stats` 上，不一致即红——想改数字先改索引，别反过来。
> 正文在 `docs/lceda-pro/v3.2.x/cn/api/reference/pro-api.<模块>.<方法>.md`，该目录 **不进分发包**（export-ignore）；
> 包内带着索引和它的上游台账 `references/doc-manifest.json`，所以索引在安装后的技能目录里也能现场校验指纹。

**别用对象反射现扫「这个 API 有没有」。** `eda.<命名空间>` 的方法挂在原型链上且**不可枚举**：
`Object.keys(eda.pcb_Layer)` 与 `for (const k in eda.pcb_Layer)` 都返回 **0 项**（`selectLayer`
明明能调），既不报错也不告警。按这个口径扫全仓，任何命名空间都会被判成「空」——
这是**静默假阴性**：扫出 0 条会被误读成「客户端没这个能力」，进而写出「本机不可用」的错误结论。
要枚举就按原型链逐层 `Object.getOwnPropertyNames` + `getPrototypeOf`（≤12 层，跳过 `constructor`），
**先看它是不是空壳。** `references/api-stubs.json` 记着客户端里 37 个空壳方法（20 个 `f(){return!1}`、17 个 `f(){}`，共 769 个函数）：`dmt_Project.deleteProject`、`pcb_Layer.getCurrentLayer`、`pcb_Drc.startRealTimeDrc`、`sch_Document.navigateToCoordinates` 都在里面。它们**调用不抛错、只返回 false/undefined**，所以「接口返回 false」经常不是「条件不满足」而是「压根没实现」。重新生成：`python scripts/surface_scan.py --stubs --stubs-out references/api-stubs.json`；`check_capability_map.py` 会对 entry 里引用空壳的 verb 报 `route.hits_stub`。

要枚举就跑 `python scripts/surface_scan.py --filter <关键词>`（按原型链逐层
`Object.getOwnPropertyNames`，深度上限 12，跳过 `constructor`；扫出 0 条时 exit 3 而不是静默成功）；
日常查「有没有」优先用索引，而不是反射。

## 右键菜单台账（UI ↔ API 的边界）

`references/context-menu.json` 记录各编辑器 / 选中态下**实测到的右键菜单项**、
它们的 API 映射证据，以及不可达上下文的卡点。上下文全集以台账的
`coverage.expected_ids` 为准（别写死数量）；结构契约见
`references/context-menu.schema.json`，护栏是 `scripts/check_context_menu.py`。

```bash
python scripts/check_context_menu.py                       # 0 error 才算台账没被写坏
python scripts/lookup.py <菜单名> --kind menu               # 按菜单名 / API 符号 / 上下文名查
python scripts/lookup.py 库面板 --kind menu                 # 不可达上下文：卡点 + 进入方式
python scripts/menu_equiv.py --selftest                     # 差分判据自检（不连客户端）
python -m pytest tests/test_context_menu.py tests/test_lookup_menu.py tests/test_menu_equiv.py -q --basetemp=<全新目录>
```

差分口径：`menu_equiv.py` 比的是 `diff(A,B)` 与 `diff(A,C)`（A=操作前、B=菜单后、C=候选 API 后）。
**两边都没测到变化时必须判 `inconclusive`（exit 2），不许判等价** —— `snapshot` 至今没有
视口 / 高亮读数（`dmt_EditorControl` 只有 zoom 设置器、`pcb_Net` 只有 highlightNet/unhighlightNet，
都没有 getter），视图类动作在三份快照上逐位相同，那只是测不出，不是等价。

**三条口径（写结论前必读）**

1. `verdict=found` 只表示**找到了候选 API**，不等于真机已证等价；等价性看
   `equivalence` —— 默认 `not-probed`，做过差分的写实：「交叉选择」是
   `different-effect`，图层栏「锁定」是 `same-effect`（唯一一条已证等价）。
   **`same-effect` 必须带 `equivalence_ref`** 指向 `w4_results` 里 `verdict=equivalent`
   的记录，检查器有 `item.same_effect_without_evidence` 硬门 —— 写个字符串不算证据。
   只有归档方法页的 `exact` 命中才配判 found —— `menu_paths` 命中不等于语义等价
   （反例：**画布**上下文里的菜单「锁定」锁的是图元，`pcb_Layer.lockLayer` 锁的是图层；
   图层栏行上的「锁定」才是锁该层，且已真机证等价）。
2. `verdict=none` 只表示三路静态证据（归档方法页 / `capability-map.menu_paths` /
   `data-test` 英文名）**找不到**，不等于客户端一定没有。
3. `captured=false` 的上下文 `items=[]` 是**诚实交代**，不是漏采；补齐要走真机枚举，
   且遵守《弹窗》一节的 `guard → 操作 → guard`。台账不因凑覆盖率编造菜单项。

完整的上下文表、缺口清单、不可达复核指引与复跑命令见 CHANGELOG 1.8.1 条所列报告
（草稿区不进分发包；包内以台账 JSON 为准）。
