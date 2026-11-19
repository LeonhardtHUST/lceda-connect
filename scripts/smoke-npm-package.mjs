#!/usr/bin/env node
/**
 * 发布包冒烟：把本地 tarball 装进全新临时目录，再用本地 npx 真实启动两个 stdio 入口。
 *
 *   node scripts/smoke-npm-package.mjs <tarball>
 *
 * 覆盖 --ignore-scripts 干净安装、bin shim 随包落地，以及 `npx lceda-connect mcp --toolsets
 * offline` 与 `npx --package=lceda-connect lceda-mcp` 的 JSON-RPC 握手、tools/list、lceda_info、
 * skill_docs（读取安装后的 assets）。客户端按行解析 stdout，每行必须是 id 对应的 JSON-RPC 2.0
 * 响应，日志只能走 stderr，协议通道被污染会直接失败。
 *
 * 边界：只接受本地 .tgz，不登录、不发布；npx 一律加 --offline（只读缓存/本地安装，绝不回退到
 * registry 下载），启动前先确认本地 bin shim 存在；子进程一律 `node npm-cli.js / npx-cli.js`
 * 直接 spawn（shell: false），Windows 与 POSIX 同一套逻辑；运行时目录只落在临时目录，退出时清理。
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TIMEOUT = 180_000;
const isWindows = process.platform === "win32";
const READY = "MCP 服务已在 stdio 上就绪";
const LIVE = /^(?:cdp|bridge|eda)_/u;
const INIT = {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "lceda-smoke", version: "0" },
};
const MESSAGES = [
  { id: 1, method: "initialize", params: INIT },
  { method: "notifications/initialized" },
  { id: 2, method: "tools/list", params: {} },
  { id: 3, method: "tools/call", params: { name: "lceda_info", arguments: {} } },
  {
    id: 4,
    method: "tools/call",
    params: { name: "skill_docs", arguments: { skill: "ngspice-sim", file: "SKILL.md" } },
  },
];

const tarballArg = process.argv.slice(2).find((arg) => !arg.startsWith("-"));
const log = (message) => process.stdout.write(`[smoke] ${message}\n`);
const check = (ok, message) => {
  if (!ok) throw new Error(message);
};
const tail = (value, limit = 1600) => String(value ?? "").slice(-limit);
const textOf = (result) =>
  (result?.content ?? []).find((entry) => entry?.type === "text")?.text ?? "";
/** 一律用 node 直接执行 CLI 脚本，不经 shell；stdin/stdout 按 utf8 收齐。 */
const nodeSync = (args, input, cwd, env, timeout) =>
  spawnSync(process.execPath, args, {
    input,
    cwd,
    env,
    timeout,
    encoding: "utf8",
    maxBuffer: 16 << 20,
    windowsHide: true,
  });

// 优先用与当前 node 同装的 npm CLI；找不到就明确报错，不猜 npm.cmd 之类的 shell 入口。
const nodeDir = path.dirname(process.execPath);
const npmCli = [
  process.env.npm_execpath,
  path.join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js"),
  path.join(nodeDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
].find((c) => c && c.endsWith("npm-cli.js") && fs.existsSync(c));
check(npmCli, "找不到 npm-cli.js：需要与当前 node 同装的 npm（Node 安装包与 setup-node 自带）");
const npxCli = path.join(path.dirname(npmCli), "npx-cli.js");
check(fs.existsSync(npxCli), `找不到 npx-cli.js：${npxCli}`);

/**
 * 本地 npx 跑一次 stdio 会话：initialize / initialized / tools/list / lceda_info / skill_docs
 * 一次性写进 stdin，服务端回完并因 EOF 退出后逐行校验 stdout。返回 { label, reply, tools, info }。
 */
function smokeSession(npxArgs, cwd, env) {
  const label = `npx ${npxArgs.join(" ")}`;
  const input = MESSAGES.map((m) => `${JSON.stringify({ jsonrpc: "2.0", ...m })}\n`).join("");
  const result = nodeSync([npxCli, "--offline", ...npxArgs], input, cwd, env, TIMEOUT);
  check(
    result.status === 0,
    `${label} 退出码 ${result.status}${result.signal ?? ""}：${tail(result.stderr)}`,
  );
  check(result.stderr.includes(READY), `${label}: stderr 没有就绪日志`);
  const replies = new Map();
  for (const line of result.stdout.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      throw new Error(`${label}: stdout 带非 JSON-RPC 输出（日志污染）: ${tail(line, 300)}`);
    }
    check(message?.jsonrpc === "2.0", `${label}: stdout 不是 JSON-RPC 2.0: ${tail(line, 300)}`);
    if (message.id !== undefined) replies.set(message.id, message);
  }
  const reply = (id) => {
    const message = replies.get(id);
    check(message, `${label}: 没有 id=${id} 的响应`);
    check(!message.error, `${label}: 请求 ${id} 失败 ${JSON.stringify(message.error)}`);
    return message.result;
  };
  return {
    label,
    reply,
    tools: reply(2).tools.map((tool) => tool.name),
    info: reply(3).structuredContent,
  };
}

