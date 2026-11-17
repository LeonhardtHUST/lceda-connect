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

EasyEDA 官方 API skill 与官方客户端 CLI 文档的当前收录版本没有附带 LICENSE 文件。已有许可声明和来源事实分别保留在 [API 来源](assets/api-docs/SOURCE.md) 与 [CLI 文档来源](docs/vendor/easyeda-client-cli/SOURCE.md)；对这些实际第三方材料，公开分发前仍需核实上游授权。本项目的 GPL 选择不替代上游许可。
