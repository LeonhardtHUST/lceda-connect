# lceda-connect

嘉立创EDA专业版（EasyEDA Pro）连接工具箱。把散落在 `lceda-cdp.ps1`、`lceda-bridge.ps1` 里的两套能力收进一个 npm 包，`npx` / `vpx` 直接可用：

- **`cdp`** —— 带 Chrome DevTools Protocol 调试端口启动客户端，并管理这个受管实例（`start` / `ensure` / `status` / `endpoint` / `stop`）。
- **`bridge`** —— EasyEDA AI Bridge 服务管理：后台守护、崩溃自动重启、健康检查、日志、环境自检（`start` / `stop` / `restart` / `status` / `logs` / `doctor` / `run`）。

## 安装

无需安装，直接跑：

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

## 快速开始

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

- 启动参数顺序固定为 `--remote-debugging-port` → `--remote-debugging-address` → `--proxy-server`。客户端「清理缓存」自重启只透传 `process.argv[1]`，端口必须待在第一位才能活过重启。
- 默认清掉继承来的 `http_proxy` / `https_proxy` / `all_proxy` / `ftp_proxy` / `no_proxy`，让客户端回到「按 Windows 系统代理走」这一条可解释路径（否则会去连某个终端专用的沙箱代理，表现为白屏 30~80 秒）。要保留就加 `--keep-proxy-env`。
- 启动前先探 `pro.lceda.cn`：网络没通会警告，`--wait-online N` 可以等最多 N 秒。
- 客户端是单实例的：已有实例时新启动的参数会被转交并丢弃，因此默认拒绝，确需并行要 `--force`（两个实例会争抢同一份数据）。
- 启动后自动校准 pid：Electron 的启动器进程可能 fork 后退出，pid 文件会被改写成真正持有窗口的主进程。

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

| 变量                   | 作用                        | 默认值                                     |
| ---------------------- | --------------------------- | ------------------------------------------ |
| `LCEDA_PRO_EXE`        | 客户端主程序路径            | `D:\Program Files\lceda-pro\lceda-pro.exe` |
| `LCEDA_CDP_PORT`       | CDP 调试端口                | `9222`                                     |
| `LCEDA_CONNECT_HOME`   | CDP 运行态根目录            | `~/.lceda-connect`                         |
| `LCEDA_NODE`           | 指定 node.exe，跳过自动探测 | 自动探测                                   |
| `LCEDA_BRIDGE_SCRIPT`  | 指定 `bridge-server.mjs`    | 自动探测                                   |
| `LCEDA_BRIDGE_RUNTIME` | bridge 运行态目录           | `%LOCALAPPDATA%\lceda-bridge`              |

优先级：命令行参数 > 环境变量 > 内置默认值。

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

## 开发

```bash
vp install        # 安装依赖
vp build          # 打包（vp pack，产物在 dist/）
vp test           # 单元测试
vp check          # 格式化 + lint + 类型检查
```

目录结构：

```
src/
  cli.ts / cli-cdp.ts / cli-bridge.ts   三个 bin 入口（共用 main）
  main.ts                              命令组/动作/选项分发与帮助
  commands/                            cdp、bridge 两套子命令实现
  core/                                配置、进程、网络探测、日志、node 解析、参数解析
tests/                                 单元测试（vite-plus/test）
```

## 注意

- `lceda-cdp stop --yes` 会直接结束客户端进程，**未保存的工程会丢**；不加 `--yes` 只做提示。
- bridge 的 `stop` 会连同进程树一起清理，EDA 里的扩展会断开，下次使用前要在扩展里点一次「重新连接」。
- 只对 Windows 生效（客户端是 Windows 桌面程序）。

## License

MIT
