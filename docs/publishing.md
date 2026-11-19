# npm 发布与自动发布

目标包是 `lceda-connect`，registry 是 `https://registry.npmjs.org/`，源码见公开仓库 [LeonhardtHUST/lceda-connect](https://github.com/LeonhardtHUST/lceda-connect)。首次由维护者发布；后续由 GitHub Actions 用 OIDC 发布。

## 1. 检查首次发布的候选包

- npm tarball 不含 `assets/api-docs/`（包括检索索引）、`assets/skills/easyeda-api/` 和 `docs/vendor/easyeda-client-cli/` 的文档副本。打包后核对清单，确认 `assets/format/` 等运行时资产仍在包内。
- 内置 Bridge 服务的移植来源见 [CREDITS.md](../CREDITS.md)。上游快照 `002a39d` 没有独立 LICENSE，`SKILL.md` 声明 MIT，脚本的许可范围尚未核实。分发时按[第三方许可说明](../THIRD_PARTY_NOTICES.md)区分来源致谢和授权。
- 从干净、已审查的 Git 提交构建。用 `vX.Y.Z` 标签固定该提交，在公开仓库提供该版本的 GPL 对应源码和构建文件。发包前确认未登录的用户也能下载该标签的源码归档；不要只链接会继续变化的 `master` 分支。
- 候选包尚未发布到 npm。版本号、发布 workflow 和本文档就绪都不等于已经发布，实际状态以 registry 记录为准。
- 首发候选可以保留当前的 `0.1.0`。发行时再整理 [CHANGELOG](../CHANGELOG.md) 的待发布条目并记录实际发布日期。

在支持开发工具链的 Node.js 上执行：

```bash
pnpm install --frozen-lockfile
pnpm exec vp check
pnpm exec vp test
pnpm exec vp pack
npm pack --ignore-scripts --dry-run --json
npm pack --ignore-scripts
node scripts/smoke-npm-package.mjs ./lceda-connect-0.1.0.tgz
```

确认打包清单中的 `dist`、`assets`、文档和许可属于候选版本，没有凭据、运行态数据或测试工程；`assets/api-docs/index.json` 与 `assets/skills/easyeda-api/` 不在清单里，`assets/format/` 在清单里。冒烟脚本把本地 tarball 安装到新临时目录，禁用安装脚本，再用 npx 做 stdio 握手；安装运行依赖时可能访问 npm registry，但脚本不登录、不发布。版本变化后替换示例文件名。

## 2. 手工首发

仅在许可、源码和包内容都确认后，由维护者在终端登录。不要把密码、token 或验证码贴进对话或提交到仓库。

```bash
npm login --registry=https://registry.npmjs.org/
npm whoami --registry=https://registry.npmjs.org/
npm publish ./lceda-connect-0.1.0.tgz --ignore-scripts --access public --registry=https://registry.npmjs.org/
npm view lceda-connect@0.1.0 version --registry=https://registry.npmjs.org/
```

按 npm 提示完成双因素认证。直接发布上一步测试过的 tarball，避免重新打包。如果只执行准备阶段，到这里不要运行 `npm publish`。

## 3. 设置 GitHub 与 npm Trusted Publisher

1. 确认已授权的 [.github/workflows/publish.yml](../.github/workflows/publish.yml) 在 GitHub `master` 上，Actions 已启用。在 GitHub **Settings → Environments** 中创建 `npm-release`，限制为 `master`；保护 `master` 上的发布和 workflow 变更，有条件时配置部署审批人。GitHub 套餐可能限制私有仓库的部分保护规则。
2. 包首发成功后，打开 npmjs.com → Packages → `lceda-connect` → Settings → Trusted publishing → Add trusted publisher，选择 GitHub Actions。

| npm 字段                  | 值                                                              |
| ------------------------- | --------------------------------------------------------------- |
| Organization or user      | `LeonhardtHUST`                                                 |
| Repository                | `lceda-connect`                                                 |
| Workflow filename         | `publish.yml`（不加目录）                                       |
| Environment name          | `npm-release`                                                   |
| Allowed actions（若显示） | 允许 `npm publish`；只允许 `npm stage publish` 无法运行本工作流 |

3. 在 GitHub **Settings → Secrets and variables → Actions → Variables** 添加仓库变量 `NPM_RELEASE_ENABLED=true`。把候选提交流程准备好后再注册，npm 的新信任连接有首次成功发布时限（官方文档当前为两天）。不要添加 `NPM_TOKEN` 或 `NODE_AUTH_TOKEN` 发布密钥。发布 job 只用 GitHub-hosted runner 的 OIDC；Node 24 自带的 npm 会做 `11.5.1` 下限检查。
4. 验证首次 OIDC 发布后，按需在 npm 收紧包的 Publishing access，移除不再需要的旧发布 token。从本公开仓库通过 OIDC 发布公开包时，npm 会自动生成 provenance；维护者在本机手工首发不带这条证明。

参考：[npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers)、[npm provenance](https://docs.npmjs.com/generating-provenance-statements)、[GitHub OIDC](https://docs.github.com/en/actions/concepts/security/openid-connect)。

## 4. 后续发布

例如，首发 `0.1.0` 后，把 `package.json` 和更新日志改到新的稳定版本 `0.1.1`，使落到 `master` 的 HEAD 同时满足以下条件：

- 提交标题正好是 `chore(release): 发布 v0.1.1`。
- `package.json` 的版本与标题一致，且相对第一父提交严格递增；包名不变。用独立的版本提交，避免合并或变基改掉标题或把版本更新拆到上一提交。
- 先把对应源码标签（例如 `v0.1.1`）推到公开仓库，再推送 `master` 上的发布提交。标签和发布提交必须指向同一个提交；工作流不代建标签。
- npm registry 上该版本不存在。查询错误和重复版本都会阻止发布。

普通 push 只检查意图，不发布。符合条件的提交会跑检查、测试、构建和安装冒烟；开关关闭时也可验证候选包，但不会进入持有 `id-token: write` 的发布 job。启用后只发布已验收的同一个 tarball，下载后会再次校验 SHA-256。审批后在 Actions 看发布结果，再用 `npm view lceda-connect@0.1.1 version --registry=https://registry.npmjs.org/` 核验。GitHub 发布任务串行；等上一版本发布结束再提交下一版本，以免多个待发布任务互相挤占。
