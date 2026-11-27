# 执行环境与客户端路径

在线能力（CDP、Bridge）能不能用，不只取决于客户端有没有启动，还取决于 **MCP 进程和客户端是不是在同一个操作系统、同一个网络命名空间**。WSL2 默认的 NAT 网络里，MCP 在 Linux 虚拟机、客户端在 Windows 宿主，`127.0.0.1` 是两台机器的回环，Windows 侧没有端口转发就连不上。这个工具因此先判环境，再决定探测哪些地址、能不能启动客户端、失败时给什么建议。

本页描述 0.4.0 的环境模型。`lceda-connect env` 会按同一套逻辑把结论和证据打印出来。

## 1. 环境模型

| 字段                    | 含义                                                                                          |
| ----------------------- | --------------------------------------------------------------------------------------------- |
| `kind`                  | `windows-native` / `wsl2` / `linux-native` / `macos-native` / `unknown`，MCP 进程所在环境     |
| `hostOs`                | 客户端实际所在的 OS：`windows` / `linux` / `macos`                                            |
| `clientLocations`       | 仅 WSL2：客户端跑在 `host`（Windows 宿主）还是 `vm`（WSL 虚拟机）；数组顺序 = 启动/探测优先级 |
| `windowsHost`           | WSL2 下 Windows 宿主的可达地址；原生环境为 `null`                                             |
| `networkingMode`        | WSL2 网络模式：`nat` / `mirrored` / `unknown`                                                 |
| `pathStyle`             | 当前 Node 进程寻址文件的方式：Windows 原生是 `windows`，其余是 `posix`                        |
| `explicit` / `source`   | 是否显式指定，以及来自 `argv` / `config-file` / `env` / 自动发现                              |
| `evidence` / `warnings` | 判定依据与可操作提醒，CLI 与 `lceda_status` 都会输出                                          |

### 1.1 WSL2 的两种客户端位置

用户澄清过的关键区分：**WSL2 里「MCP 在虚拟机」不代表「客户端也在虚拟机」**。

| `clientLocations`   | 客户端位置           | 通道可达性                                                                |
| ------------------- | -------------------- | ------------------------------------------------------------------------- |
| `host`（WSL2 默认） | Windows 宿主原生环境 | 回环不互通；CDP 只有客户端监听非回环时才可能经宿主地址访问；bridge 不可达 |
| `vm`                | WSL 虚拟机内部       | 与 MCP 共享回环，CDP、bridge 都按本机处理                                 |
| `vm,host`           | 先 VM，后宿主        | 按顺序探测，VM 命中就用 VM；VM 不可用再退到宿主地址                       |

`--lceda-in` 的**顺序就是优先级**：`vm,host` 表示先按「客户端在 VM 里」启动/探测，失败再按宿主处理。默认值固定为 `host`（Windows 原生客户端）。

## 2. 自动发现（只读）

| 判定                 | 依据                                                                                                                              |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Windows 原生         | `process.platform === "win32"`                                                                                                    |
| macOS 原生           | `process.platform === "darwin"`                                                                                                   |
| WSL2                 | Linux 平台且命中 `/proc/sys/kernel/osrelease` 或 `/proc/version` 的 `microsoft` / `WSL`，或存在 `WSL_INTEROP` / `WSL_DISTRO_NAME` |
| Linux 原生           | 其余 Linux                                                                                                                        |
| WSL 网络模式         | `wslinfo --networking-mode`；老版本 WSL 没有该命令时按 `unknown` 保守处理                                                         |
| 宿主地址（NAT）      | `/proc/net/route` 默认网关，按小端解析 8 位十六进制（`01E012AC` → `172.18.224.1`）                                                |
| 宿主地址（兜底）     | `/etc/resolv.conf` 的 first nameserver，并附「可能不是宿主地址」警告                                                              |
| 宿主地址（mirrored） | `127.0.0.1`，因为 mirrored 共享宿主网络命名空间                                                                                   |

探测不启动进程、不安装、不修改系统设置。`--env` / 配置文件给出环境时**完全跳过自动发现**，只保留证据与平台不一致的警告。

## 3. 配置优先级

