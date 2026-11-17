# 第三方与来源声明

lceda-connect 合并了下列 9 个仓库的代码、数据与文档。下表记录合并时的提交、许可证和处置方式；更细的文件映射见各知识包目录（`assets/skills/<名称>/`、`assets/api-docs/`、`assets/format/`、`docs/vendor/easyeda-client-cli/`）中的 `SOURCE.md`。

| 源仓库                             | 合并时提交     | 许可证                                                                     | 处置方式                                                                  | 落点                                                                    |
| ---------------------------------- | -------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| leonskill-easyeda-connect          | `9b2593061ade` | MIT（LeonhardtHUST）                                                       | 动词层与 JS 载荷移植为 TS；SKILL 与台账作为 assets                        | `src/eda/`、`assets/skills/easyeda-connect/`                            |
| leonskill-easyeda-project-analysis | `aaeba4bca20b` | MIT（LeonhardtHUST）                                                       | 全量移植为 TS                                                             | `src/epro2/`、`assets/skills/project-analysis/`                         |
| leonskill-easyeda-cdp-connect      | `9720f0802793` | MIT（LeonhardtHUST）                                                       | 连接层移植为 TS；references 作为 assets                                   | `src/cdp/`、`assets/skills/cdp-connect/`                                |
| leonskill-easyeda-ngspice-sim      | `8c5c1cacf0e3` | MIT（LeonhardtHUST）                                                       | 仿真内核移植为 TS；数值与规则密集脚本作为 Python sidecar                  | `src/sim/`、`assets/sidecar/ngspice-sim/`、`assets/skills/ngspice-sim/` |
| easyeda-eprj3-skill                | `8ff62c549c81` | MIT                                                                        | 记录层、校验、网表移植为 TS；建工程与门禁脚本作为 Node sidecar            | `src/eprj3/`、`assets/sidecar/eprj3/`、`docs/eprj3/`                    |
| cubeone-mcp                        | `a36af98e6085` | MIT（LeonhardtHUST）                                                       | 业务（STM32CubeMX）与 EDA 无关，未搬代码；借鉴其 MCP 工程做法后用 TS 重写 | `src/mcp/`                                                              |
| easyeda-api-skill                  | `002a39d6dc55` | 仓库内无 LICENSE 文件；SKILL.md 声明 MIT，上游为 easyeda/easyeda-api-skill | bridge 服务移植为 TS；API 参考作为 assets                                 | `src/bridge/`、`src/apidocs/`、`assets/api-docs/`                       |
| easyeda-format-skill               | `4fcab1747d47` | MIT（EasyEDA）                                                             | Schema 与图元文档作为 assets；校验器用 TS 重写，不再依赖 ajv              | `src/format/`、`assets/format/`                                         |
| easyeda-client-cli                 | `5452c638fca8` | 仓库内无 LICENSE 文件；README 声称 Apache-2.0                              | 文档原样并入，作为参考                                                    | `docs/vendor/easyeda-client-cli/`                                       |

## 项目许可与第三方边界

本项目采用 GPL-3.0-only，许可证全文见 `LICENSE`。上表中的第三方内容保留其原始许可证、版权和归属；本项目的许可选择不改变上游的授权条件。

## 发布前待核实事项

- easyeda-api-skill 与 easyeda-client-cli 的原文来自嘉立创EDA 官方，仓库内没有 LICENSE 文件。发布 npm 包前需核实对应版本的授权并补全许可文本；不能以本项目采用 GPL 代替上游授权。
- ngspice-sim sidecar 中的 openEMS 相关脚本只生成脚本，不内置 openEMS（GPL-3.0），使用者需自行安装。
