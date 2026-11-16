import { defineConfig } from "vite-plus";

// assets/ 下是从源仓库原样收进来的数据与脚本，不参与格式化与 lint。
const VENDORED = ["assets/**", "dist/**", ".vite-hooks/_/**"];

export default defineConfig({
  pack: {
    entry: ["src/index.ts", "src/cli.ts", "src/cli-cdp.ts", "src/cli-bridge.ts", "src/cli-mcp.ts"],
    format: "esm",
    platform: "node",
    target: "node20",
    dts: { generator: "tsgo" },
    exports: true,
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
