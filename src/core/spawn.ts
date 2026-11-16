import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

export interface DetachedOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

/**
 * 当前 CLI 的可执行入口路径，供 supervise 自举（隐藏子进程）使用。
 * 打包后 process.argv[1] 就是 dist/cli*.mjs；被测试框架加载时退回模块自身路径。
 */
export function selfEntryPath(): string {
  const argv1 = process.argv[1];
  if (argv1 && /\.(?:mjs|cjs|js)$/i.test(argv1)) return argv1;
  return fileURLToPath(import.meta.url);
}

/** 脱离父进程的隐藏启动：关掉 stdio 并 unref，父进程退出后子进程继续跑。 */
export function spawnDetached(
  file: string,
  args: readonly string[],
  opts: DetachedOptions = {},
): ChildProcess {
  const child = spawn(file, [...args], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: opts.env ?? process.env,
    cwd: opts.cwd,
  });
  child.unref();
  return child;
}
