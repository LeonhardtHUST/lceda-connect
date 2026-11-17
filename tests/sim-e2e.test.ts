import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, test } from "vite-plus/test";

import { buildDeck } from "../src/sim/deck.ts";
import { findNgspiceSync } from "../src/sim/ngspice.ts";
import { runSimulation } from "../src/sim/run.ts";

const ASCII_TRAN = `Title: tran
Plotname: Transient Analysis
Flags: real
No. Variables: 2
No. Points: 3
Variables:
\t0\ttime\ttime
\t1\tv(out)\tvoltage
Values:
0\t0.000000000000000e+00
\t0.000000000000000e+00
1\t1.000000000000000e-06
\t5.000000000000000e-01
2\t2.000000000000000e-06
\t1.000000000000000e+00
`;

function tempDir(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lceda-sim-e2e-"));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** Windows 无开发者模式/管理员权限时创建文件 symlink 会失败，返回 false 供调用方 skip。 */
function fileLink(target: string, link: string): boolean {
  try {
    fs.symlinkSync(target, link, process.platform === "win32" ? "file" : undefined);
    return true;
  } catch {
    return false;
  }
}

/** 目录链接优先用 junction（Windows 普通用户可创建），POSIX 用 dir symlink。 */
function dirLink(target: string, link: string): boolean {
  try {
    fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
    return true;
  } catch {
    return false;
  }
}

const windowsSkipNote = "当前环境无法创建符号链接（Windows 需要开发者模式或管理员权限）";

const RC_NETLIST = "* RC demo\nV1 in 0 DC 1\nR1 in out 1k\nC1 out 0 1u\n.end\n";

test("runSimulation forwards progress stages and signal to runner", async () => {
  const temp = tempDir();
  const controller = new AbortController();
  const stages: string[] = [];
  try {
    const result = await runSimulation({
      netlist: RC_NETLIST,
      mode: "op",
      workDir: temp.dir,
      signal: controller.signal,
      onProgress: (_done, _total, message) => {
        stages.push(message);
      },
      runner: async (_bin, _deck, options) => {
        expect(options.signal).toBe(controller.signal);
        controller.abort();
        return { code: 0, stdout: "", stderr: "", timedOut: false };
      },
    });
    expect(result.ok).toBe(true);
    expect(stages).toEqual(["写 deck", "运行 ngspice", "解析 raw", "计算指标"]);
  } finally {
    temp.cleanup();
  }
});

test("deck 里已经有 .control 时按现成 deck 跑，不重复注入", async () => {
  const deck = buildDeck(RC_NETLIST, "tran", "10p 600n");
  expect(deck.split(".control").length - 1).toBe(1);
  const temp = tempDir();
  try {
    const already = "* hand written deck\nR1 a 0 1k\n.control\nop\n.endc\n.end\n";
    const result = await runSimulation({
      netlist: already,
      mode: "op",
      workDir: temp.dir,
      runner: async (bin, deckPath) => {
        // 本机装了 ngspice 时 bin 是真路径，没装时是注入模式的占位名。
        expect(typeof bin).toBe("string");
        const written = fs.readFileSync(deckPath, "utf8");
        expect(written).toBe(already);
        expect(written.split(".control").length - 1).toBe(1);
        return { code: 0, stdout: "ok", stderr: "", timedOut: false };
      },
    });
    expect(result.ok).toBe(true);
    expect(result.raws).toHaveLength(0);
  } finally {
    temp.cleanup();
  }
});

test("runSimulation 编排：写 deck、跑执行器、解析 raw、算指标、落 manifest", async () => {
  const temp = tempDir();
  try {
    const result = await runSimulation({
      netlist: RC_NETLIST,
      mode: "tran",
      args: "10p 600n",
      workDir: temp.dir,
      metrics: [{ name: "out", metric: "tran_stats", node: "OUT" }],
      project: "rc-demo",
      runner: async (_bin, deckPath, options) => {
        const deck = fs.readFileSync(deckPath, "utf8");
        expect(deck).toContain("tran 10p 600n");
        expect(deck).toContain("write tran.raw");
        fs.writeFileSync(path.join(options.cwd ?? temp.dir, "tran.raw"), ASCII_TRAN, "utf8");
        return { code: 0, stdout: "fake ngspice ok", stderr: "", timedOut: false };
      },
    });
    expect(result.ok).toBe(true);
    expect(result.returncode).toBe(0);
    expect(result.raws).toHaveLength(1);
    expect(result.raws[0]?.name).toBe("tran.raw");
    expect(result.raws[0]?.csv).toBeTruthy();
    expect(result.plots).toBe(1);
    expect(Number(result.metrics["out"]!["max"])).toBeCloseTo(1, 6);
    expect(fs.existsSync(path.join(temp.dir, "deck.cir"))).toBe(true);
    expect(fs.existsSync(path.join(temp.dir, "stdout.txt"))).toBe(true);
    expect(fs.existsSync(result.manifestPath)).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(result.manifestPath, "utf8"));
    expect(manifest.source_project).toBe("rc-demo");
    expect(manifest.analysis.mode).toBe("tran");
    expect(manifest.runs[0].raw).toEqual(["tran.raw"]);
    expect(result.manifest.source_hash).toHaveLength(64);
  } finally {
    temp.cleanup();
  }
});

