# MCP 传输模式：stdio / Streamable HTTP / WSL→Windows

三种使用方式共用同一套 MCP 组装（工具/资源/权限），只在传输适配层不同；分层边界见 [架构说明](architecture.md)。

lceda-connect 的 MCP 服务支持三种使用方式，区别在于 **MCP 进程跑在哪一侧**，这直接决定在线工具（CDP / bridge）能不能看到客户端。

| 模式              | 命令                                    | MCP 进程位置                          | 适用                                    |
| ----------------- | --------------------------------------- | ------------------------------------- | --------------------------------------- |
| stdio             | `lceda-mcp` / `npx lceda-connect mcp`   | 调用方所在环境                        | 绝大多数本机客户端                      |
| Streamable HTTP   | `lceda-mcp http --host wsl --port 3939` | 你启动它的环境（可放 Windows 侧常驻） | 跨 WSL/宿主、多客户端共享一个 MCP       |
| WSL→Windows stdio | `npx lceda-connect mcp host`            | 由 WSL 进程拉起的 **Windows 侧** MCP  | WSL 里的客户端想用 Windows 客户端的回环 |

## 1. Streamable HTTP

```bash
# 默认：只监听 127.0.0.1:3939，端点 /mcp
lceda-mcp http

# 跨 WSL：自动取 WSL 虚拟网卡地址（Windows 侧启动时取 WSL 默认网关）
lceda-mcp http --host wsl --port 3939 --token my-secret

# 指定端点路径 / 无状态模式
lceda-mcp http --host 172.18.224.1 --port 3939 --path /mcp --stateless
```

选项：

| 选项          | 默认        | 说明                                          |
| ------------- | ----------- | --------------------------------------------- |
| `--host`      | `127.0.0.1` | 监听地址；`wsl` 表示自动解析 WSL 虚拟网卡地址 |
| `--port`      | `3939`      | 监听端口；`0` 表示随机端口                    |
| `--path`      | `/mcp`      | MCP 端点路径                                  |
| `--token`     | 无          | 要求 `Authorization: Bearer <token>`          |
| `--stateless` | 关          | 不管理 session，每个 POST 独立 server         |
| `--toolsets`  | 全部        | 同 stdio 模式的工具集裁剪                     |

安全与规范细节：

- Host 与 Origin 头都校验（只接受回环/绑定地址，通配绑定时只接受 IP 字面量），`/health` 同样校验 Host；
- 可选 Bearer token（scheme 大小写不敏感；401 带 `WWW-Authenticate`）；
- 未知/过期 session 返回 404，无 SSE 能力的 stateless 模式对 GET/DELETE 返回 405；
- 请求体上限 4 MiB，超限返回 413（连接不 reset）；
- 有状态会话 30 分钟空闲回收，最多 64 个；`/health` 的 `sessions` 可观察数量。

`/health` 不需要 token，只返回版本、监听信息与环境摘要，用来做连通性自检：

```bash
curl http://172.18.224.1:3939/health
```

MCP 客户端配置（支持 HTTP 传输的客户端）：

```json
{
  "mcpServers": {
    "lceda": {
      "type": "http",
      "url": "http://172.18.224.1:3939/mcp",
      "headers": { "Authorization": "Bearer my-secret" }
    }
  }
}
```

配置文件也可以写（等价环境变量 `LCEDA_HTTP_HOST` / `LCEDA_HTTP_PORT` / `LCEDA_HTTP_PATH` / `LCEDA_HTTP_TOKEN` / `LCEDA_HTTP_STATELESS`）：

```json
{
  "mcp": {
    "toolsets": ["core", "live"],
    "http": { "host": "wsl", "port": 3939, "token": "my-secret" }
  }
}
```

### 1.1 WSL NAT 下的实测边界（重要）

在 WSL2 NAT 网络里，**只绑 `127.0.0.1` 的服务无法从另一个命名空间访问**——这是网络命名空间隔离，不是配置问题。实测（Windows 上 node 监听，WSL 内 curl）：

| Windows 侧监听地址                         | WSL 访问 `http://127.0.0.1:PORT` | WSL 访问 `http://<宿主IP>:PORT` |
| ------------------------------------------ | -------------------------------- | ------------------------------- |
| `127.0.0.1`                                | 拒绝                             | **超时 / 不可达**               |
| `0.0.0.0`                                  | 拒绝                             | 可达                            |
| `<宿主 vEthernet IP>`（如 `172.18.224.1`） | 拒绝                             | 可达                            |

所以跨 WSL 使用 HTTP 时：

- **推荐**：`--host wsl`（只绑 WSL 虚拟网卡，不暴露到局域网）+ `--token`；
- 只有在明确知道风险时才用 `0.0.0.0`（会暴露到 LAN，且 MCP 本身无内建鉴权）；
- 不要指望「Windows 绑 127.0.0.1，WSL 用宿主 IP 访问」能通。

`--host wsl` 的解析方式：在 Windows 上运行 `wsl.exe -e sh -lc "ip route show default"` 取默认网关（即宿主 vEthernet 地址）；在 WSL 里运行则取 `eth0` 的 IPv4。解析失败会提示直接传 `--host <IP>`。

### 1.2 在 Windows 侧常驻

