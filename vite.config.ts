import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: ["src/index.ts", "src/cli.ts", "src/cli-cdp.ts", "src/cli-bridge.ts"],
    format: "esm",
    platform: "node",
    target: "node20",
    dts: { generator: "tsgo" },
    exports: true,
  },
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  fmt: {},
});