test("workDir 里预先存在的 reparse point 在执行前被拒绝", async (t) => {
  const temp = tempDir();
  const workDir = path.join(temp.dir, "work");
  const outsideDir = path.join(temp.dir, "outside");
  try {
    fs.mkdirSync(workDir);
    fs.mkdirSync(outsideDir);
    if (!dirLink(outsideDir, path.join(workDir, "linked"))) {
      t.skip(windowsSkipNote);
      return;
    }
    let ran = false;
    const error = await runSimulation({
      netlist: RC_NETLIST,
      mode: "op",
      workDir,
      runner: async () => {
        ran = true;
        return { code: 0, stdout: "", stderr: "", timedOut: false };
      },
    }).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(error).toMatchObject({ code: "PATH_NOT_ALLOWED" });
    expect(ran).toBe(false);
  } finally {
    temp.cleanup();
  }
});

test("stdout.txt 在运行中被换成 symlink 时拒绝写入且外部文件不变", async (t) => {
  const temp = tempDir();
  const workDir = path.join(temp.dir, "work");
  const outside = path.join(temp.dir, "outside.txt");
  fs.writeFileSync(outside, "KEEP", "utf8");
  let linked = true;
  try {
    const error = await runSimulation({
      netlist: RC_NETLIST,
      mode: "op",
      workDir,
      runner: async (_bin, _deck, options) => {
        linked = fileLink(outside, path.join(options.cwd ?? workDir, "stdout.txt"));
        return { code: 0, stdout: "should not be written", stderr: "", timedOut: false };
      },
    }).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    if (!linked) {
      t.skip(windowsSkipNote);
      return;
    }
    expect(error).toMatchObject({ code: "PATH_NOT_ALLOWED" });
    expect(fs.readFileSync(outside, "utf8")).toBe("KEEP");
  } finally {
    temp.cleanup();
  }
});

test("raw CSV 被 symlink 指向外部文件时拒绝写入且外部内容不变", async (t) => {
  const temp = tempDir();
  const workDir = path.join(temp.dir, "work");
  const outside = path.join(temp.dir, "outside.csv");
  fs.writeFileSync(outside, "KEEP", "utf8");
  let linked = true;
  try {
    const error = await runSimulation({
      netlist: RC_NETLIST,
      mode: "tran",
      args: "10p 600n",
      workDir,
      runner: async (_bin, _deck, options) => {
        const dir = options.cwd ?? workDir;
        fs.writeFileSync(path.join(dir, "tran.raw"), ASCII_TRAN, "utf8");
        linked = fileLink(outside, path.join(dir, "tran.csv"));
        return { code: 0, stdout: "ok", stderr: "", timedOut: false };
      },
    }).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    if (!linked) {
      t.skip(windowsSkipNote);
      return;
    }
    expect(error).toMatchObject({ code: "PATH_NOT_ALLOWED" });
    expect(fs.readFileSync(outside, "utf8")).toBe("KEEP");
  } finally {
    temp.cleanup();
  }
});

const ngspiceBin = findNgspiceSync(process.env);
const withNgspice = ngspiceBin ? test : test.skip;
const withoutNgspice = ngspiceBin ? test.skip : test;

withoutNgspice("没装 ngspice 时 runSimulation 抛 NGSPICE_NOT_FOUND", async () => {
  const temp = tempDir();
  try {
    await expect(
      runSimulation({ netlist: RC_NETLIST, mode: "tran", workDir: temp.dir }),
    ).rejects.toMatchObject({ code: "NGSPICE_NOT_FOUND" });
  } finally {
    temp.cleanup();
  }
});

withNgspice("真实 ngspice 端到端：tran 出 raw 并算指标", async () => {
  const temp = tempDir();
  try {
    const result = await runSimulation({
      netlist: RC_NETLIST,
      mode: "tran",
      args: "1u 5m",
      workDir: temp.dir,
      metrics: [{ name: "out", metric: "tran_stats", node: "OUT" }],
      ngspiceBin,
    });
    expect(result.returncode).toBe(0);
    expect(result.raws.length).toBeGreaterThan(0);
    expect(Number(result.metrics["out"]!["max"])).toBeGreaterThan(0.5);
    expect(result.manifest.ngspice_version).toContain("ngspice");
  } finally {
    temp.cleanup();
  }
});
