# 路由规则与动词速查

本页是执行期唯一的路由依据。机器可读版本是同目录的 `capability-map.json`；两者冲突时以 JSON 为准。

## 零、先用检索，再读表

找不到该看哪一节时，先跑检索，别一页页翻文件：

```bash
python scripts/lookup.py <关键词> [--kind verb,rule,check,hint,api,doc,skill,menu] [--limit N] [--json]
```

一次打穿九个来源：

| `--kind` | 来源 | 命中给出什么 |
|---|---|---|
| `verb` | `capability-map.json` | 动词 id、通道序列、意图、回读判据 |
| `rule` | `rules/pcb-layout.rules.json` | 阶段、该阶段的规则 id、适用前提 |
| `check` | `harness-contract.json` | 输出校验规则 id、代码、判据 |
| `hint` | `doc-hints.json` | 该动词的库预置兜底页与关键参数 |
| `api` | `lceda-api-index.json` | 模块、方法名、映射到的文档页 |
| `doc` | `doc-manifest.json` + `doc-sections.json` | 文档页标题与存档路径、页内 H2–H6 小节标题与 `路径:行号`，以及该页 `scope`（这页讲什么，用来分辨「在哪设」和「怎么放」） |
| `dialog` | `dialogs.json` | 对话框 → 左树路径 → 字段，附规则键（`config.Physics['Blind/Buried Via']`）与文档锚点；查「这个设置在哪一页、对应哪个键」 |
| `skill` | `SKILL.md` | 章节标题与行号 |
| `menu` | `context-menu.json` | 右键菜单项、所属上下文、候选 API、verdict / equivalence；查不可达上下文时给出卡点与进入方式 |

`menu` 来源的口径单独记一句：`verdict=found` 只是「找到候选 API」，**不等于真机已证等价**（看 `equivalence`，目前全为 `not-probed`）；`verdict=none` 只是三路静态证据找不到，不等于客户端没有。别拿检索结果当等价性结论。

口径：多个词默认 AND；全库零命中才放宽为 OR，并在结果头标 `[放宽]`。每条命中都带「文件 + 字段」出处——没有出处的结论不许用。

退出码就是判据：`0` 有命中、`1` 零命中、`2` 用法错误。**拿到 `1` 就停手换词或读下面的表**，不要凭印象补一条指引：检索不到不等于不存在，更不等于可以编。

## 一、优先级元规则

| 编号 | 规则 | 判定 |
|---|---|---|
| R1 | 唯一通道可用 → 单路径 | 标注「无次选」，失败即走该项的降级列，不自行发明第三条路 |
| R2 | 双通道都已验证 → 官方 bridge 优先 | 理由：免重启、官方 API 面、权限背书；CDP 作次选 |
| R3 | 仅单侧验证 → 已验证侧优先 | 未验证侧标「一次最小验证后重排」，重排后按 R2 冻结 |
| R4 | 失败判据必须机器可判定 | 超时、退出码、返回结构缺字段、身份校验不符；禁止凭感觉切换 |
| R5 | 换路链最多两层 | 首选 → 次选 → 降级声明。涉及用户的降级必须先说明再执行 |

## 二、通道级失败信号

| 信号 | 含义 | 判定方式 |
|---|---|---|
| `B1` | bridge 不可用 | `/health` 无响应或 `service` 不是 `easyeda-bridge`；`edaConnected` 为假；`/execute` 超时或返回 `success: false` |
| `C1` | CDP 不可用 | 环境自检 `cdp-endpoint` 非 ready；脚本退出码 2/3/4/5；求值抛协议错误 |
| `C2` | CDP 端点消失但客户端还活着 | 上一步还能求值，现在 `/json/version` 不通、主进程 pid 变了（或 page target id 全变）。这是**客户端自重启**，不是故障：改运行模式、清缓存、导激活文件、升级都会触发。处置是等 + 重新发现，不是换通道。详见 CDP 技能仓的 `references/restart-and-relaunch.md` |
| `X1` | 文档上下文不符 | 当前文档类型与动词域不匹配。属于前置门，不是换路：先切文档，切不了就停 |

连续两次同类失败，本会话内把该通道标记为不可用，后续动词直接走次选；探测结果缓存 60 秒。

## 三、写操作闸口

