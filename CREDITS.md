# Credits

感谢以下外部项目的作者和贡献者。本文件区分直接收录、设计参考与运行依赖，不把参考接口或调用公开 API 写成复制了实现。

自有仓库的拆分与合并不作为外部致谢。内部来源、提交基线和移植映射仍记在 [合并方案](docs/merge-plan.md) 及各目录的 SOURCE.md 中，便于维护。

## 收录或移植的外部内容

| 上游项目                                                                        | 本项目使用的内容                                                 | 收录位置与说明                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [easyeda/easyeda-eprj3-skill](https://github.com/easyeda/easyeda-eprj3-skill)   | 文件夹工程的记录模型、生成与校验脚本、模板、配方、文档和测试夹具 | 记录层、校验和网表移植到 `src/eprj3/`；原脚本作为 Node sidecar 保留。见 [移植映射](assets/skills/eprj3/SOURCE.md)，保留 [上游 MIT 许可](assets/sidecar/eprj3/LICENSE)。                                                                          |
| [easyeda/easyeda-api-skill](https://github.com/easyeda/easyeda-api-skill)       | AI Bridge 协议与服务、扩展 API 参考、格式文档和使用指南          | 服务按上游 `scripts/bridge-server.mjs` 移植到 `src/bridge/`；文档留在源码树 `assets/api-docs/` 与 `assets/skills/easyeda-api/`，默认 npm 包不收录。见 [API 来源](assets/api-docs/SOURCE.md) 与 [技能来源](assets/skills/easyeda-api/SOURCE.md)。 |
| [easyeda/easyeda-format-skill](https://github.com/easyeda/easyeda-format-skill) | JSON Schema、图元字段说明、示例、类型索引和格式变更记录          | 数据保留在 `assets/format/`，校验器重写为 TS。见 [来源说明](assets/format/SOURCE.md)，保留 [上游 MIT 许可](assets/skills/easyeda-format/LICENSE)。                                                                                               |
| [easyeda/easyeda-client-cli](https://github.com/easyeda/easyeda-client-cli)     | 官方客户端 CLI 的四篇说明文档                                    | 仅作官方工具的参考资料，未把文档所描述的功能当成本项目已实现能力。见 [来源说明](docs/vendor/easyeda-client-cli/SOURCE.md)。                                                                                                                      |

上表记录实际的第三方上游，不把本地自有 fork 作为另一项重复致谢。许可文本及待核实事项见 [第三方许可说明](THIRD_PARTY_NOTICES.md)。

## 分发范围与许可边界

默认 npm 包不包含 `assets/api-docs/`（含 `index.json` 检索索引）和 `assets/skills/easyeda-api/` 的原文，也不包含官方客户端 CLI 的文档副本（`docs/vendor/easyeda-client-cli/`）。离线检索只读取本机资料。装入 npm 包的用户需要离线 API 文档时，把 `LCEDA_CONNECT_ASSETS` 指向自备的同结构 assets 目录；格式校验使用的 `assets/format/` 等其余资产照常随包发布。

感谢 EasyEDA 的作者与贡献者。本项目的内置 Bridge 服务移植自 [easyeda-api-skill 的 `scripts/bridge-server.mjs`](https://github.com/easyeda/easyeda-api-skill/blob/002a39d6dc55ad138e784c788b5c220b5c191c70/scripts/bridge-server.mjs)，基于提交 `002a39d6`。该快照的 [`SKILL.md`](https://github.com/easyeda/easyeda-api-skill/blob/002a39d6dc55ad138e784c788b5c220b5c191c70/SKILL.md) 在 front matter 中声明 `license: MIT`，但没有独立的 LICENSE 文件；尚未核实这条声明是否也覆盖 Bridge 脚本。

## 继承的审查方法与文档规则

感谢 [chaser-star/dsh-eda-review](https://github.com/chaser-star/dsh-eda-review)（Copyright 2026 chaser-star，Apache-2.0）。工程解析模块经自有来源仓库继承了它的网表权威重建、语义 diff 和审查分级方法；[网表重建说明](assets/skills/project-analysis/references/netlist-rebuild.md) 与 [审查手册](assets/skills/project-analysis/references/review-playbook.md) 保留了相关规则。对应 TS 实现为独立移植或重写，未复制该上游的实现源码。

保留上游 [Apache-2.0 许可全文](assets/skills/project-analysis/LICENSE-APACHE-2.0) 和 [NOTICE](assets/skills/project-analysis/NOTICE)，具体继承关系见 [来源映射](assets/skills/project-analysis/SOURCE.md)。此项不因中间仓库属于自有账号而省略。

## 设计与接口参考

以下项目的借鉴关系记录于已收录的 [仿真参考项目审计](assets/skills/ngspice-sim/REFERENCE_PROJECTS.md)。这里保留实际的参考范围，不表示复制了这些项目的源码，也不表示相关实验能力已经完成真机验证。

| 项目                                                                                        | 借鉴范围                                                             |
| ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| [Qucs-S](https://github.com/ra3xdh/qucs_s)                                                  | 多求解器前端与可插拔后端的接口划分。                                 |
| [gerber2ems](https://github.com/antmicro/gerber2ems)                                        | 先裁剪局部区域再生成 EM 网格，以及端口标记的思路。                   |
| [pyems](https://github.com/matthuszagh/pyems)                                               | PCB 结构、几何参数、网格与端口的高层 API 组织。                      |
| [easyeda/eext-paden-integration](https://github.com/easyeda/eext-paden-integration)         | 从编辑器扩展提取 PCB 几何并交给外部计算的接口用法。                  |
| [easyeda/eext-netlist-explorer](https://github.com/easyeda/eext-netlist-explorer)           | 原理图网表 JSON、网络分组和拓扑数据契约的参考；未移植其实现。        |
| [easyeda/eext-kirouting-integration](https://github.com/easyeda/eext-kirouting-integration) | 外部引擎任务、进度回调与失败报告的边界；未引入其布线算法。           |
| [SPIKE](https://github.com/wayri/SPIKE)                                                     | 将实现、验证与实测相关性分开记录的工程纪律；只借鉴概念，未复制代码。 |

## 使用公开 API 的依赖与外部工具

| 项目                                                                         | 作用                                                                                         |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) | MCP 服务与客户端协议支持。                                                                   |
| [ws](https://github.com/websockets/ws)                                       | 内置 bridge 的 WebSocket 服务与集成测试。                                                    |
| [Zod](https://github.com/colinhacks/zod)                                     | MCP 工具参数定义和校验。                                                                     |
| [scikit-rf](https://github.com/scikit-rf/scikit-rf)                          | 可选 Python RF sidecar 调用 Network、VectorFitting 等公开 API；不内置其源码。                |
| [ngspice](https://ngspice.sourceforge.io/)                                   | 用户自行安装的 SPICE 求解器，本项目通过子进程调用，不随 npm 包分发。                         |
| [openEMS](https://github.com/thliebig/openEMS-Project)                       | 实验性 EM 桥接所面向的外部求解器；本项目生成输入脚本，不内置求解器。                         |
| [Xyce](https://github.com/Xyce/Xyce)                                         | Python sidecar 中的实验性外部求解器适配；不随 npm 包分发，不视为本项目已完成验证的生产后端。 |

依赖包遵循各自随包提供的许可证，本文件不替代它们的许可文本。

## 维护约定

- 无 remote 或明确属于 LeonhardtHUST 的自有合并仓库不单列致谢，其自有内容在本项目中统一采用 GPL-3.0-only，不另设旧许可约束。
- 自有 fork 中实际继承的第三方内容仍按第三方上游记录，保留需要随副本提供的版权和许可文本。
- 新增条目要写明项目链接、实际使用内容，以及直接收录、移植、设计参考或外部调用的区别；仅调研过、计划使用但尚未采用的项目不列作已使用。
- 不在其他文件重复维护完整致谢名单；许可证全文与技术来源记录分别保留在对应位置。
