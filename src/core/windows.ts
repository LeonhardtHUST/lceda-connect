import { run } from "./exec.ts";
import type { ProcInfo } from "./types.ts";

const IS_WINDOWS = process.platform === "win32";

/**
 * 解析 `ConvertTo-Json` 的输出：PowerShell 对单条结果会输出对象而不是数组。
 */
export function parseProcessJson(text: string): ProcInfo[] {
  const trimmed = text.replace(/^\uFEFF/, "").trim();
  if (trimmed === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const result: ProcInfo[] = [];
  for (const row of rows) {
    if (typeof row !== "object" || row === null) continue;
    const record = row as Record<string, unknown>;
    const pid = Number(record.ProcessId);
    if (!Number.isFinite(pid) || pid <= 0) continue;
    result.push({
      pid,
      name: typeof record.Name === "string" ? record.Name : "",
      commandLine: typeof record.CommandLine === "string" ? record.CommandLine : "",
    });
  }
  return result;
}

/**
 * 列出进程（含命令行）。命令行只有 Win32_Process 能拿到，因此固定走 PowerShell；
 * 非 Windows 平台返回空数组，调用方据此自然降级。
 */
export async function listProcesses(filterName?: string): Promise<ProcInfo[]> {
  if (!IS_WINDOWS) return [];
  const filter = filterName ? ` -Filter "Name='${filterName.replace(/'/g, "''")}'"` : "";
  const script =
    "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; " +
    `Get-CimInstance Win32_Process${filter} | ` +
    "Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress -Depth 3";
  const result = await run(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    { timeoutMs: 20_000 },
  );
  if (result.code !== 0) return [];
  return parseProcessJson(result.stdout);
}

/** pid 是否仍然存活（EPERM 说明存在但没权限，也算活着）。 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** 强杀整棵进程树（taskkill /F /T），返回 taskkill 退出码。 */
export async function killProcessTree(pid: number): Promise<number> {
  if (!Number.isFinite(pid) || pid <= 0) return 1;
  const result = await run("taskkill.exe", ["/F", "/T", "/PID", String(pid)], {
    timeoutMs: 15_000,
  });
  return result.code;
}

/** 结束单个进程（对应 PowerShell 的 Stop-Process）。 */
export function terminateProcess(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid);
    return true;
  } catch {
    return false;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
