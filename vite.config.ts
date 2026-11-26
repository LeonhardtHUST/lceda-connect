import { defineConfig } from "vite-plus";

// assets/ 与 docs/vendor/ 下是从源仓库原样收进来的数据、脚本与文档，不参与格式化与 lint。
const VENDORED = ["assets/**", "docs/vendor/**", "dist/**", ".vite-hooks/_/**"];

export default defineConfig({
  pack: {
    entry: [
      "src/index.ts",
      "src/cli.ts",
      "src/cli-cdp.ts",
      "src/cli-bridge.ts",
      "src/cli-mcp.ts",
      // 内置 AI Bridge 服务，lceda-bridge 找不到外部脚本时用它
      "src/cli-bridge-server.ts",
    ],
    format: "esm",
    platform: "node",
    target: "node20",
    dts: { generator: "tsgo" },
    // package.json 的条件导出由项目维护，构建不要覆盖 types/default。
    exports: false,
  },
  lint: {
    ignorePatterns: VENDORED,
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  fmt: {
    ignorePatterns: VENDORED,
  },
  test: {
    include: ["tests/**/*.test.ts"],
    // WSL 的 /mnt（drvfs）上模块加载明显偏慢；默认 5s 会让 MCP 子进程/多实例测试假超时。
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // drvfs 上并行 worker 太多会互相拖慢模块加载，反而让超时测试假失败。
    maxWorkers: 4,
  },
});
