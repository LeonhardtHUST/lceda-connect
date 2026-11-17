import { spawn } from "node:child_process";

export interface RunOptions {
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  signal?: AbortSignal;
  maxOutputBytes?: number;
  windowsVerbatimArguments?: boolean;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  error?: string;
  truncated?: { stdout?: boolean; stderr?: boolean };
}

export interface ExecutionProgressOptions {
  signal?: AbortSignal;
  onProgress?: (done: number, total: number, message: string) => void | Promise<void>;
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw cancellationError();
}

function cancellationError(): Error & { code: string } {
  return Object.assign(new Error("Operation aborted"), { name: "AbortError", code: "CANCELLED" });
}

const DEFAULT_MAX_OUTPUT = 8 * 1024 * 1024;
const HEAD_BYTES = 1024 * 1024;

function appendLimited(current: string, chunk: string, max: number): [string, boolean] {
  const next = Buffer.from(current + chunk);
  if (next.length <= max) return [next.toString("utf8"), false];
  const headBytes = Math.min(HEAD_BYTES, Math.floor(max / 2));
  const head = next
    .subarray(0, headBytes)
    .toString("utf8")
    .replace(/\uFFFD+$/, "");
  const tailBytes = max - Buffer.byteLength(head);
  const tail = tailBytes
    ? next
        .subarray(-tailBytes)
        .toString("utf8")
        .replace(/^\uFFFD+/, "")
    : "";
  return [head + tail, true];
}

export function run(
  file: string,
  args: readonly string[],
  opts: RunOptions = {},
): Promise<RunResult> {
  return new Promise<RunResult>((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(cancellationError());
      return;
    }
    const max = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
    if (!Number.isSafeInteger(max) || max < 0) {
      reject(new RangeError("maxOutputBytes must be a nonnegative safe integer"));
      return;
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let stopping = false;
    let timer: NodeJS.Timeout | undefined;
    let terminationTimer: NodeJS.Timeout | undefined;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let child: ReturnType<typeof spawn>;
    const cleanup = (): void => {
      clearTimeout(timer);
      clearTimeout(terminationTimer);
      opts.signal?.removeEventListener("abort", abort);
    };
    const finish = (code: number, error?: string, cancelled = false): void => {
      if (settled) return;
      settled = true;
      cleanup();
      child?.stdout?.destroy();
      child?.stderr?.destroy();
      if (cancelled) {
        reject(cancellationError());
        return;
      }
      const result: RunResult = { code, stdout, stderr, timedOut };
      if (error !== undefined) result.error = error;
      if (stdoutTruncated || stderrTruncated)
        result.truncated = {
          ...(stdoutTruncated ? { stdout: true } : {}),
          ...(stderrTruncated ? { stderr: true } : {}),
        };
      resolve(result);
    };
    const stop = (cancelled: boolean): void => {
      if (stopping || settled) return;
      stopping = true;
      clearTimeout(timer);
      const pid = child.pid;
      if (!pid) {
        finish(-1, undefined, cancelled);
        return;
      }
      if (process.platform === "win32") {
        try {
          const killer = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
            windowsHide: true,
            stdio: "ignore",
          });
          const done = (): void => {
            child.kill();
            finish(-1, undefined, cancelled);
          };
          killer.once("error", done);
          killer.once("close", done);
          terminationTimer = setTimeout(() => {
            killer.kill();
            done();
          }, 5000);
        } catch {
          child.kill();
          finish(-1, undefined, cancelled);
        }
      } else {
        try {
          process.kill(-pid, "SIGTERM");
        } catch {
          child.kill("SIGTERM");
        }
        terminationTimer = setTimeout(() => {
          try {
            process.kill(-pid, "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
          finish(-1, undefined, cancelled);
        }, 2000);
      }
    };
    const abort = (): void => stop(true);
    try {
      child = spawn(file, [...args], {
        windowsHide: true,
        windowsVerbatimArguments: opts.windowsVerbatimArguments,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
        env: opts.env ?? process.env,
        cwd: opts.cwd,
      });
    } catch (error) {
      finish(-1, (error as Error).message);
      return;
    }
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      const [text, truncated] = appendLimited(stdout, chunk, max);
      stdout = text;
      stdoutTruncated ||= truncated;
    });
    child.stderr?.on("data", (chunk: string) => {
      const [text, truncated] = appendLimited(stderr, chunk, max);
      stderr = text;
      stderrTruncated ||= truncated;
    });
    child.once("error", (error: NodeJS.ErrnoException) => {
      if (!stopping) finish(-1, error.message);
    });
    child.once("close", (code) => {
      if (!stopping) finish(code ?? -1);
    });
    opts.signal?.addEventListener("abort", abort, { once: true });
    if (opts.signal?.aborted) abort();
    if (!stopping && opts.timeoutMs)
      timer = setTimeout(() => {
        timedOut = true;
        stop(false);
      }, opts.timeoutMs);
  });
}
