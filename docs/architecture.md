# 架构：组装核心 + 薄传输适配层

lceda-connect 的 MCP 部分只有一件事值得长期维护：**工具/资源/权限的组装**。传输方式（stdio、Streamable HTTP、未来的 SSE/WebSocket/管道）只负责把协议字节搬进搬出，不应复制任何业务逻辑。代码按这个边界分层：

```
bin 入口（lceda-connect / lceda-mcp）
        │
        ▼
commands/mcp.ts                 命令解析、传输选择、生命周期（composition root）
        │
        ├── mcp/transports/stdio.ts ──┐
        ├── mcp/transports/http.ts  ──┤
        └── commands/mcpHost.ts     ──┤  （WSL→Windows 进程桥，不是传输实现）
                                      ▼
                      mcp/server.ts  createServerFactory()
                                      │
                                      ▼
                      createServer()：工具注册、资源模板、ToolContext、
                      roots/写路径策略、结果截断
                                      │
                                      ▼
                      各领域 handler（cdp / bridge / eda / epro2 / sim …）
```

## 模块职责

| 模块                                                        | 负责                                                                                                                                      | 不负责                               |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| [`mcp/server.ts`](../src/mcp/server.ts)                     | 组装 `McpServer`：注册工具、`lceda://` 资源、`ToolContext`、roots 与写路径策略；`createServerFactory` 返回「每次调用一个新 server」的工厂 | 任何传输方式、进程生命周期、监听地址 |
| [`mcp/transports/types.ts`](../src/mcp/transports/types.ts) | 传输契约：`McpServerFactory`、`TransportStartOptions`、`TransportHandle`                                                                  | 具体协议实现                         |
| [`mcp/transports/stdio.ts`](../src/mcp/transports/stdio.ts) | 从工厂取一个 server，接 `StdioServerTransport`，就绪日志写 stderr                                                                         | 工具注册、业务逻辑                   |
| [`mcp/transports/http.ts`](../src/mcp/transports/http.ts)   | Streamable HTTP：监听、session、Host/Origin/token、`/health`、413/404/405 等 HTTP 语义                                                    | 工具注册、业务逻辑                   |
| [`commands/mcp.ts`](../src/commands/mcp.ts)                 | 解析 `mcp serve/http/host/tools` 参数，调用适配器，处理信号与退出码                                                                       | 传输实现细节                         |
| [`commands/mcpHost.ts`](../src/commands/mcpHost.ts)         | WSL→Windows stdio 进程桥：发现 Windows node/安装、翻译环境、透传 stdio                                                                    | MCP 协议、工具注册                   |
| [`core/windowsHost.ts`](../src/core/windowsHost.ts)         | Windows 互操作探测与环境翻译（可注入探针）                                                                                                | CLI 输出                             |

## 关键契约

```ts
export type McpServerFactory = () => McpServer;

export interface TransportStartOptions {
  env: NodeJS.ProcessEnv;
  toolsets?: ToolsetSelection;
  serverFactory?: McpServerFactory; // 嵌入/测试覆盖
}

export interface TransportHandle {
  readonly url?: string;
  close(): Promise<void>; // 必须可重复调用
}
```

- **stdio**：一个进程一个 server，`startStdioTransport()` 返回句柄；`serveStdio()` 只是兼容旧入口的包装。
- **HTTP**：每个 MCP session 向工厂要一个独立 server；会话回收/上限只属于 HTTP 适配器。
- **测试**：`startHttpTransport({serverFactory})` 可注入计数工厂，验证「适配器不复制组装逻辑」；工厂本身也单独测「每次返回独立实例」。

## 设计规则

1. **组装只在 `createServer`**。传输层不得直接 import 工具模块或注册工具；新增工具只改 registry 与领域模块。
2. **传输只碰协议与传输策略**。Host/Origin/token、session、SSE/JSON、HTTP 状态码留在 HTTP 适配器；stdio 不写 stdout。
3. **新增传输 = 新增适配器 + 契约测试**。实现 `startXxxTransport(options): Promise<TransportHandle>`，从 `options.serverFactory ?? createServerFactory(options)` 取 server，不在适配器里复制 roots/写路径逻辑。
4. **composition root 保持薄**。`commands/mcp.ts` 只做参数 → 选项 → 适配器调用；平台/环境判断复用 `core/environment.ts` 与 `core/windowsHost.ts`。
5. **旧路径允许兼容 shim**。`src/mcp/httpServer.ts` 现在只是 `transports/http.ts` 的 re-export，方便已有 import；新代码一律用 `transports/` 路径。
6. **日志出口固定**：stdio 的 stdout 归 JSON-RPC，所有诊断写 stderr；HTTP 模式同样写 stderr，stdout 保持干净。

## 为什么这样做

- **加传输不改业务**：SSE、WebSocket、进程内 pipe 都只是新的 `transports/*.ts`，不会出现第二份 `ToolContext` 或写路径策略。
- **安全策略集中**：HTTP 的鉴权/来源校验/会话上限只在一个文件里，审查面小；stdio 天然不暴露网络。
- **可测**：工厂注入让 HTTP 适配器可以离线验证「每 session 独立 server」，不用起真实客户端。
- **启动轻**：传输模块由 `commands/mcp.ts` 动态 import；CLI 其它命令不会把 HTTP server 拉进启动图。

## 当前验证

- `tests/transportAdapters.test.ts`：工厂每次返回独立 server；HTTP 每 session 调用一次工厂；工具清单来自共享组装。
- `tests/httpServer.test.ts`：握手、token、stateless、Host/Origin、session 404、405 等传输语义。
- `tests/mcp-stdio.test.ts`：真实子进程 stdio 握手与 `lceda_info`。
- 双传输共享的工具/资源由 `tests/mcp.test.ts`、`tests/apidocs.test.ts` 等既有测试覆盖。

更上层的环境/路径策略见 [执行环境](environments.md)，跨 WSL/宿主的使用方式见 [传输模式](transports.md)。