```text
命令行显式参数  >  配置文件  >  .env  >  继承的进程环境  >  内置默认
```

`.env` 只补「尚未设置」的键（dotenv 语义），不会覆盖真实环境变量；配置文件用于项目级显式声明，可以覆盖进程环境。每一项最终来源可用 `lceda-connect env --json` 的 `config.sources` 核对。

### 3.1 全局参数（CLI 与 MCP stdio 通用）

| 参数                  | 说明                                                                                         |
| --------------------- | -------------------------------------------------------------------------------------------- |
| `--config PATH`       | 配置文件（JSON）                                                                             |
| `--env-file PATH`     | `.env` 文件                                                                                  |
| `--env KIND`          | `auto` / `windows-native` / `wsl2` / `linux-native` / `macos-native`；显式指定即不做自动发现 |
| `--lceda-in LIST`     | WSL2 客户端位置优先级：`host` / `vm` / `vm,host`                                             |
| `--windows-host HOST` | WSL2 下的宿主地址（默认取默认网关）                                                          |
| `--cdp-host HOST`     | 覆盖 CDP 探测地址                                                                            |
| `--bridge-host HOST`  | 覆盖 bridge 探测地址                                                                         |
| `--exe PATH`          | 客户端可执行文件；WSL2 + host 下可直接传 Windows 路径，工具自动转 `/mnt/...`                 |

MCP 客户端配置示例：

```json
{
  "mcpServers": {
    "lceda": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "lceda-connect", "mcp", "--env", "wsl2", "--lceda-in", "host"]
    }
  }
}
```

### 3.2 配置文件

```json
{
  "environment": {
    "kind": "wsl2",
    "windowsHost": "172.18.224.1",
    "clientLocations": ["host"]
  },
  "client": {
    "exePath": "D:\\Program Files\\lceda-pro\\lceda-pro.exe"
  },
  "cdp": { "port": 9222, "scan": [9222, 9240] },
  "bridge": { "portFirst": 49620, "portLast": 49629 },
  "mcp": { "toolsets": ["core", "offline"] }
}
```

未知键与类型错误会直接报错并给出行路径（例如 `cdp.port: ...`），不会静默忽略。相对路径按当前工作目录解析。

### 3.3 `.env`

```dotenv
LCEDA_ENV=wsl2
LCEDA_LEDA_IN=host
LCEDA_PRO_EXE=D:\Program Files\lceda-pro\lceda-pro.exe
LCEDA_CDP_PORT=9222
```

支持 `export KEY=VALUE`、单/双引号与 ` # 行内注释`；不做变量展开。

## 4. 客户端可执行文件发现

只「列候选 → 逐个 stat」，不猜不存在的位置；显式路径找不到时**不回退**，避免掩盖传错的路径。

| 环境 / 位置    | 候选来源                                                                                                                                                                    |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| windows-native | `LCEDA_PRO_EXE`、`%ProgramFiles%`、`%ProgramFiles(x86)%`、`%LOCALAPPDATA%\Programs`、历史默认 `D:\Program Files\lceda-pro`、`PATH`；`--deep` 追加 `where.exe`               |
| wsl2 + host    | `LCEDA_PRO_EXE`（Windows 路径自动转 `/mnt/<盘>/...`）、WSL `PATH` 中带 `lceda`/`easyeda` 的目录、`/mnt/{c,d,e,f}/Program Files/lceda-pro`；`--deep` 追加 `cmd.exe /c where` |
| wsl2 + vm      | `PATH`、`/opt/lceda-pro`、`/usr/local/bin`、`~/.local/bin`（AppImage 名称也纳入）                                                                                           |
| linux-native   | 同上                                                                                                                                                                        |
| macos-native   | `/Applications/lceda-pro.app/Contents/MacOS/...`、`~/Applications`、`PATH`；显式给 `.app` 会自动展开                                                                        |

`lceda-connect env --deep` 会带上较慢的 `where`/`command -v` 深探。WSL2 的 PATH 在 drvfs 上逐个 stat 很贵，默认策略先扫线索目录再补固定盘符，结果按环境缓存。

## 5. 在线通道策略矩阵