任何写动词执行前，必须逐条说明并取得确认：

1. **对象**：改哪些图元、哪条规则、哪个层、哪个网络。
2. **影响**：会不会牵扯同网络对象、是否全局规则、预计新增段数与过孔数。
3. **回滚**：改前的值（规则整表备份、图元坐标、铺铜框 id），以及恢复步骤。

一次确认只对一次动作有效。未确认不执行，确认后执行完立即回读验证。

**绝对不做**：保存或覆盖工程、删除工程、上传工程数据、替用户登录、读凭据、点击下单类入口。

## 四、动词优先级表

图例：`✅` 路由已定；`🔬` 待一次最小验证后按 R3 重排；`—` 无次选。

本表只是**常用动词的路由摘要**，不是完整动词表：完整清单以同目录
`capability-map.json` 的 verbs 数组为准，两者冲突时以 JSON 为准（与文件开头声明一致）；
新增动词见 `SKILL.md` 的「## 动词速查」。

### 读侧

| 动词 | 首选 | 失败信号 | 次选 | 无次选时 |
|---|---|---|---|---|
| `open_project` | bridge：DMT 团队/文件夹枚举 → 打开工程 → 打开文档 | `B1` / 返回空 | 无 | 请用户手动打开，给出定位信息后继续 |
| `read_board_state` | bridge：PCB 图元与网络统计 | `B1` / `X1` | CDP：板子体检脚本 | 报告读不到并停止 |
| `run_drc` | bridge：DRC 带明细 | `B1` / `X1` / 返回非数组 | CDP：同名接口 | 停止 |
| `canvas_image` | CDP：纯画布出图 + 层可见性控制 | `C1` | 无 | 请用户截图后继续人审 |

### 写侧

| 动词 | 首选 | 失败信号 | 次选 | 无次选时 |
|---|---|---|---|---|
| `place_component`（原理图） | bridge：官方建元件接口 🔬 | `B1` / 超时 | CDP：快捷器件落位 + 坐标精修 | 停止 |
| `place_component`（PCB 移动） | bridge：异步图元改坐标 🔬 | `B1` | CDP：图元改坐标（已实证） | 停止 |
| `apply_design_rules` | CDP：网络级规则整表覆盖（已实证） | `C1` / 回读不一致 | bridge：同名接口 🔬 | 停止 |
| `add_keepout` | CDP：区域图元 + 规则类型数组（已实证） | `C1` / DRC 未出现预期违例 | bridge：同名接口 🔬 | 停止 |
| `route_net` | bridge：自动布线（可指定网络） | `B1` / 失败网络非空 | CDP：同名接口 | 报告失败网络清单 |
| `route_diffpair` | CDP：差分对全链路脚本 | 退出码 2/3/4/5 | 无 | 按退出码语义报告并停止 |
| `pour_create`（建框/打孔） | bridge：铺铜图元创建 + 过孔阵列 | `B1` | CDP：同名图元接口（已实证） | 停止 |
| `pour_rebuild`（重建灌注） | CDP：选中单块铺铜后走属性面板按钮的界面事件（唯一可靠） | `C1` / 灌注计数不变 | 无 | 请用户手动重建后回读复核 |
| `silk_annotate` | bridge：丝印文字创建 | `B1` / 回读字段不符 | CDP：同名接口（已实证） | 停止 |

### 验证侧

| 动词 | 首选 | 失败信号 | 次选 | 无次选时 |
|---|---|---|---|---|
| `aesthetic_lint` | CDP：美学检查脚本（A/B 类） | `C1` | bridge：读图元 + 内置断言子集 | 只跑 A 类并如实标注 |
| `render_review`（C 类） | CDP：出图 + 人工确认 | `C1` | 无 | 请用户自行截图 |
| `manufacture_export` | bridge：Gerber / BOM / 贴片 / 测试点 | `B1` | 无 | 给出菜单导出路径，用户手动 |

## 五、执行顺序

1. 跑环境自检，拿到通道状态；单通道就按单通道执行，不反复探测。
2. 查 `capability-map.json` 找到动词的优先序列。
3. `X1` 前置门：确认当前文档类型与动词域一致。
4. 写动词先过闸口；读动词直接执行。
5. 执行后回读：图元计数、字段值、DRC 增量；需要视觉判断时出图。
6. 按退出码或返回结构判定成功；失败按既定链路换路，链路走完仍失败则如实报告。
7. 把结果写进证据包：命令、返回、版本指纹、DRC 前后、画布图（如有）。

