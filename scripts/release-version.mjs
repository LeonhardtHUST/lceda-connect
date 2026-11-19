#!/usr/bin/env node
// 发布意图、版本前进与 registry 状态的判定入口。
//
// 只做读取：git 历史、提交里的 package.json、registry 的只读查询。不写仓库文件、不改版本号、
// 不发布。workflow 的 gate job 用 `node scripts/release-version.mjs plan` 调用它。
//
// 判定顺序：
//   1. HEAD 提交标题必须精确等于 `chore(release): 发布 vX.Y.Z`。不以 `chore(release):` 开头
//      的是普通 push，不发布；以它开头但整串不合法（多空格、缺 `v`、带 prerelease）属于
//      「意图明确但不合法」，直接失败，不会静默跳过；
//   2. 相对第一父提交，package.json 的 name 不变；
//   3. HEAD 的 version 是稳定 SemVer（不带 prerelease 和 build 元数据），且严格大于父提交版本；
//   4. 标题里的 X.Y.Z 必须等于 HEAD 的 version；
//   5. registry 只有明确返回 404 才当作「该版本尚未发布」。返回 200 表示版本已存在：默认失败
//      （版本号不可重用，需要换版本），`--on-existing=skip` 改为明确跳过。其他状态码、超时、
//      网络错误一律失败——「查不到」不能被当成「没发布」。

import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const RELEASE_TITLE = /^chore\(release\): 发布 v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
// 发布意图前缀。任何 `chore(release):` 开头的标题都当作发布意图：整串不合法就报错，
// 不允许静默降级成「普通 push」。没有该前缀的提交才是普通 push。
const RELEASE_INTENT = /^chore\(release\):/u;
const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const DEFAULT_REGISTRY = "https://registry.npmjs.org/";
const DEFAULT_TIMEOUT_MS = 15000;
const EXISTING_POLICIES = ["fail", "skip"];

export class ReleaseError extends Error {
  constructor(message, code, options) {
    super(message, options);
    this.name = "ReleaseError";
    this.code = code;
  }
}

// 标题里的版本，不是发布提交则返回 null。必须整串匹配：`chore(release): 发布 v1.2.3` 之外
// 的任何写法（前后空格、正文拼接、v 缺失、prerelease）都不算发布意图。
export function parseReleaseTitle(title) {
  if (typeof title !== "string") return null;
  const match = RELEASE_TITLE.exec(title);
  return match ? `${match[1]}.${match[2]}.${match[3]}` : null;
}

