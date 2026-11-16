import { spawn } from "node:child_process";

export interface RunOptions {
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** spawn 本身失败（ENOENT / EACCES）时的错误信息。 */
  error?: string;
}

/**
 * 跑一个外部命令并收齐输出。永不 reject：调用方只需要判断 code / error。
 * 超时会先 kill，再以 code -1 返回。
 */
export function run(
  file: string,
  args: readonly string[],
  opts: RunOptions = {},
): Promise<RunResult> {
  return new Promise<RunResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let timer: NodeJS.Timeout | null = null;

    const finish = (result: RunResult): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };

    let child;
    try {
      child = spawn(file, [...args], {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: opts.env ?? process.env,
        cwd: opts.cwd,
      });
    } catch (error) {
      finish({ code: -1, stdout, stderr, timedOut: false, error: (error as Error).message });
      return;
    }

    timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill();
        }, opts.timeoutMs)
      : null;

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      finish({ code: -1, stdout, stderr, timedOut, error: error.message });
    });
    child.on("close", (code: number | null) => {
      finish({ code: code ?? -1, stdout, stderr, timedOut });
    });
  });
}
