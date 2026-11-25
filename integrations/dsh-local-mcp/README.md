# DSH 本地 MCP 集成（开发用）

把本仓库在 WSL 里构建出的 `dist/cli-mcp.mjs` 作为名为 `lceda` 的 MCP 服务接入 DeepSeek Harness（DSH），
省去在 DSH 设置里手填 MCP 表单。它只启动 MCP 服务，不启动嘉立创 EDA 客户端。

## 前提

- WSL2（Ubuntu）开发环境，Node.js ≥ 20.11 在 PATH 中（fnm 管理也可以）。
- 已构建产物：`pnpm install && pnpm build`，确认 `dist/cli-mcp.mjs` 存在。
- 本目录的 `cordis.patch.yml` 按本机路径写死为 `/mnt/d/projects/github/lceda-connect`；
  仓库在别处或 Node 不在 PATH 时，修改 `args`、`cwd`、`command`。

## 安装到 DSH profile

任选一种：

- 让 Agent 调用 `plugin_manager` 的 `install_bundle`，`target` 传本目录的绝对路径；
- 在 DSH 界面打开 Plugins → Add plugin，选择本目录。

安装后工具以 `mcp__lceda__*` 出现，可用 `mcp__lceda__lceda_info` 验证。
安装会写入当前 profile，重启后仍然生效；卸载用 `plugin_manager` 的 `remove_bundle`。

## 边界

- 默认加载全部工具集；只要离线工具时在 `args` 里追加 `--toolsets offline`。
- `cdp` / `bridge` / `eda` 等实时工具需要嘉立创 EDA 客户端在 Windows 上运行，
  且 WSL 能访问它的 CDP（默认 9222）或 Bridge（49620–49629）端口。
- 仓库移动、Node 版本或路径变化后，需要同步更新 `cordis.patch.yml` 并重装/重启 DSH。
- 这里只是开发便利设施，不随 npm 包发布，也不改变 `lceda-connect` 的运行时行为。