// 稳定 SemVer：拒绝 `v1.2.3`、`1.2`、`01.2.3`、`1.2.3-rc.1`、`1.2.3+build`。
// 每个数字段还必须是安全整数：超出 Number.MAX_SAFE_INTEGER 的段在浮点转换后可能相等，
// 会让「版本严格前进」的判定失效，因此直接拒绝，不做任何截断或取整。
export function parseStableVersion(value) {
  if (typeof value !== "string") return null;
  const match = STABLE_VERSION.exec(value);
  if (!match) return null;
  const parts = { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
  for (const part of Object.values(parts)) {
    if (!Number.isSafeInteger(part)) return null;
  }
  return parts;
}

// 返回 -1 / 0 / 1。按数字段比较，不能用字符串比较（0.10.0 大于 0.9.9）。
export function compareVersions(left, right) {
  const a = parseStableVersion(left);
  const b = parseStableVersion(right);
  if (!a || !b)
    throw new ReleaseError(`无法比较版本：${String(left)} 与 ${String(right)}`, "EVERSION");
  for (const key of ["major", "minor", "patch"]) {
    if (a[key] > b[key]) return 1;
    if (a[key] < b[key]) return -1;
  }
  return 0;
}

// 校验一次发布提交相对第一父提交的合法性，通过时返回目标版本。
export function assertReleaseTransition({ previous, current, expectedVersion }) {
  if (!previous?.name || !current?.name) {
    throw new ReleaseError("package.json 缺少 name，无法判断包身份", "EIDENTITY");
  }
  if (previous.name !== current.name) {
    throw new ReleaseError(`包名发生变化：${previous.name} → ${current.name}`, "EIDENTITY");
  }
  if (!parseStableVersion(previous.version)) {
    throw new ReleaseError(
      `第一父提交的版本不是稳定 SemVer：${String(previous.version)}`,
      "EVERSION",
    );
  }
  if (!parseStableVersion(current.version)) {
    throw new ReleaseError(`目标版本不是稳定 SemVer：${String(current.version)}`, "EVERSION");
  }
  if (compareVersions(current.version, previous.version) <= 0) {
    throw new ReleaseError(
      `版本必须严格前进：${previous.version} → ${current.version}`,
      "EVERSION",
    );
  }
  if (expectedVersion !== undefined && expectedVersion !== current.version) {
    throw new ReleaseError(
      `提交标题写着 v${expectedVersion}，package.json 是 ${current.version}`,
      "ETITLE",
    );
  }
  return current.version;
}

// registry 上的版本地址。scoped 包名按 registry 约定编码成 @scope%2Fname。
export function registryVersionUrl({ registry, name, version }) {
  const base = registry.endsWith("/") ? registry : `${registry}/`;
  const encodedName = name.startsWith("@")
    ? `@${encodeURIComponent(name.slice(1))}`
    : encodeURIComponent(name);
  return new URL(`${encodedName}/${encodeURIComponent(version)}`, base).href;
}

// 200 表示版本已存在，404 表示版本不存在，其余状态一律无法判定（返回 null）。
export function classifyRegistryStatus(status) {
  if (status === 404) return "absent";
  if (status === 200) return "present";
  return null;
}

// 查询 registry 上是否已有该版本。只有 404 返回 "absent"，任何无法判定的情况都抛错，
// 让发布流程失败而不是猜「没发布」。
export async function fetchPublishedVersion({
  registry,
  name,
  version,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  const url = registryVersionUrl({ registry, name, version });
  let response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: { accept: "application/json", "user-agent": "lceda-connect-release-gate" },
      // 跟随重定向会换掉真正的判定对象：redirect 一律当失败，不猜目标站点的状态码。
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new ReleaseError(
      `无法确认 ${name}@${version} 是否已发布：请求 ${url} 失败（${error?.message ?? error}）。查询失败不等于未发布，请重试`,
      "EREGISTRY",
      { cause: error },
    );
  }
  const state = classifyRegistryStatus(response.status);
  if (state === null) {
    throw new ReleaseError(
      `无法确认 ${name}@${version} 是否已发布：${url} 返回 HTTP ${response.status}。查询失败不等于未发布，请重试`,
      "EREGISTRY",
    );
  }
  // 确认响应完整结束，不能把返回 404 后中途断开的连接视为未发布。
  try {
    await response.arrayBuffer();
  } catch (error) {
    throw new ReleaseError(
      `无法确认 ${name}@${version} 是否已发布：${url} 返回 ${response.status} 但响应体读取中断（${error?.message ?? error}）`,
      "EREGISTRY",
      { cause: error },
    );
  }
  return state;
}

export function readCommitTitle({ rev = "HEAD", cwd = process.cwd() } = {}) {
  return git(["log", "-1", "--pretty=%s", rev], cwd).replace(/\r?\n$/u, "");
}

export function readCommitFile({ rev, file, cwd = process.cwd() }) {
  return git(["show", `${rev}:${file}`], cwd);
}

function git(args, cwd) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    const stderr = typeof error?.stderr === "string" ? error.stderr.trim() : "";
    throw new ReleaseError(
      `git ${args.join(" ")} 失败：${stderr || error?.message || String(error)}`,
      "EGIT",
      { cause: error },
    );
  }
}

function readPackageAt({ rev, cwd, label }) {
  const text = readCommitFile({ rev, file: "package.json", cwd });
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new ReleaseError(
      `${label}（${rev}）的 package.json 不是合法 JSON：${error.message}`,
      "EPACKAGE",
      { cause: error },
    );
  }
}

// 判定一次 push 该不该发布。返回 { publish, reason, title, version }。
// 明确发布意图但不合法时抛 ReleaseError：标题里写了 `chore(release): 发布` 却不满足
// 精确格式（例如带 prerelease、缺版本号），属于「意图明确但不合法」，必须失败而不是跳过。
export async function planRelease({
  cwd = process.cwd(),
  registry = DEFAULT_REGISTRY,
  onExisting = "fail",
  fetchImpl = globalThis.fetch,
} = {}) {
  const title = readCommitTitle({ cwd });
  if (!RELEASE_INTENT.test(title)) {
    return { publish: false, reason: "no-release-intent", title, version: "" };
  }
  const expectedVersion = parseReleaseTitle(title);
  if (expectedVersion === null) {
    throw new ReleaseError(
      `提交标题是发布意图但不合法：${title}。必须精确为「chore(release): 发布 vX.Y.Z」，版本是稳定 SemVer，不带 prerelease 或 build 元数据`,
      "ETITLE",
    );
  }

  // 版本前进以提交内容为准，不看工作区，避免脏工作区影响判定。
  const previous = readPackageAt({ rev: "HEAD^", cwd, label: "第一父提交" });
  const current = readPackageAt({ rev: "HEAD", cwd, label: "HEAD" });
  const version = assertReleaseTransition({ previous, current, expectedVersion });

  const state = await fetchPublishedVersion({ registry, name: current.name, version, fetchImpl });
  if (state === "present") {
    if (onExisting === "skip") {
      return { publish: false, reason: "already-published", title, version };
    }
    throw new ReleaseError(
      `${current.name}@${version} 已经发布过，版本号不可重用；请把版本提升到未发布的值`,
      "EPUBLISHED",
    );
  }
  return { publish: true, reason: "release", title, version };
}

