import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { expect, test } from "vite-plus/test";

const SCRIPT = path.join(import.meta.dirname, "..", "scripts", "release-version.mjs");
// 端到端用例要建临时 git 仓库，Windows 上 git 启动开销明显，给足超时。
const E2E_TIMEOUT = 30000;

interface ReleaseModule {
  parseReleaseTitle(title: string): string | null;
  parseStableVersion(value: string): { major: number; minor: number; patch: number } | null;
  compareVersions(left: string, right: string): number;
  assertReleaseTransition(input: {
    previous: { name?: string; version?: string };
    current: { name?: string; version?: string };
    expectedVersion?: string;
  }): string;
  classifyRegistryStatus(status: number): "absent" | "present" | null;
  fetchPublishedVersion(input: {
    registry: string;
    name: string;
    version: string;
    fetchImpl: () => Promise<Response>;
  }): Promise<"absent" | "present">;
  registryVersionUrl(input: { registry: string; name: string; version: string }): string;
}

const release = (await import(pathToFileURL(SCRIPT).href)) as ReleaseModule;

interface CommitSpec {
  version: string;
  title: string;
  name?: string;
}

function git(cwd: string, args: string[]): void {
  try {
    execFileSync("git", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
    });
  } catch (error) {
    const stderr = (error as { stderr?: Buffer | string }).stderr?.toString() ?? "";
    throw new Error(`git ${args.join(" ")} 失败：${stderr.trim()}`);
  }
}

function makeRepo(commits: CommitSpec[]): string {
  const directory = mkdtempSync(path.join(tmpdir(), "lceda-release-"));
  git(directory, ["init", "--quiet"]);
  for (const [index, commit] of commits.entries()) {
    const manifest = { name: commit.name ?? "lceda-connect", version: commit.version };
    writeFileSync(
      path.join(directory, "package.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );
    // 每个提交都带一处额外改动，这样"版本没变"的提交也能真实创建。
    writeFileSync(path.join(directory, "marker.txt"), `${index}\n`, "utf8");
    git(directory, ["add", "-A"]);
    git(directory, [
      "-c",
      "user.name=release",
      "-c",
      "user.email=release@example.com",
      "commit",
      "--no-gpg-sign",
      "--no-verify",
      "--quiet",
      "-m",
      commit.title,
    ]);
  }
  return directory;
}

interface PlanRun {
  status: number | null;
  stdout: string;
  stderr: string;
  output: string;
  summary: string;
}

// 必须异步等待子进程：同步阻塞会让测试进程里的 registry 服务无法响应脚本的查询。
function runPlan(cwd: string, args: string[] = []): Promise<PlanRun> {
  const outputFile = path.join(cwd, "github-output.txt");
  const summaryFile = path.join(cwd, "github-summary.md");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, "plan", ...args], {
      cwd,
      env: { ...process.env, GITHUB_OUTPUT: outputFile, GITHUB_STEP_SUMMARY: summaryFile },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (status) => {
      resolve({
        status,
        stdout,
        stderr,
        output: existsSync(outputFile) ? readFileSync(outputFile, "utf8") : "",
        summary: existsSync(summaryFile) ? readFileSync(summaryFile, "utf8") : "",
      });
    });
  });
}

interface Registry {
  url: string;
  requests: string[];
  close: () => Promise<void>;
}

