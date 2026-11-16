import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 定位包根目录（含 package.json 与 assets/ 的那一层）。
 *
 * 源码运行（vitest）时本文件在 src/core/，打包后代码在 dist/ 的 chunk 里，
 * 层数不同，所以从当前文件所在目录逐级向上找，而不是写死 "../../"。
 */
export function packageRoot(from: string = path.dirname(fileURLToPath(import.meta.url))): string {
  let dir = from;
  for (let i = 0; i < 8; i++) {
    if (existsSync(path.join(dir, "package.json")) && existsSync(path.join(dir, "assets"))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`找不到 lceda-connect 的 assets 目录（起点 ${from}）`);
}

let cachedAssetsDir: string | undefined;

/** assets 根目录；可用 LCEDA_CONNECT_ASSETS 覆盖（测试或二次打包时用）。 */
export function assetsDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.LCEDA_CONNECT_ASSETS) return env.LCEDA_CONNECT_ASSETS;
  cachedAssetsDir ??= path.join(packageRoot(), "assets");
  return cachedAssetsDir;
}

/** 拼出 assets 下的路径，并拒绝跳出 assets 根目录的相对路径。 */
export function assetPath(...segments: string[]): string {
  const root = assetsDir();
  const full = path.resolve(root, ...segments);
  const rel = path.relative(root, full);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`路径越界：${segments.join("/")}`);
  }
  return full;
}

export function readAssetText(...segments: string[]): string {
  return readFileSync(assetPath(...segments), "utf8");
}

export function readAssetJson<T = unknown>(...segments: string[]): T {
  return JSON.parse(readAssetText(...segments)) as T;
}

export function assetExists(...segments: string[]): boolean {
  try {
    return existsSync(assetPath(...segments));
  } catch {
    return false;
  }
}

/** 递归列出 assets 子目录下的文件（返回相对该子目录、用 / 分隔的路径）。 */
export function listAssetFiles(subdir: string, filter?: (rel: string) => boolean): string[] {
  const base = assetPath(subdir);
  if (!existsSync(base)) return [];
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else {
        const rel = path.relative(base, full).split(path.sep).join("/");
        if (!filter || filter(rel)) out.push(rel);
      }
    }
  };
  walk(base);
  return out;
}