function splitArgument(arg) {
  const index = arg.indexOf("=");
  return index === -1 ? [arg, undefined] : [arg.slice(0, index), arg.slice(index + 1)];
}

function parseOptions(argv) {
  const options = { registry: process.env.NPM_REGISTRY || DEFAULT_REGISTRY, onExisting: "fail" };
  for (let index = 0; index < argv.length; index += 1) {
    const [key, inline] = splitArgument(argv[index]);
    let value = inline;
    if (value === undefined) {
      value = argv[index + 1];
      index += 1;
    }
    if (value === undefined) throw new ReleaseError(`${key} 缺少参数值`, "EUSAGE");
    if (key === "--registry") {
      options.registry = value;
    } else if (key === "--on-existing") {
      options.onExisting = value;
    } else {
      throw new ReleaseError(`未知参数：${key}`, "EUSAGE");
    }
  }
  if (!EXISTING_POLICIES.includes(options.onExisting)) {
    throw new ReleaseError(
      `--on-existing 只能是 ${EXISTING_POLICIES.join(" 或 ")}，收到 ${options.onExisting}`,
      "EUSAGE",
    );
  }
  let registry;
  try {
    registry = new URL(options.registry);
  } catch (error) {
    throw new ReleaseError(`registry 不是合法 URL：${options.registry}`, "EUSAGE", {
      cause: error,
    });
  }
  if (registry.protocol !== "https:" && registry.protocol !== "http:") {
    throw new ReleaseError(`registry 只支持 http(s)：${options.registry}`, "EUSAGE");
  }
  return options;
}

function singleLine(text) {
  return String(text).replace(/\r?\n/gu, " ");
}

function writeOutputs(result, file = process.env.GITHUB_OUTPUT) {
  if (!file) return;
  const lines = [
    `publish=${result.publish ? "true" : "false"}`,
    `version=${result.version}`,
    `reason=${result.reason}`,
  ];
  appendFileSync(file, `${lines.join("\n")}\n`, "utf8");
}

function writeSummary(result, file = process.env.GITHUB_STEP_SUMMARY) {
  if (!file) return;
  const cell = (value) => String(value).replaceAll("|", "\\|");
  const rows = [
    ["判定", result.publish ? "发布" : "不发布"],
    ["原因", result.reason],
    ["目标版本", result.version ? `v${result.version}` : "—"],
    ["提交标题", result.title],
  ];
  const markdown = [
    "### 发布判定",
    "",
    "| 项 | 值 |",
    "| --- | --- |",
    ...rows.map(([key, value]) => `| ${key} | ${cell(value)} |`),
    "",
  ].join("\n");
  appendFileSync(file, markdown, "utf8");
}

export async function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  if (command !== "plan") {
    process.stderr.write(
      "用法：node scripts/release-version.mjs plan [--registry <url>] [--on-existing fail|skip]\n",
    );
    return 2;
  }
  try {
    const result = await planRelease(parseOptions(rest));
    writeOutputs(result);
    writeSummary(result);
    const suffix = result.version ? `（v${result.version}）` : "";
    process.stdout.write(`${result.publish ? "发布" : "不发布"}：${result.reason}${suffix}\n`);
    return 0;
  } catch (error) {
    const message = singleLine(error instanceof Error ? error.message : String(error));
    process.stdout.write(`::error::${message}\n`);
    process.stderr.write(`${message}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      // 可预期错误已经在 main 里转成 ::error:: 与退出码；这里兜底未预期异常。
      process.stderr.write(`${String(error?.message ?? error)}\n`);
      process.exitCode = 1;
    });
}
