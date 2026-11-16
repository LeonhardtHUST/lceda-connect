# 更新日志

本项目所有显著变更记录在此文件中。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本 2.0.0](https://semver.org/lang/zh-CN/)。

## [1.4.0] - 2026-10-22

### 新增

- REFERENCE 域新增 `THoleDef`（孔定义，`null` 表示无孔）：`holeType`（`ROUND` / `RECT` / `SLOT` / `ROUND_RECT`）、`width` / `height`（mil；`SLOT` 时 `width` 为槽长、`height` 为孔径，`ROUND` 时两者均为直径）、`cornerRadius`；同步补齐 `primitives/`、`examples/`、`types-index.md`、`documents/REFERENCE.md` 与 `validate.js` 映射
- 仿真设置 `NG_SETTING` 新增蒙特卡洛 `mcSetting` 与最坏情况 `wcSetting`（容差列表、基础分析、输出变量、预期范围 / 相位）；`currentSetting` 枚举扩为 `AC` / `DC` / `TR` / `MONTE CARLO` / `WORST CASE`；`trSetting` 新增 `calcDcBiasPoint`，AC / DC / TR 各增可选 `compatMode`
- 新增并注册到 `schemas/index.json`、`validate.js` 的相关类型：`TMCSetting`、`TWCSetting`、`TStatBaseAnalysis`、`TToleranceItem`、`TToleranceType`、`TToleranceDistribution`、`TExpectedRange`、`TExpectedPhase`、`TAcAnalysisType`、`TCompatMode`、`TCurrentSetting`

### 修复

- 修正层类型中文含义：`TOP_SOLDER_MASK` / `BOT_SOLDER_MASK` 为**阻焊**，`TOP_PASTE_MASK` / `BOT_PASTE_MASK` 为**助焊**（此前两者互换）
- PCB / FOOTPRINT `FILL` 补充槽孔语义：`layerId` 为 12（多层）的 FILL 即槽孔（Slot Region），盘上**没有**独立 `SLOT` 图元；无焊盘定位孔同样落为多层 FILL

### 变更

- 焊盘 `hole` 字段改链接到 `THoleDef`；`plated` 明确为区分 PTH / NPTH 的**唯一**字段（过孔无此字段、恒金属化）
- `fontFamily` 补充内置字体说明：`default` / `default2` / `Serif` / `Sans Serif` 只存字体名、不存字形路径，无需关联 FONT 文档（PCB 图元与尺寸标注同步）
- 属性键语义补充：`Unique ID` 为物理器件实例标识（多部件各元件须共用）；`Reuse Block` / `Group ID` / `Channel ID` 释义
- 原理图属性 `value` 新增 `~` 上划线（低电平 / 低有效）标记规则
- `PART` 新增多部件（多 PART）语义：`partId` 选取部件、`Multi-Part Group` 归组、位号显示为 `{位号}.{序号}`、同器件各元件共用 `Unique ID`
- 同步刷新 SCH_PAGE / SIMULATION / SYMBOL 三域的 `ng_setting`、`part` 文档与示例
- `package.json` 包名统一为 `easyeda-pro-format-skill`

## [1.3.0] - 2026-09-22

### 新增

- `validate.js` 支持 `--doc <docType>` 显式指定文档类型，支持整行格式（`{外层}||{内层}|`）直接校验；输出新增 `type` / `schema` 字段
- `validate.js` 新增一批 Schema 映射：`t-doc-uuid` 家族、`t-element-id` 家族、`e-layer-code` / `e-layer-type` / `e-panel-layer`、`t-layer-wire` 等

### 变更

- SKILL.md 重写核心章节：行终止符（LF）规则；最终一致性判优（判优键为「文档 + 归一化 id」，`type` 不参与；平票时 `client` 字典序大者胜，修正老文档的相反描述）；删除语义细节（`META` 不可空串删除、`DELETE_DOC` 载荷不可互换）；新增类型名与文档类型前缀对照表（`PCB_LINE` 前缀 / `--doc` / 裸名优先级）
- 修正 DOCHEAD 规则：外层仅 `type` + `ticket`（无 id），`client` / `uuid` 限定 16 位小写十六进制；CANVAS 仅存在于含画布的文档类型
- 全量刷新资料层：documents（15）、primitives（186）、examples（186）、schemas（136）及 types-index.md

## [1.2.1] - 2026-09-22

### 新增

- 新增 `format-updatelog.md`：中英双语的格式更新日志，首条为嘉立创EDA Pro V3（2025.10.21 规范）与 V4 格式的对比总结（文档头、docType、坐标单位、布尔/颜色编码、图元类型等 10 个主题）；后续格式大变更将补充新条目

## [1.2.0] - 2026-09-21

### 变更

- 完善双语 README 与 SKILL.md 的流程及格式说明（`bee647f`）
- 新增 Schema：`tmc-setting.json`、`twc-setting.json`，大幅扩充 `tng-setting.json`
- 更新 `types-index.md` 类型索引与 `validate.js` 类型映射
- 补充各领域文档层与图元层的详细描述，修正示例数据，新增 `t-pcb-x-nets-group` 等示例

## [1.1.0] - 2026-09-18

### 新增

- 新增 FONT 文档域：`documents/FONT.md` 与示例 `examples/FONT/tm-font.md`（`12a027e`）
- 扩充 SIMULATION、CONFIG 领域文档与示例（`e-setting-type` 等）
- 新增 `ty-axis-direction` 等 Schema

### 变更

- 全面刷新 `types-index.md`（中文名 → 类型名 → 文档路径索引）
- 大幅扩展 `validate.js` 校验逻辑
- 更新多个 JSON Schema（`t-sch-table`、`t-table-cell`、`tm-sch-component` 等）
- 修正 PCB / FOOTPRINT / SYMBOL 等领域大量示例数据的格式

## [1.0.1] - 2026-09-09

### 修复（`b2170ff`）

- 去重 7 个 Schema 中导致 Ajv 元校验失败的 `enum` / `required` 重复项：`t-panelize`、`e-panelize-version`、`version`、`ascii`、`tp-panel`、`tp-panel-lib`、`tp-simulation`
- `validate.js` 为 `ajv.compile()` 增加异常保护：Schema 非法时返回结构化错误而非崩溃
- `validate.js` 的 `TYPE_MAP` 补充缺失图元类型别名：`AUXLINE`、`FONT`、`PCB_*` / `PANEL_*` 域前缀、各文档类型的 META 行
- README 校验脚本示例恢复为与 SKILL.md 一致的用法

## [1.0.0] - 2026-09-09

### 首次发布（`b8b0efe`、`1ab893a`）

- 收录技能全量内容：`SKILL.md`、`types-index.md`、`documents/`（13 个领域）、`primitives/`、`examples/`、`schemas/`（252 个 JSON Schema）
- `validate.js` 格式验证脚本（基于 ajv），附 `package.json` 与 `.gitignore`
- 双语 README（简体中文 / English），MIT 许可证
