import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, test } from "vite-plus/test";

import { run } from "../src/core/exec.ts";
import { runSimSidecar } from "../src/sim/sidecar.ts";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 8000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Process state did not change before deadline");
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}

test("run preserves default output and exit code", async () => {
  const result = await run(process.execPath, [
    "-e",
    "process.stdout.write('hello');process.stderr.write('warning');process.exitCode=3",
  ]);
  expect(result).toEqual({ code: 3, stdout: "hello", stderr: "warning", timedOut: false });
});

test("run bounds each stream while retaining head and tail", async () => {
  const limit = 2 * 1024 * 1024;
  const result = await run(
    process.execPath,
    [
      "-e",
      "const text='HEAD'+ 'x'.repeat(3*1024*1024)+'TAIL';process.stdout.write(text);process.stderr.write(text)",
    ],
    { maxOutputBytes: limit },
  );
  for (const text of [result.stdout, result.stderr]) {
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(limit);
    expect(text.startsWith("HEAD")).toBe(true);
    expect(text.endsWith("TAIL")).toBe(true);
  }
  expect(result.truncated).toEqual({ stdout: true, stderr: true });
});

test("timeout kills child and grandchild processes", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lceda-exec-"));
  const pidFile = path.join(dir, "pid");
  const grandchild = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000)`;
  const child = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'ignore'});setInterval(()=>{},1000)`;
  const parent = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:'ignore'});setInterval(()=>{},1000)`;
  try {
    const result = await run(process.execPath, ["-e", parent], { timeoutMs: 1500 });
    expect(result.timedOut).toBe(true);
    expect(fs.existsSync(pidFile)).toBe(true);
    const pid = Number(fs.readFileSync(pidFile, "utf8"));
    await waitFor(() => !alive(pid));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 15000);

test("abort rejects with identifiable cancellation and kills process", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lceda-abort-"));
  const pidFile = path.join(dir, "pid");
  const controller = new AbortController();
  const promise = run(
    process.execPath,
    [
      "-e",
      `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000)`,
    ],
    { signal: controller.signal },
  );
  const rejection = expect(promise).rejects.toMatchObject({
    name: "AbortError",
    code: "CANCELLED",
  });
  try {
    await waitFor(() => fs.existsSync(pidFile));
    const pid = Number(fs.readFileSync(pidFile, "utf8"));
    controller.abort();
    await rejection;
    await waitFor(() => !alive(pid));
  } finally {
    controller.abort();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 15000);

test.skipIf(process.platform !== "win32")(
  "explicit batch interpreter rejects unsafe arguments and executes plain arguments",
  async () => {
    if (process.platform !== "win32") return;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lceda-batch-"));
    const batch = path.join(dir, "python.cmd");
    fs.writeFileSync(batch, "@echo off\r\necho plain-output\r\n");
    try {
      await expect(
        runSimSidecar("sim_exec.py", ["unsafe&arg"], { python: batch }),
      ).rejects.toMatchObject({ code: "UNSAFE_ARGUMENT" });
      await expect(
        runSimSidecar("sim_exec.py", [], { python: 'C:\\safe.bat" & whoami & "x.bat' }),
      ).rejects.toMatchObject({ code: "UNSAFE_ARGUMENT" });
      const result = await runSimSidecar("sim_exec.py", ["plain argument"], { python: batch });
      expect(result.ok).toBe(true);
      expect(result.stdout).toContain("plain-output");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);