## 六、当前验证状态

> **状态一律以 `capability-map.json` 的 `status` 为准；本节是 2026-11-08 的对账快照。**
> 本节只做两件事：① 列出非 `verified` 的动词，并写清**缺的是哪一种证据**；② 把「`status` 已是
> `verified`、但归档里没有可复核凭据」的条目单独记账（证据债）。
> **其余 `verified` 动词的实测陈述不在这里复写**——证据在 JSON 的 `verification` 字段，抄一遍就是
> 第二份会各自漂移的副本。本节上一版正是抄本过期：把 `render_review` 写成 `declared`、把
> `route_diffpair` 写成「未验证」，而 JSON 里两者都已是 `verified`（后者有 2026-11-08 真板 44 段
> 布线证据）。条目数不写死，改 JSON 就重取。

**本节的动词清单与 `SKILL.md` 的 `declared-verbs` 标记块同源，但只有那个块有机械门禁**
（`scripts/sync_skill_verb_table.py --check`）。两处若不一致，**以标记块为准**，并补跑一次
`python scripts/sync_skill_verb_table.py` 后回来手改本节——本节是快照，块是现算。

### 6.1 非 verified 动词（勿当可直接执行的能力）

`scripts/validate_output.py` 挡**一切非 verified** 动词进 `steps[].realizes`（早期只挡 `partial`，
已收严）。唯一放行方式：`--allow-unverified <id>` 或环境变量 `ALLOW_UNVERIFIED_VERBS`，
且报告里必须写「未验证」。