| 环境                                         | 客户端位置 | CDP 探测地址              | bridge                        |
| -------------------------------------------- | ---------- | ------------------------- | ----------------------------- |
| windows-native / linux-native / macos-native | host       | `127.0.0.1`               | `127.0.0.1`                   |
| wsl2 mirrored                                | host       | `127.0.0.1`               | `127.0.0.1`（共享回环）       |
| wsl2 NAT                                     | vm         | `127.0.0.1`               | `127.0.0.1`                   |
| wsl2 NAT                                     | host       | `windowsHost → 127.0.0.1` | 不可达（`cross_os_loopback`） |

**bridge 为什么跨 OS 一定不可达**：服务按契约只监听 `127.0.0.1`，agent 认证 token 又写在 Windows 的 `%LOCALAPPDATA%\lceda-bridge\token-<端口>.txt`。WSL 里既连不上端口，也读不到 token；本工具不通过端口转发或放宽监听地址来绕过这个边界。

### 5.1 WSL2 NAT + 客户端在宿主时的可行做法

1. **在 Windows 侧运行 MCP（推荐）**：Windows 上 `npm i -g lceda-connect`，让 MCP 客户端指向 Windows 命令。此时客户端与 MCP 共享回环，所有在线工具按原生逻辑工作。WSL 里的 stdio 客户端可以让这条命令自动完成：`npx -y lceda-connect mcp host`；也可让 Windows 常驻 `lceda-connect mcp http --host wsl --token ...`，WSL 用 HTTP 连。见 [传输模式](transports.md)。
2. **启用 WSL mirrored 网络**：在 `%USERPROFILE%\.wslconfig` 写 `[wsl2]` / `networkingMode=mirrored`，重启 WSL 后回环重新共享。注意这会改变整体 WSL 网络行为，且需要 WSL 2.0+。
3. **把客户端装进 WSL VM**：按 `--lceda-in vm` 使用 Linux 版客户端，回环直连。

`lceda-connect cdp start` 在「WSL2 NAT + 客户端在宿主」时直接退出码 2 并给出上述选项，不会先拉起进程再等 60 秒超时。

## 6. 安全边界

- 探测地址默认只允许回环；非回环地址只有在**等于当前环境推导出的宿主地址**时才放行；其余非回环地址（包括 `--cdp-host` / `LCEDA_CDP_HOST` 等显式配置）仍按 `LOOPBACK_ONLY` 拒绝，并在 `environment.warnings` 里留下“已忽略”说明。
- 不放宽 bridge 监听地址，不做 `netsh portproxy`，不修改防火墙。
- 环境发现只读：不启动客户端、不写注册表、不改 WSL 配置。

## 7. 平台阶段

| 环境                              | 状态                                                     |
| --------------------------------- | -------------------------------------------------------- |
| windows-native                    | 既有逻辑基线；本版补充可执行文件自动发现与配置优先级     |
| wsl2（NAT / mirrored，host / vm） | 本版重点：检测、路径转换、通道策略与诊断已实现           |
| linux-native / macos-native       | 检测与候选路径已实现；在线通道未做真机验收，标记为开发中 |

## 8. 故障排查

```bash
lceda-connect env                 # 环境、客户端路径、通道策略一屏看完
lceda-connect env --json          # 给脚本；含证据与配置来源
lceda-connect eda status          # 双通道实测（含 environment / live_strategy）
```

| 现象 / reason_code    | 含义与下一步                                                     |
| --------------------- | ---------------------------------------------------------------- |
| `cross_os_loopback`   | WSL2 NAT + 客户端在宿主：按 5.1 的三种做法之一处理               |
| `explicit_missing`    | `--exe` / 配置里的路径不存在：修路径，工具不会悄悄改用自动发现   |
| `LOOPBACK_ONLY`       | 连接了非回环、也不在当前环境宿主列表里的地址：检查 `--cdp-host`  |
| `service_unavailable` | 地址可达但没开调试端口：彻底退出客户端后 `cdp start`，或检查端口 |

`cdp_*` MCP 工具（求值、截图、输入等）在本版仍只连回环；环境感知的探测顺序目前用于 `lceda_status`、`eda` 动词与 `cdp_discover`。