// status 为数字时按该状态码响应；"drop" 直接断开连接；"interrupt-200" 先发 200 响应头
// 再中断响应体，用来模拟「状态码拿到了、内容读不完」；"redirect" 返回 302。
async function startRegistry(
  status: number | "drop" | "interrupt-200" | "redirect",
): Promise<Registry> {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? "");
    if (status === "drop") {
      request.destroy();
      return;
    }
    if (status === "redirect") {
      response.writeHead(302, { location: "https://example.invalid/lceda-connect/0.2.0" });
      response.end();
      return;
    }
    if (status === "interrupt-200") {
      response.writeHead(200, {
        "content-type": "application/json",
        "content-length": "4096",
      });
      response.write('{"name":');
      response.destroy();
      return;
    }
    response.writeHead(status, { "content-type": "application/json" });
    response.end(
      status === 200
        ? JSON.stringify({ name: "lceda-connect", version: "0.2.0" })
        : JSON.stringify({ error: "not found" }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}/`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

async function withRepo<T>(
  commits: CommitSpec[],
  body: (directory: string) => Promise<T>,
): Promise<T> {
  const directory = makeRepo(commits);
  try {
    return await body(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("发布标题必须精确匹配 chore(release): 发布 vX.Y.Z", () => {
  expect(release.parseReleaseTitle("chore(release): 发布 v0.2.0")).toBe("0.2.0");
  expect(release.parseReleaseTitle("chore(release): 发布 v10.20.30")).toBe("10.20.30");
  for (const rejected of [
    "chore(release): 发布 v0.2.0 ",
    " chore(release): 发布 v0.2.0",
    "chore(release):发布 v0.2.0",
    "chore(release): 发布 0.2.0",
    "chore(release): 发布 v0.2",
    "chore(release): 发布 v0.2.0-rc.1",
    "chore(release): 发布 v01.2.0",
    "Chore(Release): 发布 v0.2.0",
    "feat: 发布 v0.2.0",
    "chore(release): 发布 v0.2.0\n\n正文",
  ]) {
    expect(release.parseReleaseTitle(rejected), rejected).toBeNull();
  }
});

test("目标版本必须是稳定 SemVer", () => {
  expect(release.parseStableVersion("1.2.3")).toEqual({ major: 1, minor: 2, patch: 3 });
  expect(release.parseStableVersion("0.0.0")).toEqual({ major: 0, minor: 0, patch: 0 });
  expect(release.parseStableVersion("9007199254740991.0.0")).toEqual({
    major: Number.MAX_SAFE_INTEGER,
    minor: 0,
    patch: 0,
  });
  for (const rejected of [
    "v1.2.3",
    "1.2",
    "01.2.3",
    "1.2.3-rc.1",
    "1.2.3+build",
    " 1.2.3",
    "1.2.3 ",
    // 超出安全整数的段在浮点转换后会失真，必须拒绝而不是截断或取整
    "9007199254740992.0.0",
    "0.9007199254740992.0",
    "0.0.9007199254740993",
    "99999999999999999999.0.0",
  ]) {
    expect(release.parseStableVersion(rejected), rejected).toBeNull();
  }
});

test("版本按数字段比较，不能按字符串比较", () => {
  expect(release.compareVersions("0.2.0", "0.1.0")).toBe(1);
  expect(release.compareVersions("0.1.0", "0.2.0")).toBe(-1);
  expect(release.compareVersions("1.0.0", "1.0.0")).toBe(0);
  expect(release.compareVersions("0.10.0", "0.9.9")).toBe(1);
  expect(release.compareVersions("1.0.0", "0.99.99")).toBe(1);
});

test("发布提交必须保持包名并严格提升稳定版本", () => {
  const previous = { name: "lceda-connect", version: "0.1.0" };
  expect(
    release.assertReleaseTransition({
      previous,
      current: { name: "lceda-connect", version: "0.2.0" },
      expectedVersion: "0.2.0",
    }),
  ).toBe("0.2.0");
  expect(() =>
    release.assertReleaseTransition({
      previous,
      current: { name: "lceda-connect", version: "0.1.0" },
    }),
  ).toThrow(/严格前进/u);
  expect(() =>
    release.assertReleaseTransition({
      previous,
      current: { name: "lceda-connect", version: "0.0.9" },
    }),
  ).toThrow(/严格前进/u);
  expect(() =>
    release.assertReleaseTransition({
      previous,
      current: { name: "lceda-connect", version: "0.2.0-rc.1" },
    }),
  ).toThrow(/稳定 SemVer/u);
  expect(() =>
    release.assertReleaseTransition({
      previous,
      current: { name: "lceda-connect-fork", version: "0.2.0" },
    }),
  ).toThrow(/包名发生变化/u);
  expect(() =>
    release.assertReleaseTransition({
      previous,
      current: { name: "lceda-connect", version: "0.2.0" },
      expectedVersion: "0.3.0",
    }),
  ).toThrow(/提交标题写着/u);
});

test("只有 registry 的 200 / 404 能判定版本状态", () => {
  expect(release.classifyRegistryStatus(200)).toBe("present");
  expect(release.classifyRegistryStatus(404)).toBe("absent");
  for (const unknown of [301, 401, 403, 429, 500, 503]) {
    expect(release.classifyRegistryStatus(unknown), String(unknown)).toBeNull();
  }
  expect(
    release.registryVersionUrl({
      registry: "https://registry.npmjs.org/",
      name: "lceda-connect",
      version: "0.2.0",
    }),
  ).toBe("https://registry.npmjs.org/lceda-connect/0.2.0");
  expect(
    release.registryVersionUrl({
      registry: "https://registry.example.test/prefix",
      name: "@scope/pkg",
      version: "1.0.0",
    }),
  ).toBe("https://registry.example.test/prefix/@scope%2Fpkg/1.0.0");
});

test(
  "普通 push 不发布，也不访问 registry",
  async () => {
    const registry = await startRegistry(404);
    try {
      await withRepo(
        [
          { version: "0.1.0", title: "feat: 新增 MCP 工具" },
          { version: "0.1.1", title: "fix: 修正写盘校验" },
        ],
        async (directory) => {
          const run = await runPlan(directory, ["--registry", registry.url]);
          expect(run.status).toBe(0);
          expect(run.output).toContain("publish=false");
          expect(run.output).toContain("reason=no-release-intent");
          expect(registry.requests).toEqual([]);
        },
      );
    } finally {
      await registry.close();
    }
  },
  E2E_TIMEOUT,
);

test(
  "合法发布提交判定为发布",
  async () => {
    const registry = await startRegistry(404);
    try {
      await withRepo(
        [
          { version: "0.1.0", title: "feat: 新增 MCP 工具" },
          { version: "0.2.0", title: "chore(release): 发布 v0.2.0" },
        ],
        async (directory) => {
          const run = await runPlan(directory, ["--registry", registry.url]);
          expect(run.status).toBe(0);
          expect(run.output).toContain("publish=true");
          expect(run.output).toContain("version=0.2.0");
          expect(run.output).toContain("reason=release");
          expect(run.summary).toContain("v0.2.0");
          expect(registry.requests).toEqual(["/lceda-connect/0.2.0"]);
        },
      );
    } finally {
      await registry.close();
    }
  },
  E2E_TIMEOUT,
);

test(
  "标题版本与 package.json 不一致时失败",
  async () => {
    await withRepo(
      [
        { version: "0.1.0", title: "feat: 初始提交" },
        { version: "0.2.0", title: "chore(release): 发布 v0.3.0" },
      ],
      async (directory) => {
        const run = await runPlan(directory);
        expect(run.status).toBe(1);
        expect(run.stdout).toContain("::error::");
        expect(run.stderr).toContain("提交标题写着 v0.3.0");
        expect(run.output).toBe("");
      },
    );
  },
  E2E_TIMEOUT,
);

test(
  "明确发布意图但版本没有前进时失败",
  async () => {
    await withRepo(
      [
        { version: "0.1.0", title: "feat: 初始提交" },
        { version: "0.1.0", title: "chore(release): 发布 v0.1.0" },
      ],
      async (directory) => {
        const run = await runPlan(directory);
        expect(run.status).toBe(1);
        expect(run.stderr).toContain("版本必须严格前进");
      },
    );
  },
  E2E_TIMEOUT,
);

test(
  "发布提交改动包名时失败",
  async () => {
    await withRepo(
      [
        { version: "0.1.0", title: "feat: 初始提交" },
        { name: "lceda-connect-fork", version: "0.2.0", title: "chore(release): 发布 v0.2.0" },
      ],
      async (directory) => {
        const run = await runPlan(directory);
        expect(run.status).toBe(1);
        expect(run.stderr).toContain("包名发生变化");
      },
    );
  },
  E2E_TIMEOUT,
);

test(
  "chore(release) 前缀但标题不合法时失败，不静默跳过",
  async () => {
    for (const title of [
      "chore(release): 发布 v0.2.0-rc.1",
      "chore(release): 发布 v0.2",
      "chore(release): 更新发布脚本",
    ]) {
      await withRepo(
        [
          { version: "0.1.0", title: "feat: 初始提交" },
          { version: "0.2.0", title },
        ],
        async (directory) => {
          const run = await runPlan(directory);
          expect(run.status, title).toBe(1);
          expect(run.stderr, title).toContain("发布意图但不合法");
          expect(run.output, title).toBe("");
        },
      );
    }
  },
  E2E_TIMEOUT,
);

test(
  "第一父提交不存在时失败，不在根提交上发布",
  async () => {
    await withRepo(
      [{ version: "0.2.0", title: "chore(release): 发布 v0.2.0" }],
      async (directory) => {
        const run = await runPlan(directory);
        expect(run.status).toBe(1);
        expect(run.stderr).toContain("HEAD^");
      },
    );
  },
  E2E_TIMEOUT,
);

test(
  "版本已存在时默认失败，--on-existing=skip 明确跳过",
  async () => {
    const registry = await startRegistry(200);
    try {
      await withRepo(
        [
          { version: "0.1.0", title: "feat: 初始提交" },
          { version: "0.2.0", title: "chore(release): 发布 v0.2.0" },
        ],
        async (directory) => {
          const failed = await runPlan(directory, ["--registry", registry.url]);
          expect(failed.status).toBe(1);
          expect(failed.stderr).toContain("已经发布过");

          const skipped = await runPlan(directory, [
            "--registry",
            registry.url,
            "--on-existing=skip",
          ]);
          expect(skipped.status).toBe(0);
          expect(skipped.output).toContain("publish=false");
          expect(skipped.output).toContain("reason=already-published");
        },
      );
    } finally {
      await registry.close();
    }
  },
  E2E_TIMEOUT,
);

test(
  "registry 返回 5xx 时失败，不当作未发布",
  async () => {
    const registry = await startRegistry(503);
    try {
      await withRepo(
        [
          { version: "0.1.0", title: "feat: 初始提交" },
          { version: "0.2.0", title: "chore(release): 发布 v0.2.0" },
        ],
        async (directory) => {
          const run = await runPlan(directory, ["--registry", registry.url]);
          expect(run.status).toBe(1);
          expect(run.stderr).toContain("无法确认");
          expect(run.stderr).toContain("查询失败不等于未发布");
          expect(run.output).toBe("");
        },
      );
    } finally {
      await registry.close();
    }
  },
  E2E_TIMEOUT,
);

test(
  "registry 连接被断开时失败，不当作未发布",
  async () => {
    const registry = await startRegistry("drop");
    try {
      await withRepo(
        [
          { version: "0.1.0", title: "feat: 初始提交" },
          { version: "0.2.0", title: "chore(release): 发布 v0.2.0" },
        ],
        async (directory) => {
          const run = await runPlan(directory, ["--registry", registry.url]);
          expect(run.status).toBe(1);
          expect(run.stderr).toContain("无法确认");
          expect(run.output).toBe("");
        },
      );
    } finally {
      await registry.close();
    }
  },
  E2E_TIMEOUT,
);

test("registry 的 404 响应不完整时不视为版本可用", async () => {
  const body = new ReadableStream({
    start(controller) {
      controller.error(new Error("incomplete response"));
    },
  });
  await expect(
    release.fetchPublishedVersion({
      registry: "https://example.invalid/",
      name: "lceda-connect",
      version: "0.2.0",
      fetchImpl: async () => new Response(body, { status: 404 }),
    }),
  ).rejects.toMatchObject({ code: "EREGISTRY" });
});

test(
  "registry 返回 200 但响应体中断时失败，不当作可确认",
  async () => {
    const registry = await startRegistry("interrupt-200");
    try {
      await withRepo(
        [
          { version: "0.1.0", title: "feat: 初始提交" },
          { version: "0.2.0", title: "chore(release): 发布 v0.2.0" },
        ],
        async (directory) => {
          const run = await runPlan(directory, ["--registry", registry.url]);
          expect(run.status).toBe(1);
          expect(run.stderr).toContain("无法确认");
          expect(run.output).toBe("");
        },
      );
    } finally {
      await registry.close();
    }
  },
  E2E_TIMEOUT,
);

test(
  "registry 返回重定向时失败，不跟随到别的地址判定",
  async () => {
    const registry = await startRegistry("redirect");
    try {
      await withRepo(
        [
          { version: "0.1.0", title: "feat: 初始提交" },
          { version: "0.2.0", title: "chore(release): 发布 v0.2.0" },
        ],
        async (directory) => {
          const run = await runPlan(directory, ["--registry", registry.url]);
          expect(run.status).toBe(1);
          expect(run.stderr).toContain("无法确认");
          expect(run.output).toBe("");
        },
      );
    } finally {
      await registry.close();
    }
  },
  E2E_TIMEOUT,
);