<!-- BEGIN:routing-nonverified（由 scripts/sync_skill_verb_table.py 生成，勿手改） -->
| status | 动词 | 缺的是哪种证据（取 JSON 的 note/verification 首句，勿手改） |
|---|---|---|
| `declared` | `annotate_dimension` | 接口级（2026-11-08 分诊）：归档 pro-api.pcb_primitivedimension.create.… |
| `declared` | `import_pcb_changes_to_sch` | 本机未实测（blocked_by_risk）。这条改的是原理图↔PCB 一致性状态且部分变更不可撤销；更要紧的是它可能弹… |
| `declared` | `order_components_bom` | 故意未实测：该接口会真实生成下单资料并打开立创商城下单页（外部副作用，误触会在账号下留订单数据）。interactive… |
| `declared` | `switch_unit` | 边界：显示单位切换只有 UI 偏好（98 命名空间全扫，仅 sys_Unit 换算函数 + 只读 getFrontend… |
| `declared` | `switch_workspace` | 未实测（有意跳过）：切工作区会把整窗上下文（活动工程/文档/选区）整体切走，并行批次期间会打断其它 agent 正在跑的… |
| `partial` | `aesthetic_lint` | 判据 2026-11-10 变更：主判据是**包围盒相交**（text-over-pad，error），text-nea… |
| `partial` | `boolean_polygon_op` | 只算几何，写回要另调图元接口（本批未验证，别当已通）。实测只对「包含/相离」类用例精确：两多边形边界相交时 union/… |
| `partial` | `compare_designs` | 缺口：schematicComparison 只跑通「同一张图被拒」这一支，正向（两张不同原理图）未覆盖——本机没有第二… |
| `partial` | `convert_altium_lib_to_easyeda` | 缺口：本机**没有真实的 .SchLib 样本**，真库转换未验。已确认的坑：该接口不校验输入内容——4 字节伪造 .S… |
| `partial` | `create_lib_simulation_model` | 无回读通道：lib_SimulationModel.get() 在本机抛『错误：本接口仅私有化部署版本有效！』，sear… |
| `partial` | `edit_pcb_component_props` | 两条缺口 + 一条口径：(1) setState_OtherProperty 只落地字符串值 —— 同一批传入 {B4_… |
| `partial` | `export_lib_item_file` | 缺口：复用模块分支在本机被权限挡住（lib_Cbb.search() 能列出 C3193194-MP1476GTF-Z，… |
| `partial` | `import_sch_changes_to_pcb` | 三条缺口实测：① 首次 importChanges() 返回 true 但 PCB 器件数仍为 0，等 2.5s 再调一… |
| `partial` | `init_raytracer_engine` | 缺口（本机不可用/不可同步等待）：init() 30 s 内未 resolve，无法纳入同步流程；亦无法判定是「长时间加… |
| `partial` | `manage_lib_3d_model` | 本机 V4.1.78 上 lib_3DModel.create 是静默失败：STL 的 Blob 与 File 两种入参… |
| `partial` | `manage_lib_symbol` | 三个坑：① copy 对「刚 create 的空符号」返回 undefined 却真的生成副本——判定只能靠 searc… |
| `partial` | `manufacture_export` | 与 `export_gerber` 的分工：Gerber 压缩包由那条 verb 独占（86094 B zip / 15… |
| `partial` | `move_project_to_folder` | 缺口：只跑通「跨空间」这一种（个人空间工程 → 团队工作区文件夹），返回 true 但 folderUuid 回读仍为空… |
| `partial` | `navigate_pcb_view` | 缺口已补（2026-11-10）：`dmt_EditorControl.getCurrentRenderedAreaIm… |
| `partial` | `place_pcb_item_with_mouse` | 只实测了失败分支，成功分支故意没跑：一旦绑定成功，器件跟着鼠标走，必须人工点击或 ESC 才能收尾，会给后续操作留悬挂放… |
| `partial` | `query_pcb_primitives_in_region` | **真实板面上会抛错（2026-11-09 独立复核）**：原证据只在一张「2 个焊盘」的空白 PCB 上成立。在 ag… |
| `partial` | `read_layer_stackup` | **2026-11-13 结论（离线支路可读叠层，6 层已对上）**：离线 --from-file 支路读 .epro2… |
| `partial` | `save_file_to_disk` | **2026-11-12 结论（CLI 通道已能落盘）**：CLI `--ext-uuid eda` + saveFil… |
| `partial` | `select_active_layer` | 缺口：没有可用的回读信号——getCurrentLayer() 恒 undefined，getAllLayers() 只… |
| `partial` | `set_pcb_netlist` | 三条缺口：(1) 返回值 true 不代表网表有效 —— 传 NOT_A_NETLIST 也返回 true，只能靠 ge… |
| `partial` | `zoom_canvas` | 缺口/坑：① zoomTo 必须同时给 x、y、scaleRatio，缺 scaleRatio 会抛 TypeError… |
| `single-path` | `pour_rebuild` | **2026-11-10 真机：可用，且已走命令总线（不是模拟按键）。** 首选路径 = 在**编辑器 iframe 内… |
| `single-path` | `toggle_realtime_drc` | 缺口：三个接口都在实时方法表里（kind=function）但恒返回 false 且状态不翻转，属「接口在、能力不在」。… |
<!-- END:routing-nonverified -->

`single-path` 与 `declared` 的区别值得单独记：前者**已经能用**，只是换不了路；后者还停在
「签名接受」那一层。把这两档都写成「未验证」会抹掉「换不了路要提前告知用户」这个可操作差异。

### 6.2 证据债：`status = verified`，但 `verification` 字段为空

下表这些条目在 JSON 里是 `verified`，却没有 `verification` 记录——没有日期、没有路径、没有读数，
**无法从归档里复核**。`scripts/check_capability_map.py` 把它记为 **warning 而非 error**：证据债
是既有现实，用一次性变红来「治理」只会让人学会忽略红。

**2026-11-09 进展**：`apply_design_rules` / `pour_create` / `silk_annotate` 已补读数并移出本表
（见各自 `verification`）；`add_keepout` 只还清一半，仍列在下面。

| 动词 | 现状 | 还清要补什么 |
|---|---|---|
| `add_keepout` | **部分还清**：区域回读 `getState_RuleType` + 计数 +1 已补；DRC 预期违例未复现 | 区域内放越界铺铜后先灌注（`pcb_PrimitivePoured` 没有 rebuild 方法，只能走界面），再让 `pcb_Drc.check` 报出禁止区违例；CDP 目前找不到「重建铺铜区」按钮 |

**动手还债前先读这三条**，否则一改就红三处：

1. **G13 卡点**：`references/edges.json` 里有 6 条 `mapped=aligned` 的边 realizes 这 4 个动词
   （`ui.pcb.design-rule`；`ui.pcb.place-keepout` / `ui.pcb.place-constraint-region` /
   `ui.pcb.constraint-region-rules`；`machine.pcb.pour-create`；`machine.pcb.silk-annotate`）。
   G13 规定「partial verb 不得进 aligned/可执行路径」⇒ **直接降 partial 会把门禁打红**。
   两条合规路径：① 补 evidence 保持 verified；② 先把这 6 条的 `realizes` 摘掉，再降级。
2. **棘轮**：`tests/test_capability_map_schema.py` 的 `KNOWN_EVIDENCE_DEBT` 冻结了这 4 个 id，
   「零证据 verified 集合」必须与它相等。⇒ **补好一条必须在同批把该 id 从常量里删掉**，
   否则「已修复」也会红。
3. **标记块**：改完 `status` 立即跑 `python scripts/sync_skill_verb_table.py`，否则
   `SKILL.md` 与本节上方的非 verified 标记块会和 JSON 分叉。

**「证据债」与「未实测」不是一回事**，这一节存在的意义就是不让它们互相冒充：

- 证据债 = 「做了，但没留可复核的凭据」——要补的是**留证**；
- 未实测 = 「没做」——要补的是**做一遍**。

上一版把 `open_project`、`apply_design_rules`、`add_keepout`、`route_net`、`pour_create`、
`silk_annotate`、`place_component` 一起写成「仅干跑、未在真实板子上执行写入」。这句话现在被 JSON
反证了两头：这几条 `status` 都是 `verified`，其中 `route_net`、`place_component` 还有明确的实测
陈述（布线 4/4 布通；四态 `0 / 0 / 100.0 / 0`）——与「仅干跑」直接冲突。故本表**不复制那句旧结论**，
只把其中确实缺凭据的几条按证据债记账。

### 6.3 已被更正的旧断言（留痕，避免又被抄回去）

- `create_pcb_doc` 曾在 §6.1 记为 `declared`（当时三种上下文一律返回 `undefined`，判为
  `blocked_by_api`）。`0695912` 复核出真实写法：`createPcb()` **不传参**才建（传 boardName 静默
  失败），`deletePcb(uuid)` 可删 ⇒ 建-验-删闭环成立、已升 `verified`。教训：**同一方法的
  「参数错了」与「接口没有」长得一样**，都是返回 undefined 且不抛错。

- `place_designators` 曾在表里出现两行、「排版实测 17 件」。JSON 的 `verification` 是「排版实测
  **18/18**；写回逐件 `modify`（属性图元无批量接口，数组调用报 `t.isAsync is not a function`）」，
  表面上像是两处一致，实际是**同一件事被写了两遍、其中一遍数字是旧的**。现以 JSON 为准。
- `rollback` 的实测陈述是「位号 18 + 元件 18 恢复，误差 0.02 mil」；它与 `place_designators` 是
  **配对**的两条（先写后滚），任一条单独引用都会让人以为回滚只覆盖一种图元。

只测过干跑、或在支线通道上跑过的动作，结论一律写「未实测」或「未验证」，不要用「应该可以」
代替证据。补证的格式要求见 `SKILL.md` 的「证据规则」——「真机」要写成路径（文件 + 日期 + HEAD），
不是写成一个词。

### 6.4 实现面：本表不等于可执行面

`status` 回答「验到什么程度」，**不回答「本层有没有实现」**。查后者只有一条命令：

```bash
python scripts/eda_verbs.py list   # 每项带 implemented；只有 true 才有执行路径
```

- `implemented: false` ⇒ 要跑只能 `python scripts/bridge_client.py execute --code '<表达式>'` 手写，
  再按该 verb 的 `verification` / `verify` 手工判定；直接 `eda_verbs.py <verb>` 是 exit 3「未实现的动词」。
- `tests/test_verb_surface.py` 钉住：`list` 每项带 `implemented`、可执行集合 == `IMPLEMENTATIONS`
  ∪ `layout_verbs.HANDLERS`、每个可执行项都有 argparse 子命令。
- 只能走界面的能力（版本控制、工程历史、叠层结构、内电层、库文档历史）见 `SKILL.md` 的
  《实现面与不支持清单》一节，本节不复制那张表。
