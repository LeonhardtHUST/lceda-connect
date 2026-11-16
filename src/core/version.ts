import { readFileSync } from "node:fs";
import path from "node:path";

import { packageRoot } from "./assets.ts";

let cached: string | undefined;

/** 读取包根 package.json 的版本号；找不到时返回 0.0.0。 */
export function packageVersion(): string {
  if (cached) return cached;
  try {
    const pkg = JSON.parse(readFileSync(path.join(packageRoot(), "package.json"), "utf8")) as {
      version?: string;
    };
    cached = pkg.version ?? "0.0.0";
  } catch {
    cached = "0.0.0";
  }
  return cached;
}