async function main() {
  check(tarballArg, "缺少 tarball 路径参数（node scripts/smoke-npm-package.mjs <tarball>）");
  check(!/^[a-z][a-z0-9+.-]*:\/\//iu.test(tarballArg), `只接受本地 tarball：${tarballArg}`);
  const tarball = path.resolve(tarballArg);
  check(fs.existsSync(tarball) && fs.statSync(tarball).isFile(), `tarball 不存在：${tarball}`);
  check(/\.(?:tgz|tar\.gz)$/iu.test(tarball), `不是 .tgz：${tarball}`);

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "lceda-smoke-"));
  const installDir = path.join(workDir, "consumer");
  fs.mkdirSync(installDir, { recursive: true });
  fs.writeFileSync(
    path.join(installDir, "package.json"),
    '{"name":"lceda-smoke-consumer","private":true}\n',
  );
  const installEnv = { ...process.env, CI: "1", npm_config_update_notifier: "false" };
  delete installEnv.NODE_OPTIONS;
  const runEnv = { ...installEnv, npm_config_offline: "true", LCEDA_TOOLSETS: "" };
  runEnv.LCEDA_CONNECT_HOME = path.join(workDir, "home");
  runEnv.LCEDA_BRIDGE_RUNTIME = path.join(workDir, "bridge-runtime");
  log(`tarball: ${tarball}`);
  log(`临时目录: ${workDir}`);

  try {
    const installArgs = [
      npmCli,
      "install",
      tarball,
      "--no-audit",
      "--no-fund",
      "--ignore-scripts",
      "--loglevel=error",
    ];
    const install = nodeSync(installArgs, "", installDir, installEnv, TIMEOUT * 2);
    check(
      install.status === 0,
      `npm install 失败（${install.status}${install.signal ?? ""}）：${tail(install.stderr)}`,
    );

    const pkgDir = path.join(installDir, "node_modules", "lceda-connect");
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"));
    const binDir = path.join(installDir, "node_modules", ".bin");
    const assetsDir = path.join(pkgDir, "assets");
    const ext = isWindows ? ".cmd" : "";
    check(pkg.name === "lceda-connect", `包名不符：${pkg.name}`);
    for (const name of ["lceda-connect", "lceda-mcp"]) {
      check(pkg.bin?.[name], `缺少 bin.${name}`);
      check(fs.existsSync(path.join(binDir, name + ext)), `缺少 shim：${name}${ext}`);
    }
    check(fs.existsSync(path.join(assetsDir, "README.md")), "assets 未随包安装");
    log(`OK   npm install --ignore-scripts：${pkg.name}@${pkg.version}，shim 与 assets 就位`);

    const offline = smokeSession(
      ["lceda-connect", "mcp", "--toolsets", "offline"],
      installDir,
      runEnv,
    );
    check(!offline.tools.some((name) => LIVE.test(name)), "--toolsets offline 仍注册了在线工具");
    check(offline.info?.version === pkg.version, `lceda_info 版本不一致：${offline.info?.version}`);
    check(
      path.resolve(String(offline.info?.assetsDir)) === path.resolve(assetsDir),
      "lceda_info.assetsDir 不对",
    );
    check(textOf(offline.reply(4)).length > 200, "skill_docs 没读到安装后的 assets");
    log(`OK   ${offline.label}：${offline.tools.length} 个离线工具、lceda_info、skill_docs`);

    const explicit = smokeSession(
      ["--package=lceda-connect", "--", "lceda-mcp", "--toolsets", "offline"],
      installDir,
      runEnv,
    );
    check(
      JSON.stringify(explicit.tools) === JSON.stringify(offline.tools),
      "lceda-mcp --toolsets offline 与主入口工具集不一致",
    );
    check(explicit.info?.version === pkg.version, "独立入口版本与已安装包不一致");
    check(textOf(explicit.reply(4)).length > 200, "独立入口未读取到已安装的技能文档");
    log(`OK   ${explicit.label}：握手、lceda_info、${explicit.tools.length} 个离线工具\n全部通过`);
  } finally {
    try {
      fs.rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (error) {
      log(
        `清理失败（可手动删除 ${workDir}）：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

main().catch((error) => {
  process.stderr.write(`[smoke] FAIL: ${error instanceof Error ? error.message : error}\n`);
  process.exitCode = 1;
});