HTTP 模式的价值是启动一次、WSL 与 Windows 都能连。建议在 Windows PowerShell 里：

```powershell
lceda-mcp http --host wsl --port 3939 --token my-secret
```

（需要先在 Windows 安装：`pnpm add -g lceda-connect` 或 `npm i -g lceda-connect`。）

如果从 WSL 用互操作启动 Windows 进程，本工具会自动把继承来的 POSIX 环境换成真实 Windows 环境，避免 `PATH`/`HOME` 把 exe 发现带偏。

## 2. WSL→Windows stdio

WSL 的 MCP 客户端按标准 stdio 配置，但让 MCP 进程实际跑在 Windows 上，这样它和 EasyEDA 共享 Windows 回环，`lceda_status`、CDP、bridge 都按原生 Windows 逻辑工作。

前提：**Windows 侧已安装 lceda-connect**（`pnpm add -g lceda-connect` 或 `npm i -g lceda-connect`）。然后二选一：

### 2.1 一条命令（推荐）

```json
{
  "mcpServers": {
    "lceda": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "lceda-connect", "mcp", "host"]
    }
  }
}
```

想让 MCP 启动时顺带确保 EasyEDA 带调试端口运行，加 `--start-client`（`--port` 指定调试端口）：

```bash
npx lceda-connect mcp host --start-client --port 9333
```

它委托 Windows 侧 `lceda-cdp status/start`：客户端已在目标端口 → 直接复用；已在别的端口或没有调试端口 → **报错并提示手动退出，绝不杀进程**（未保存工程不会被自动关闭）。启动后最多等 45 秒端点就绪，避免超过 MCP 客户端 60 秒初始化上限。

`mcp host` 会：

1. 找到 Windows 的 `node.exe`（`LCEDA_WINDOWS_NODE` > `where node.exe` > 常见安装位置）；
2. 找到 Windows 全局安装的 `lceda-connect/dist/cli-mcp.mjs`（`LCEDA_WINDOWS_MCP` > `pnpm/npm root -g` > `%APPDATA%\npm`）；
3. 用 `cmd.exe /d /c set` 取真实 Windows 环境，把当前进程里的 `LCEDA_*` 配置叠加进去，`/mnt/d/...` 路径自动转 `D:\...`；强制 `LCEDA_ENV=windows-native`，丢弃 WSL 专用的 `LCEDA_LEDA_IN` / `LCEDA_WINDOWS_HOST` 并告警，避免 Windows 进程按 WSL 策略跑；
4. 以 stdio 透传拉起 Windows MCP（stdin 也转发，客户端关闭输入时子进程会退出）。

非全局安装或自定义路径：

```bash
npx lceda-connect mcp host --script 'D:\tools\lceda-connect\dist\cli-mcp.mjs'
```

### 2.2 直接写 Windows 命令

### 2.4 自动启动客户端（可选）

```bash
npx lceda-connect mcp host --start-client --port 9333
```

安全边界：只启动，不结束任何用户进程；若 EasyEDA 已在运行但没有调试端口（或端口不一致），命令直接失败并提示先保存、退出客户端。这是刻意设计，避免自动化误关未保存工程。

`mcp host --print-config` 会先打印环境翻译告警（如被移除的 `/root`、`/tmp` 路径），再输出可粘贴的配置，等价于直接指定：

```json
{
  "mcpServers": {
    "lceda": {
      "type": "stdio",
      "command": "/mnt/c/Users/<user>/AppData/Local/vite-plus/bin/node.exe",
      "args": ["D:\\path\\to\\lceda-connect\\dist\\cli-mcp.mjs"]
    }
  }
}
```

WSL 的 `binfmt` 互操作会把这个 `/mnt/c/.../node.exe` 进程当 Windows 进程运行，stdin/stdout 正常承载 JSON-RPC。实测握手成功，`lceda_info` 返回 `platform: "win32"`、`environment.kind: "windows-native"`。

### 2.3 注意

- `mcp host` 只在 Linux/WSL 侧有意义；Windows 原生直接用 `lceda-mcp` 即可。
- 当前进程里的 `/tmp/...`、`/root/...` 等纯 WSL 路径无法被 Windows 读取，会从子进程环境移除并告警；配置文件请放在 `/mnt/<盘>/...`。
- 启动比 Linux 侧多花几秒（Windows node + 模块加载），但 MCP 会话只启动一次。
- 结束 `mcp host` 时子进程会随信号退出；若客户端强杀进程后 Windows 侧仍有残留，用任务管理器结束对应 `node.exe`。

## 3. 怎么选

- 客户端和 EasyEDA 都在 Windows：stdio（原生）最省事；需要多客户端共享再上 HTTP。
- 客户端在 WSL、EasyEDA 在 Windows：**`mcp host`**（stdio 兼容性最好）或 Windows 侧 `mcp http --host wsl`。
- 客户端在 WSL、EasyEDA 也在 WSL：原生 stdio/HTTP 均可，按 `--lceda-in vm` 或环境自动判定。
- 只想离线工具：任意模式都行，`--toolsets offline` 可减载。

安全提醒：HTTP 模式没有内建 OAuth，绑定非回环时请加 `--token`，并且只绑 WSL 虚拟网卡地址；不要绑 `0.0.0.0`。
