#!/usr/bin/env node
// 真机验收用的本机回显服务：只记录收到的消息并回复，不接触工程数据。
//
// 用法：node scripts/acceptance-echo-server.mjs [端口]
// 默认监听 127.0.0.1:49631，Ctrl+C 结束。

import { WebSocketServer } from "ws";

const port = Number(process.argv[2] ?? 49631);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error("端口必须是 1-65535 的整数");
  process.exitCode = 1;
} else {
  const server = new WebSocketServer({ host: "127.0.0.1", port });
  server.on("connection", (socket, request) => {
    console.log(`[echo] 连接建立：${request.socket.remoteAddress ?? "unknown"}`);
    socket.on("message", (data) => {
      const message =
        typeof data === "string"
          ? data
          : Buffer.isBuffer(data)
            ? data.toString("utf8")
            : Array.isArray(data)
              ? Buffer.concat(data).toString("utf8")
              : Buffer.from(data).toString("utf8");
      console.log(`[echo] 收到：${message}`);
      socket.send(`pong:${message}`);
    });
    socket.on("close", () => console.log("[echo] 连接关闭"));
  });
  server.on("listening", () => console.log(`[echo] 监听 ws://127.0.0.1:${port}`));
  server.on("error", (error) => {
    console.error(`[echo] 失败：${error.message}`);
    process.exitCode = 1;
  });
}
