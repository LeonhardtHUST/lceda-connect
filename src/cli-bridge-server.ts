#!/usr/bin/env node
import { startBridgeServer } from "./bridge/server.ts";

/**
 * 内置 bridge 服务入口（打包成 dist/cli-bridge-server.mjs）。
 *
 * lceda-bridge start 找不到外部 bridge-server.mjs 时，会用这个内置版本：
 * 由 node 直接跑，不需要外部目录里的 ws 依赖。
 */
try {
  const handle = await startBridgeServer();
  if (!handle.reused) {
    const stop = (): void => {
      void handle.close();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  }
} catch (error) {
  process.stderr.write(
    `bridge 启动失败：${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
