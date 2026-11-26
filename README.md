# lceda-connect

嘉立创EDA专业版（EasyEDA Pro）的 MCP 服务与命令行工具。[npm 包](https://www.npmjs.com/package/lceda-connect)提供本机 stdio 入口，可用 `npx` 启动。它由 9 个仓库合并而来（外部项目致谢见 [CREDITS.md](CREDITS.md)，合并方案见 [docs/merge-plan.md](docs/merge-plan.md)）。

| 命令组      | 做什么                                                                                              |
| ----------- | --------------------------------------------------------------------------------------------------- |
| `cdp`       | 带调试端口启动客户端并管理实例；连上后可发现端点、列页面、求值、截图、切换文档                      |
| `bridge`    | AI Bridge 服务管理（守护、自动重启、日志、自检），内置服务端；可列窗口、在编辑器里执行 `eda.*` 代码 |
| `eda`       | 编辑器动词：双通道自检、读板、DRC、板指纹、自动布线、动词台账检索                                   |
| `extension` | [预检 `.eext`，在隔离的可见客户端安装和卸载](docs/extensions.md)（实验性，仅 CLI）                  |
| `api`       | 离线检索扩展 API 文档（422 篇参考，需本地文档数据）                                                 |
| `format`    | 文件格式类型检索、图元字段说明、记录校验、示例                                                      |
| `epro2`     | 离线解析 `.epro2` 工程：双侧网表、PCB 几何、一致性报告、两版对比                                    |
| `eprj3`     | 读取与校验 `.eprj3` 文件夹工程、导出网表，调用建工程与门禁脚本                                      |
| `sim`       | ngspice 仿真：网表生成、运行、raw 解析、指标、叠层估算、Touchstone                                  |
| `mcp`       | 以 stdio / Streamable HTTP 运行 MCP；`mcp host` 可在 WSL 里拉起 Windows 侧实例                      |
| `env`       | 执行环境自检：环境判定、客户端可执行文件、在线通道策略与配置来源                                    |

## Quick Start

### 1. 验证 npx 与 stdio MCP

使用 Node.js 20.11 或更新版本。工具清单和离线功能不需要启动 EDA。从 npm 直接运行：

```bash
npx -y lceda-connect mcp tools
```

把本地 MCP 接入客户端时使用：

```text
npx -y lceda-connect mcp
```

stdout 只用于 MCP JSON-RPC，启动日志写入 stderr。终端等待输入是正常的；配置客户端时不必另开终端常驻。默认加载全部工具（含 CDP、Bridge、EDA）；只在不需要编辑器、想减少工具数量时加 `--toolsets offline`。`offline` 仍包含本地写盘和仿真工具，不是沙箱。

若要从源码构建，需要 Node.js 22.18+（22.x）、24.11+（24.x）或 26+ 及 pnpm：

```bash
pnpm install --frozen-lockfile
pnpm exec vp pack
node dist/cli.mjs mcp tools
```

本地构建后，也可把下方客户端配置里的 `npx` 换成 `node`，参数换成 `["<仓库绝对路径>/dist/cli.mjs", "mcp"]`。完整的 tarball 检查见[发布手册](docs/publishing.md)。

### 1b. WSL2 / 跨 OS 客户端

MCP 进程和 EasyEDA 是否在同一网络命名空间，决定在线工具能不能用。两种跨 OS 方式（都需要先在 Windows 侧 `pnpm add -g lceda-connect` 或 `npm i -g lceda-connect`）：

```jsonc
// A. WSL 客户端 + stdio，MCP 实际跑在 Windows（推荐，live 工具直接可用）
{ "command": "npx", "args": ["-y", "lceda-connect", "mcp", "host"] }

// A2. 顺带确保 EasyEDA 在 9333 上带调试端口运行（不杀已有进程）
{ "command": "npx", "args": ["-y", "lceda-connect", "mcp", "host", "--start-client", "--port", "9333"] }

// B. Windows 常驻 Streamable HTTP，WSL 客户端连虚拟网卡地址
//    先在 Windows 执行：lceda-mcp http --host wsl --port 3939 --token my-secret
{ "type": "http", "url": "http://<宿主WSL网卡IP>:3939/mcp",
  "headers": { "Authorization": "Bearer my-secret" } }
```

`mcp host --print-config` 会打印可直接粘贴的配置。实测边界：Windows 上只绑 `127.0.0.1` 的服务，WSL NAT 里**连不上**（即使走宿主 IP）；跨 OS 必须绑 WSL 虚拟网卡地址或 `0.0.0.0`（后者暴露 LAN，不推荐）。细节与实测数据见 [docs/transports.md](docs/transports.md)。

### 2. Codex

Codex CLI 支持直接添加 stdio MCP。`--` 后面的内容原样传给服务器：

```bash
codex mcp add lceda -- npx -y lceda-connect mcp
codex mcp list
```

只加载离线工具：

```bash
codex mcp add lceda-offline -- npx -y lceda-connect mcp --toolsets offline
```

在 Codex Desktop (ChatGPT Desktop) 也可通过 MCP 设置添加本地服务，或编辑 `~/.codex/config.toml`（自定义 `CODEX_HOME` 时使用对应目录）：

```toml
[mcp_servers.lceda]
command = "npx"
args = ["-y", "lceda-connect", "mcp"]
```

CLI 与 TOML 选一种方式配置同名服务即可。不要把 `LCEDA_BRIDGE_TOKEN` 写进项目文件。

### 3. Codex Desktop (ChatGPT Desktop)

配置方式与上一节相同：在 MCP 设置添加本地 stdio 服务，或编辑 `~/.codex/config.toml`。

### 4. DeepSeek Harness

在 DeepSeek Harness Desktop / Web 的设置中打开 MCP 管理，新增服务：名称 `lceda`，Transport `stdio`，Command `npx`，Args 一行一个：

```yaml
args:
  - -y
  - lceda-connect
  - mcp
```

默认加载全部工具（含 CDP、Bridge、EDA）。只在不需要编辑器、想减少工具数量时追加：

```yaml
args:
  - -y
  - lceda-connect
  - mcp
  - --toolsets
  - offline
```

保存后查看连接状态，并调用 `mcp__lceda__lceda_info`。如果通过组合文件配置而非界面操作，见[配置进阶](docs/quickstart.md)。

### 5. Claude Code

Claude Code 的 stdio MCP 使用 `claude mcp add`：

```bash
claude mcp add --transport stdio lceda -- npx -y lceda-connect mcp
claude mcp list
claude mcp get lceda
```

只在当前项目启用：

```bash
claude mcp add --scope project --transport stdio lceda -- npx -y lceda-connect mcp
```

也可以在项目根目录创建 `.mcp.json`：

```json
{
  "mcpServers": {
    "lceda": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "lceda-connect", "mcp"]
    }
  }
}
```

已有 `.mcp.json` 或客户端指定的 `mcp.json` 时，把 `lceda` 条目合并到原有 `mcpServers` 下，不要覆盖其他服务。文件名和外层结构以客户端要求为准（Claude Code 的项目文件名有前导点）。在 Claude Code 中运行 `/mcp` 检查连接，首次使用项目配置时按提示审查并批准。不要在共享配置里保存 token。

参见 [Claude Code MCP 文档](https://code.claude.com/docs/en/mcp.md)及[配置进阶](docs/quickstart.md)中的 Windows 启动说明。

## MCP 服务

全局安装后也可以直接写 `"command": "lceda-mcp"`。不做全局安装时，等价的独立入口是 `npx --yes --package=lceda-connect -- lceda-mcp`，同样接受 `--toolsets`。工具清单用 `lceda-connect mcp tools`。接口约定：

- 写操作（在编辑器里执行代码、自动布线、建工程、调用外部脚本）默认不执行，要传 `confirm: true`。`cdp_eval` 只放行能确认为只读的表达式（如 `getX` / `listX` 一类查询调用和普通 DOM 读取），其余都要 `confirm: true`；旧参数 `allowSideEffects` 作为弃用别名保留。
- 返回对象的工具同时给出 `structuredContent`。
- 单个结果超过 64 KiB 时，完整内容写到 `<LCEDA_CONNECT_HOME 或 ~/.lceda-connect>/results/`（保留最近 50 个），工具返回一份合法 JSON 摘要（含原始大小、预览和 `resultUri`）加一条 `resource_link`，用 `lceda://results/{id}` 读回完整内容。声明了输出 schema 的工具超限时报 `RESULT_TOO_LARGE`。大产物仍建议用 `outDir` 落盘。
- 随包发布的 SKILL.md 与 references 以 `lceda://skills/{+path}` 资源模板提供，也可用 `skill_docs` 工具读取。
- 写路径只允许在客户端声明的 roots、`LCEDA_ALLOWED_ROOTS` 和默认根（当前目录、系统临时目录、connect home）之内，越界报 `PATH_NOT_ALLOWED`。读路径不受限制。
- 支持请求取消（报 `CANCELLED`）；`sim_run`、`eprj3_gates` 等长任务会发送进度通知。
- 传输模式：stdio（默认）、Streamable HTTP（`lceda-mcp http --host 127.0.0.1 --port 3939`，默认只绑回环）、WSL→Windows stdio（`lceda-connect mcp host`）。HTTP 支持 Bearer token、`/health` 与 `--stateless`；详见 [docs/transports.md](docs/transports.md)。
- 工具集可裁剪：`lceda-connect mcp --toolsets offline,eda`，或设置 `LCEDA_TOOLSETS`。可选 `core` / `offline` / `live`，以及 `cdp`、`bridge`、`eda`、`api`、`format`、`epro2`、`eprj3`、`sim`；`core` 总是保留。

## 执行环境（Windows / WSL2 / Linux / macOS）

在线工具（CDP、bridge）要求 MCP 与客户端在同一个网络命名空间。工具启动时只读地判定环境，并据此决定探测地址与失败的下一步：

```bash
lceda-connect env            # 环境、客户端路径、通道策略、配置来源
lceda-connect env --json     # 给脚本；含证据与 warnings
```

- 环境：`windows-native` / `wsl2` / `linux-native` / `macos-native`。默认自动发现；`--env wsl2` 等显式值会跳过发现。
- WSL2 再区分客户端在 Windows 宿主（`host`，默认）还是 WSL 虚拟机（`vm`），`--lceda-in vm,host` 的顺序就是优先级。
- 客户端路径自动发现：Windows 注册的安装目录与 PATH；WSL2 + host 会扫描 `/mnt/<盘>/...`，也可直接传 Windows 路径（自动转换）。显式 `--exe` 找不到时不会悄悄回退。
- 配置优先级：**显式参数 > 配置文件 > `.env` > 环境变量 > 默认**。`--config`、`--env-file` 对 MCP stdio 同样生效。
- WSL2 NAT + 客户端在宿主：bridge 与 Windows 回环不互通，会报 `cross_os_loopback`。推荐在 Windows 侧运行 MCP，或启用 WSL mirrored 网络，或把客户端装进 WSL VM。`cdp start` 在该组合下直接退出码 2，不会空等 60 秒。

完整模型、配置文件 schema、策略矩阵与排查表见 [docs/environments.md](docs/environments.md)。

## 离线 API 文档与 assets

`api` 命令和 `api_*` MCP 工具读取 `assets/api-docs/` 下的索引与原文。这份材料来自 easyeda/easyeda-api-skill。npm 包不收录 `assets/api-docs/`、`assets/skills/easyeda-api/` 或官方客户端 CLI 的参考文档。

只安装 npm 包时，API 文档检索没有数据可用：CLI 会提示缺少文档数据，MCP 工具清单按可用数据调整。要用这项能力，把 `LCEDA_CONNECT_ASSETS` 指向自备的 assets 目录，例如源码仓库的 `assets/`，或用自备资料生成同结构目录后运行 `node scripts/build-api-index.ts` 重建索引。格式校验与 `assets/format/` 不受影响。

上游的许可状态见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)，源码树里的收录范围见 `assets/api-docs/SOURCE.md` 和 `assets/skills/easyeda-api/SOURCE.md`。npm 包的实际发布状态以 registry 记录为准，仓库里的版本号不代表已经发布。

## 安全模型

bridge 能在编辑器里执行任意 `eda.*` 代码，所以默认只信任本机上拿到 token 的调用方：

- 只接受回环 Host（`127.0.0.1`、`localhost`、`[::1]`），其他 Host 返回 421。
- agent 端（`/execute`、`/eda-windows`、`/eda-windows/select`，以及 `/eda` 以外的 WebSocket）带 `Origin` 的请求默认返回 403，浏览器页面因此不能直接调用。确需放行的来源写进 `LCEDA_BRIDGE_ALLOWED_ORIGINS`（逗号分隔）。`/eda` 是扩展端，允许无 Origin、本机地址、官方域名及桌面应用自定义协议，但拒绝 `Origin: null`（沙箱 iframe 和 data 页面可能使用它）。依赖 null Origin 的旧扩展需要调整连接方式，不能通过来源白名单解除此限制。
- agent 端还要带请求头 `X-Lceda-Bridge-Token`（WebSocket 也可用 `?token=`），缺失或不对返回 401。服务启动时生成 token，写到 `LCEDA_BRIDGE_RUNTIME`（默认 `%LOCALAPPDATA%\lceda-bridge`）下的 `token-<端口>.txt`；也可以用 `LCEDA_BRIDGE_TOKEN` 指定。`/health` 不需要 token。
- 本工具的 CLI 和 MCP 客户端会自动读取 token 文件；token 无效时报 `BRIDGE_UNAUTHORIZED`。
- 旧的外部脚本（比如直接 POST `/execute` 的 Python）要么带上 token，要么在启动 bridge 的环境里设 `LCEDA_BRIDGE_AUTH=off` 关闭校验。关闭后仍保留 Host 与 Origin 检查。
- 上限：请求体 4 MiB，`code` 1 MiB（超出返回 413），WebSocket 单帧 16 MiB，待决请求 64 个（满了返回 503）。
- MCP 的写路径限制用于防误写，不是操作系统沙箱。`LCEDA_ALLOWED_ROOTS=*` 可关闭限制。任意代码执行、ngspice deck、生成器与 sidecar 仍以当前用户权限运行，只应执行可信内容；它们自己的文件访问不受 `outDir` 校验隔离。`confirm: true` 由调用方提供，也不代替客户端的人工审批。
- 超限结果归档保存完整原文，不自动脱敏，可能含工程数据或凭据。POSIX 新目录/文件以 0700/0600 创建，Windows 继承用户目录 ACL；不要把运行态目录放在共享目录，敏感结果用完后自行清理。
- 子进程超时或被取消时会清理整棵进程树，每路输出上限 8 MiB。Python 自动探测会跳过 `.bat` / `.cmd` 壳；显式指定批处理文件时，含 shell 元字符的参数会被拒绝。

## 命令行安装

无需全局安装也能运行命令：

```bash
npx lceda-connect cdp start
# 或者用 vite-plus 的等价物
vpx lceda-connect bridge status --json
```

想常用就装全局（推荐，守护进程会绑定到全局安装路径，不会被 npx 缓存清理带走）：

```bash
npm i -g lceda-connect
lceda-cdp start
lceda-bridge status
```

## Windows：连接 EasyEDA Pro

下面使用全局安装提供的快捷命令。离线解析不需要本节的步骤。

```bash
# 1. 带 CDP 端口启动客户端，并等到端点就绪
lceda-cdp start
# → 端点就绪：http://127.0.0.1:9222
# → Browser：EasyEDA Pro/1.x.x

# 2. 拿端点给自动化脚本 / Agent 用
lceda-cdp endpoint                 # 两行：HTTP 端点 + WebSocket 地址
lceda-cdp status --json            # 结构化状态

# 3. 启动 AI Bridge（后台隐藏运行，崩溃 3 秒自动重启）
lceda-bridge start
lceda-bridge status
lceda-bridge logs --follow

# 4. 收工
lceda-cdp stop --yes
lceda-bridge stop
```

在 WSL2 里运行 MCP 时，先看 [执行环境](docs/environments.md)：客户端默认在 Windows 宿主，`bridge` 跨命名空间不可达，推荐把 MCP 放到 Windows 侧运行。

## 命令参考

### `lceda-cdp <动作>` / `lceda-connect cdp <动作>`

| 动作       | 说明                                                          | 退出码                  |
| ---------- | ------------------------------------------------------------- | ----------------------- |
| `start`    | 带 `--remote-debugging-port` 启动客户端，最多等 60 秒端点就绪 | 0 成功 / 1 失败         |
| `ensure`   | 自愈入口：没进程就起；有进程就等 30 秒端点并诊断              | 0 成功 / 2 端点不可用   |
| `status`   | 受管实例 + 端点状态（默认动作）                               | 恒为 0                  |
| `endpoint` | 只打印端点 URL 与 WebSocket 地址                              | 0 / 2 无端点            |
| `stop`     | 结束受管实例（必须显式 `--yes`）                              | 0 / 1 停不掉 / 2 未确认 |

`start` 的行为细节：

- `--remote-debugging-port` 放在首位，以兼容只透传首个参数的客户端自重启。为兼容不识别 `--remote-debugging-address` 的客户端（如嘉立创 EDA 4.1.105），CLI 不传该参数；显式指定的 `--proxy-server` 仍排在端口之后。
- CLI 通过 `127.0.0.1` 探测端点，客户端的实际监听地址由 Chromium 决定。端点能连通不代表它只监听回环；请用系统监听表检查该端口的全部监听地址。若有非回环监听，请停止本次调试会话，不要做端口转发。
- 默认清掉继承来的 `http_proxy` / `https_proxy` / `all_proxy` / `ftp_proxy` / `no_proxy`，让客户端回到「按 Windows 系统代理走」这一条可解释路径（否则会去连某个终端专用的沙箱代理，表现为白屏 30~80 秒）。要保留就加 `--keep-proxy-env`。
- 启动前先探 `pro.lceda.cn`：网络没通会警告，`--wait-online N` 可以等最多 N 秒。
- 客户端是单实例的：已有实例时新启动的参数会被转交并丢弃，因此默认拒绝，确需并行要 `--force`（两个实例会争抢同一份数据）。
- 启动后自动校准 pid：Electron 的启动器进程可能 fork 后退出，pid 文件会被改写成真正持有窗口的主进程。

对已运行的指定 PCB 页面，可用 `cdp input` / MCP `cdp_input` 定向派发点击、按键或文本。它不会自动拉前台，也不回退到系统键鼠。见[使用条件与验收方法](docs/cdp-input.md)。

### `lceda-bridge <动作>` / `lceda-connect bridge <动作>`

| 动作      | 说明                                                                     |
| --------- | ------------------------------------------------------------------------ |
| `start`   | 后台隐藏启动 bridge（守护进程，崩溃 3 秒后自动重启）                     |
| `stop`    | 停止（先杀外层再杀 node，最后兜底扫端口）；别名 `kill`                   |
| `restart` | `stop` + `start`                                                         |
| `status`  | 状态（默认动作）；别名 `st` / `health`                                   |
| `logs`    | 看日志，`--lines N` 指定行数，`--follow` 实时跟随；别名 `log`            |
| `doctor`  | 环境自检：node 候选、服务脚本、`ws` 依赖、端口占用；别名 `check` / `env` |
| `run`     | 前台运行（调试用，Ctrl+C 停止）                                          |
| `help`    | 帮助                                                                     |

服务契约（与 `bridge-server.mjs` 一致）：端口区间 `49620-49629`，健康检查 `GET /health` 返回 `service: "easyeda-bridge"`，日志 `%LOCALAPPDATA%\lceda-bridge\bridge.log`（超过 5 MB 滚存为 `.1`），状态 `state.json` 记录守护进程 pid / node / 脚本 / 启动时间。

找不到外部 `bridge-server.mjs` 时，`start` / `run` 会改用随包发布的内置服务 `dist/cli-bridge-server.mjs`，协议与原脚本一致，不需要另装 `ws`。

### 其他命令组

每个命令组都带 `--help`，并支持 `--json`：

```bash
lceda-connect cdp eval --expr "document.title"      # 连到已开调试端口的客户端
lceda-connect bridge exec --code "return await eda.dmt_Project.getCurrentProjectInfo()"
lceda-connect eda status                            # bridge / CDP 两条通道是否可用
lceda-connect api search pcb_PrimitiveVia.create
lceda-connect format validate --doc PCB VIA '{"x":0,"y":0}'
lceda-connect epro2 analyze board.epro2 --out ./eda-out
lceda-connect eprj3 validate ./my-project
lceda-connect sim run deck.cir --mode tran --out ./sim-out
```

### 通用选项

| 选项                   | 适用             | 说明                                                                |
| ---------------------- | ---------------- | ------------------------------------------------------------------- |
| `--json`               | 两者             | 只输出 JSON，便于脚本与 Agent 解析                                  |
| `--help`, `-h`         | 两者             | 帮助                                                                |
| `--version`, `-v`      | 两者             | 版本                                                                |
| `--exe <PATH>`         | cdp              | 客户端主程序路径（默认 `D:\Program Files\lceda-pro\lceda-pro.exe`） |
| `--port <PORT>`        | cdp              | CDP 调试端口（默认 9222）                                           |
| `--yes`, `-y`          | cdp stop         | 确认结束进程                                                        |
| `--force`              | cdp start        | 已有实例仍强制启动                                                  |
| `--proxy-server <URL>` | cdp start        | 显式代理，如 `http://127.0.0.1:7897`                                |
| `--wait-online <N>`    | cdp start        | 启动前最多等 N 秒网络就绪                                           |
| `--keep-proxy-env`     | cdp start        | 保留继承的代理环境变量                                              |
| `--lines`, `-n <N>`    | bridge logs      | 显示最近 N 行（默认 40）                                            |
| `--follow`             | bridge logs      | 实时跟随                                                            |
| `--once`               | bridge start/run | 崩溃不自动重启                                                      |
| `--node <PATH>`        | bridge           | 指定 `node.exe`（等价 `LCEDA_NODE`）                                |
| `--script <PATH>`      | bridge           | 指定 `bridge-server.mjs`（等价 `LCEDA_BRIDGE_SCRIPT`）              |

## 环境变量

| 变量                   | 作用                                             | 默认值                         |
| ---------------------- | ------------------------------------------------ | ------------------------------ |
| `LCEDA_PRO_EXE`        | 客户端主程序路径（WSL2 下可传 Windows 路径）     | 自动发现；找不到时用历史默认值 |
| `LCEDA_ENV`            | 显式执行环境（跳过自动发现）                     | 自动发现                       |
| `LCEDA_LEDA_IN`        | WSL2 客户端位置优先级：`host` / `vm` / `vm,host` | `host`                         |
| `LCEDA_WINDOWS_HOST`   | WSL2 下 Windows 宿主地址                         | 默认网关                       |
| `LCEDA_CDP_HOST`       | CDP 探测地址（覆盖环境推导）                     | 环境推导                       |
| `LCEDA_BRIDGE_HOST`    | bridge 探测地址                                  | `127.0.0.1`                    |
| `LCEDA_CONFIG`         | 配置文件路径（等价 `--config`）                  | 无                             |
| `LCEDA_ENV_FILE`       | `.env` 路径（等价 `--env-file`）                 | 无                             |
| `LCEDA_CDP_PORT`       | CDP 调试端口                                     | `9222`                         |
| `LCEDA_CONNECT_HOME`   | CDP 运行态根目录                                 | `~/.lceda-connect`             |
| `LCEDA_NODE`           | 指定 node.exe，跳过自动探测                      | 自动探测                       |
| `LCEDA_BRIDGE_SCRIPT`  | 指定 `bridge-server.mjs`                         | 自动探测                       |
| `LCEDA_BRIDGE_RUNTIME` | bridge 运行态目录                                | `%LOCALAPPDATA%\lceda-bridge`  |
| `EASYEDA_CDP_TIMEOUT`  | CDP 单次调用超时（秒）                           | `20`                           |
| `NGSPICE_BIN`          | ngspice 可执行文件                               | 自动探测                       |
| `LCEDA_PYTHON`         | sidecar 使用的 Python                            | 自动探测                       |
| `LCEDA_CONNECT_ASSETS` | 覆盖 assets 目录（可指向自备的 API 文档数据）    | 包内 `assets/`                 |

bridge 与 MCP 的安全相关变量（详见「安全模型」）：

| 变量                           | 作用                                                     | 默认值                          |
| ------------------------------ | -------------------------------------------------------- | ------------------------------- |
| `LCEDA_BRIDGE_TOKEN`           | 指定 agent 端 token                                      | 启动时随机生成                  |
| `LCEDA_BRIDGE_AUTH`            | 设为 `off` 关闭 token 校验                               | 开启校验                        |
| `LCEDA_BRIDGE_ALLOWED_ORIGINS` | 放行的 agent 端 Origin，逗号分隔                         | 空（带 Origin 一律拒绝）        |
| `LCEDA_ALLOWED_ROOTS`          | MCP 额外允许写入的根目录，按系统路径分隔符分隔；`*` 不限 | 空（只用客户端 roots 与默认根） |
| `LCEDA_TOOLSETS`               | MCP 工具集，等价 `mcp --toolsets`                        | 全部                            |

优先级：命令行参数 > 配置文件 > `.env`（只补未设置的键）> 环境变量 > 内置默认值。详见 [docs/environments.md](docs/environments.md#3-配置优先级)。

## 从旧脚本迁移

| 旧入口                                                            | 新命令                                    |
| ----------------------------------------------------------------- | ----------------------------------------- |
| `嘉立创EDA(带CDP).cmd`（调用 `~/.lceda-cdp/lceda-cdp.ps1 start`） | `lceda-cdp start`                         |
| `lceda-cdp.ps1 ensure`                                            | `lceda-cdp ensure`                        |
| `lceda-cdp.ps1 status` / `endpoint`                               | `lceda-cdp status` / `lceda-cdp endpoint` |
| `lceda-cdp.ps1 stop -Yes`                                         | `lceda-cdp stop --yes`                    |
| `lceda-bridge.cmd start`                                          | `lceda-bridge start`                      |
| `lceda-bridge.cmd status -Json`                                   | `lceda-bridge status --json`              |
| `lceda-bridge.cmd logs -Follow`                                   | `lceda-bridge logs --follow`              |
| `lceda-bridge.cmd doctor`                                         | `lceda-bridge doctor`                     |

旧的 PowerShell 开关写法仍然兼容：`-Json` / `-Lines 40` / `-Follow` / `-Once` / `-Yes` 与 `--json` 等价。旧 pid 文件（`~/.lceda-cdp/lceda-cdp.pid`）会被只读识别，不会因为换工具而认不出已在运行的实例。

## 工作原理

```
lceda-cdp start
  ├─ 清代理环境变量 → 拼 CDP 参数 → 隐藏启动 lceda-pro.exe（stderr 落盘）
  ├─ 写 ~/.lceda-connect/cdp/lceda-cdp.pid（pid + exe 路径，防 PID 复用误杀）
  └─ 轮询 GET /json/version（或扫 DevToolsActivePort）直到端点就绪

lceda-bridge start
  ├─ 探测 49620-49629 上是否已有健康实例
  ├─ 后台启动守护进程：node <cli> bridge supervise（detached + 隐藏）
  └─ 守护进程循环：node bridge-server.mjs → 输出追加日志 → 崩溃 3 秒后重试
```

进程内省（命令行匹配）在 Windows 上通过 `Get-CimInstance Win32_Process` 获取，端口占用通过 `netstat -ano` 获取，杀进程树用 `taskkill /F /T`——都与旧脚本一致，不引入额外依赖。

MCP 部分按「组装核心 + 薄传输适配层」拆分：`mcp/server.ts` 只负责工具/资源/权限组装，`mcp/transports/stdio.ts` 与 `mcp/transports/http.ts` 只搬协议字节，`commands/mcp.ts` 是参数到适配器的 composition root。新增传输（SSE/WebSocket/管道）只需要写适配器，不复制业务逻辑。详见 [架构说明](docs/architecture.md)。

## 开发

```bash
pnpm install --frozen-lockfile   # 安装依赖
pnpm build                       # 打包（vp pack，产物在 dist/）
pnpm test                        # 单元测试
pnpm check                       # 格式化 + lint + 类型检查
```

开发在 WSL2（Ubuntu）下进行；Windows 侧只用于运行嘉立创 EDA 客户端和真机联调。行尾统一为 LF（见 [.gitattributes](.gitattributes)）。

CI（GitHub Actions）在 Windows / Linux × Node 22、24 上跑 check、test、pack 和包体积门禁，另在 Node 20.11 上运行构建产物，并单独用一个 job 跑真实 ngspice。

目录结构：

```
src/
  cli*.ts                bin 入口（lceda-connect / lceda-cdp / lceda-bridge / lceda-mcp / 内置 bridge 服务）
  main.ts                命令组分发与帮助
  commands/              cdp/bridge 命令、mcp 命令编排、WSL→Windows stdio 启动
  core/                  配置、进程、网络探测、日志、参数解析、环境/Windows 互操作、assets 定位
  extensions/            .eext 预检、扩展管理器 UI 驱动、安装/卸载编排
  mcp/                   MCP 组装核心、工具注册表、结果截断
  mcp/transports/        stdio / Streamable HTTP 薄传输适配层
  cdp/ bridge/ eda/      编辑器连接与动词
  apidocs/ format/       API 文档检索、格式校验
  epro2/ eprj3/ sim/     工程文件解析、ngspice 仿真
assets/                  知识文档、Schema、API 参考与 sidecar 脚本；API 参考与 easyeda-api 技能原文默认不随 npm 包发布
docs/                    合并方案、扩展与 eprj3 文档、官方 CLI 参考
tests/                   单元与集成测试（vite-plus/test）
```

提交信息按 Conventional Commits 写，简述必须含汉字、不超过 50 字、结尾不加句号或分号。`pnpm install` 时会通过 `prepare`（`vp config`）装好 commit-msg 钩子，由 commitlint 校验；也可以手动执行 `pnpm run hooks:install`。

## 注意

- `lceda-cdp stop --yes` 会直接结束客户端进程，**未保存的工程会丢**；不加 `--yes` 只做提示。
- bridge 的 `stop` 会连同进程树一起清理，EDA 里的扩展会断开，下次使用前要在扩展里点一次「重新连接」。
- `cdp` 启动器与 `bridge` 服务管理只对 Windows 生效（客户端是 Windows 桌面程序）；工程文件解析、格式校验、文档检索与仿真不依赖平台。

## License

本项目及合并进来的自有内容采用 GPL-3.0-only，全文见 [LICENSE](LICENSE)。外部项目致谢集中在 [CREDITS.md](CREDITS.md)；必要的第三方许可文本与边界见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。npm 发行版的对应源码可从 [GitHub 版本标签](https://github.com/LeonhardtHUST/lceda-connect/tags) 下载，标签名与包版本一一对应（例如 `v0.1.0`）。
