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
  },
});
