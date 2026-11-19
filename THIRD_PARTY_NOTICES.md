# 第三方许可说明

本项目采用 GPL-3.0-only，全文见 [LICENSE](LICENSE)。外部项目的致谢和实际使用范围统一维护在 [CREDITS.md](CREDITS.md)。

## 自有内容

经所有者确认，无 remote 或明确属于 LeonhardtHUST 的自有合并仓库不作为第三方项目，不再单列致谢，也不要求在本仓库继续沿用其旧许可证。其中的自有部分在本项目中统一采用 GPL-3.0-only；目录里继承的第三方文档与规则不在这项旧许可豁免范围内。

各目录的 SOURCE.md 和 [合并方案](docs/merge-plan.md) 保留技术来源、提交基线与移植映射，用于维护追溯，不构成额外的第三方许可要求。原样保存的历史文档可能仍出现当时的许可字段；本段说明适用于其中的自有内容。

## 保留的第三方许可

- 自有 fork 中继承的第三方内容仍保留其实际作者的版权和授权条件，不因 fork 的所有者变化而被视为全部自有。
- `chaser-star/dsh-eda-review` 的方法与文档规则经工程解析来源仓库继承；保留 [Apache-2.0 全文](assets/skills/project-analysis/LICENSE-APACHE-2.0) 和 [上游 NOTICE](assets/skills/project-analysis/NOTICE)，版权为 Copyright 2026 chaser-star。
- eprj3 上游内容的 MIT 全文保留在 [对应 LICENSE](assets/sidecar/eprj3/LICENSE)。
- EasyEDA 格式文档与 Schema 的 MIT 全文保留在 [对应 LICENSE](assets/skills/easyeda-format/LICENSE)。
- 运行依赖的许可证由对应依赖包提供；外部求解器不随 npm 包分发。

## 尚待核实的外部材料

### easyeda-api-skill

- 上游：<https://github.com/easyeda/easyeda-api-skill>，收录快照 `002a39d6dc55ad138e784c788b5c220b5c191c70`。
- 该快照没有独立 LICENSE 文件，只有 `SKILL.md` 的 front matter 声明 `license: MIT`。这条声明只针对该文件，不足以说明整个上游仓库的文档、素材和脚本都按 MIT 授权。
- 本项目的内置 Bridge 服务（`src/bridge/`）由上游 `scripts/bridge-server.mjs` 移植而来，移植实现的许可范围仍需核对，不按独立实现处理。
- 上游的 API 参考、格式文档与 `SKILL.md` 原文留在源码树 `assets/api-docs/` 和 `assets/skills/easyeda-api/`，默认 npm 包不收录这两处及检索索引。来源与收录范围见 [API 来源](assets/api-docs/SOURCE.md) 和 [技能来源](assets/skills/easyeda-api/SOURCE.md)。公开分发前需要确认这些材料本身的授权；无法确认时保持排除。
- 本机需要这些文档时，可把 `LCEDA_CONNECT_ASSETS` 指向自备的同结构 assets 目录。该变量只改变运行时的读取位置，不改变许可状态。

### easyeda-client-cli

- 上游：<https://github.com/easyeda/easyeda-client-cli>，收录快照 `5452c638`。仓库 README 声称 Apache-2.0，但仓库内没有 LICENSE 文件。
- 这些文档只作官方工具参考保存在 `docs/vendor/easyeda-client-cli/`，不随 npm 包发布，来源见 [CLI 文档来源](docs/vendor/easyeda-client-cli/SOURCE.md)，引用前仍需核实授权。

### 发布边界

- 本项目采用 GPL-3.0-only。GPL 不能替代上游授权，也不会自动取得上述材料的再许可权。
- npm 发行版的对应源码和构建文件通过 [GitHub 版本标签](https://github.com/LeonhardtHUST/lceda-connect/tags) 提供。每次发包时，将版本标签固定在实际打包的提交上。
- 默认 npm 包不含 `assets/api-docs/`、`assets/skills/easyeda-api/` 和官方 CLI 文档副本；`assets/format/` 等随包资产不受影响。候选包尚未发布到 npm，实际状态以 registry 记录为准。
