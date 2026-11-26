import fs from "node:fs";
import path from "node:path";

import { z } from "zod";

/**
 * 运行时配置解析：把「命令行显式参数 > 配置文件 > .env > 进程环境 > 内置默认」
 * 收束成一个合并后的 env 对象，后续 `loadConfig` / MCP / CLI 只认这一份。
 *
 * 只做只读文件访问；不写盘、不改 process.env。所有路径都按 cwd 解析。
 */

export type ConfigSource = "argv" | "config-file" | "env-file" | "process-env" | "default";

export interface RuntimeResolution {
  /** 去掉全局选项后的 argv（命令组 / 动作 / 局部选项）。 */
  argv: string[];
  /** 合并后的环境变量（不修改 process.env）。 */
  env: NodeJS.ProcessEnv;
  configPath: string | null;
  envFilePath: string | null;
  /** 关键配置项最终来自哪里，用于 lceda env / 排查。 */
  sources: Record<string, ConfigSource>;
  warnings: string[];
}

export class RuntimeConfigError extends Error {
  readonly file: string | null;

  constructor(message: string, file: string | null = null) {
    super(message);
    this.name = "RuntimeConfigError";
    this.file = file;
  }
}

// ─── .env ───────────────────────────────────────────────────────────

export interface DotEnvResult {
  values: Record<string, string>;
  warnings: string[];
}

const DOTENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * 解析 .env。支持 `KEY=value`、`export KEY=value`、单/双引号、未加引号值里的
 * ` # 注释`。不做变量展开（避免与 shell 语义混淆）。
 */
export function parseDotEnv(text: string, file = ".env"): DotEnvResult {
  const values: Record<string, string> = {};
  const warnings: string[] = [];
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index] ?? "";
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const withoutExport = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
    const equals = withoutExport.indexOf("=");
    if (equals <= 0) {
      warnings.push(`${file}:${index + 1} 不是 KEY=VALUE，已跳过`);
      continue;
    }
    const key = withoutExport.slice(0, equals).trim();
    if (!DOTENV_KEY.test(key)) {
      warnings.push(`${file}:${index + 1} 键名不合法（${key}），已跳过`);
      continue;
    }
    let value = withoutExport.slice(equals + 1).trim();
    if (value.startsWith('"')) {
      const end = value.lastIndexOf('"');
      if (end <= 0) {
        warnings.push(`${file}:${index + 1} 双引号未闭合，已按字面量处理`);
      } else {
        value = value
          .slice(1, end)
          .replace(/\\n/g, "\n")
          .replace(/\\r/g, "\r")
          .replace(/\\t/g, "\t")
          .replace(/\\"/g, '"')
          .replace(/\\\\/g, "\\");
      }
    } else if (value.startsWith("'")) {
      const end = value.lastIndexOf("'");
      if (end <= 0) {
        warnings.push(`${file}:${index + 1} 单引号未闭合，已按字面量处理`);
      } else {
        value = value.slice(1, end);
      }
    } else {
      const comment = /\s+#/.exec(value);
      if (comment) value = value.slice(0, comment.index).trim();
    }
    values[key] = value;
  }
  return { values, warnings };
}

// ─── 配置文件 ────────────────────────────────────────────────────────

const EnvironmentConfigSchema = z
  .object({
    kind: z.enum(["auto", "windows-native", "wsl2", "linux-native", "macos-native"]).optional(),
    windowsHost: z.string().min(1).optional(),
    /** 客户端实例位置优先级：`["vm","host"]` 或 `"vm,host"`。 */
    clientLocations: z.union([z.string(), z.array(z.enum(["host", "vm"]))]).optional(),
  })
  .strict();

const CdpConfigSchema = z
  .object({
    host: z.string().min(1).optional(),
    port: z.number().int().min(1).max(65_535).optional(),
    /** 附加扫描区间 [start, end]。 */
    scan: z.tuple([z.number().int().min(1), z.number().int().min(1)]).optional(),
  })
  .strict();

const BridgeConfigSchema = z
  .object({
    host: z.string().min(1).optional(),
    portFirst: z.number().int().min(1).max(65_535).optional(),
    portLast: z.number().int().min(1).max(65_535).optional(),
    nodePath: z.string().min(1).optional(),
    script: z.string().min(1).optional(),
  })
  .strict();

const ClientConfigSchema = z
  .object({
    exePath: z.string().min(1).optional(),
  })
  .strict();

const McpHttpConfigSchema = z
  .object({
    host: z.string().min(1).optional(),
    port: z.number().int().min(0).max(65_535).optional(),
    path: z.string().min(1).optional(),
    token: z.string().min(1).optional(),
    stateless: z.boolean().optional(),
  })
  .strict();

const McpConfigSchema = z
  .object({
    toolsets: z.union([z.string(), z.array(z.string())]).optional(),
    http: McpHttpConfigSchema.optional(),
  })
  .strict();

export const ConfigFileSchema = z
  .object({
    $schema: z.string().optional(),
    environment: EnvironmentConfigSchema.optional(),
    client: ClientConfigSchema.optional(),
    cdp: CdpConfigSchema.optional(),
    bridge: BridgeConfigSchema.optional(),
    mcp: McpConfigSchema.optional(),
  })
  .strict();

export type ConfigFile = z.infer<typeof ConfigFileSchema>;

export interface ConfigFileResult {
  config: ConfigFile;
  warnings: string[];
}

function formatZodIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "<root>"}: ${issue.message}`)
    .join("; ");
}

export function parseConfigFile(
  text: string,
  file = "lceda-connect.config.json",
): ConfigFileResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new RuntimeConfigError(
      `${file} 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
      file,
    );
  }
  const result = ConfigFileSchema.safeParse(parsed);
  if (!result.success) {
    throw new RuntimeConfigError(`${file} 配置不合法：${formatZodIssues(result.error)}`, file);
  }
  return { config: result.data, warnings: [] };
}

/** 把配置文件映射成环境变量键；这是「配置文件 > .env / 进程环境」的落地点。 */
export function configToEnv(config: ConfigFile): Record<string, string> {
  const mapped: Record<string, string> = {};
  const environment = config.environment;
  if (environment) {
    if (environment.kind) {
      mapped.LCEDA_ENV = environment.kind;
      mapped.LCEDA_ENV_SOURCE = "config-file";
    }
    if (environment.windowsHost) {
      mapped.LCEDA_WINDOWS_HOST = environment.windowsHost;
      mapped.LCEDA_WINDOWS_HOST_SOURCE = "config-file";
    }
    if (environment.clientLocations) {
      mapped.LCEDA_LEDA_IN = Array.isArray(environment.clientLocations)
        ? environment.clientLocations.join(",")
        : environment.clientLocations;
      mapped.LCEDA_LEDA_IN_SOURCE = "config-file";
    }
  }
  if (config.client?.exePath) mapped.LCEDA_PRO_EXE = config.client.exePath;
  if (config.cdp?.host) mapped.LCEDA_CDP_HOST = config.cdp.host;
  if (typeof config.cdp?.port === "number") mapped.LCEDA_CDP_PORT = String(config.cdp.port);
  if (config.cdp?.scan) mapped.LCEDA_CDP_SCAN = config.cdp.scan.join("-");
  if (config.bridge?.host) mapped.LCEDA_BRIDGE_HOST = config.bridge.host;
  if (typeof config.bridge?.portFirst === "number") {
    mapped.LCEDA_BRIDGE_PORT_FIRST = String(config.bridge.portFirst);
  }
  if (typeof config.bridge?.portLast === "number") {
    mapped.LCEDA_BRIDGE_PORT_LAST = String(config.bridge.portLast);
  }
  if (config.bridge?.nodePath) mapped.LCEDA_NODE = config.bridge.nodePath;
  if (config.bridge?.script) mapped.LCEDA_BRIDGE_SCRIPT = config.bridge.script;
  if (config.mcp?.toolsets) {
    mapped.LCEDA_TOOLSETS = Array.isArray(config.mcp.toolsets)
      ? config.mcp.toolsets.join(",")
      : config.mcp.toolsets;
  }
  const http = config.mcp?.http;
  if (http) {
    if (http.host) mapped.LCEDA_HTTP_HOST = http.host;
    if (typeof http.port === "number") mapped.LCEDA_HTTP_PORT = String(http.port);
    if (http.path) mapped.LCEDA_HTTP_PATH = http.path;
    if (http.token) mapped.LCEDA_HTTP_TOKEN = http.token;
    if (http.stateless !== undefined) mapped.LCEDA_HTTP_STATELESS = String(http.stateless);
  }
  return mapped;
}

// ─── 全局选项 ────────────────────────────────────────────────────────

export interface GlobalOptionValue {
  name: string;
  value: string;
}

export interface ExtractedGlobals {
  argv: string[];
  options: GlobalOptionValue[];
}

export interface GlobalExtractOptions {
  /** 命令组 token 在 argv 里的下标；-1 表示命令组从 0 开始（defaultGroup bin）。 */
  groupIndex?: number;
  /**
   * 该命令组自己消费的同名局部选项。出现在命令组 token 之后的这些选项
   * 不再当全局参数（例如 `sim netlist --config sim.json`）。
   */
  localOptions?: readonly string[];
}

/** 全局选项名 → 环境变量键。全局选项在命令组解析前就被摘走。 */
export const GLOBAL_OPTION_ENV: Readonly<Record<string, string>> = {
  config: "LCEDA_CONFIG",
  "env-file": "LCEDA_ENV_FILE",
  env: "LCEDA_ENV",
  "lceda-in": "LCEDA_LEDA_IN",
  "windows-host": "LCEDA_WINDOWS_HOST",
  "cdp-host": "LCEDA_CDP_HOST",
  "bridge-host": "LCEDA_BRIDGE_HOST",
  exe: "LCEDA_PRO_EXE",
};

const GLOBAL_NAMES = new Set(Object.keys(GLOBAL_OPTION_ENV));

/**
 * 从 argv 里摘出全局选项，其余保持原顺序。只认 `--name value` 与 `--name=value`；
 * `--` 之后的参数不动（交给命令实现）。值以 `-` 开头时也照收（路径可能以 - 开头）。
 */
export function extractGlobalOptions(
  argv: readonly string[],
  extract: GlobalExtractOptions = {},
): ExtractedGlobals {
  const rest: string[] = [];
  const options: GlobalOptionValue[] = [];
  const groupIndex = extract.groupIndex ?? -1;
  const localOptions = new Set(extract.localOptions ?? []);
  let optionsEnded = false;
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index] ?? "";
    if (optionsEnded) {
      rest.push(token);
      continue;
    }
    if (token === "--") {
      optionsEnded = true;
      rest.push(token);
      continue;
    }
    if (!token.startsWith("--")) {
      rest.push(token);
      continue;
    }
    const withoutDashes = token.slice(2);
    const equalsAt = withoutDashes.indexOf("=");
    const name = (equalsAt >= 0 ? withoutDashes.slice(0, equalsAt) : withoutDashes).toLowerCase();
    if (!GLOBAL_NAMES.has(name)) {
      rest.push(token);
      continue;
    }
    // 命令组自己的同名选项（例如 sim 的 --config）留在原地，交给组内解析。
    if (localOptions.has(name) && groupIndex >= 0 && index >= groupIndex) {
      rest.push(token);
      continue;
    }
    if (equalsAt >= 0) {
      options.push({ name, value: withoutDashes.slice(equalsAt + 1) });
      continue;
    }
    const next = argv[index + 1];
    if (next === undefined) {
      throw new RuntimeConfigError(`全局选项 --${name} 缺少取值`);
    }
    options.push({ name, value: next });
    index += 1;
  }
  return { argv: rest, options };
}

/** 全局选项的显示值（帮助文本用）。 */
export const GLOBAL_HELP_ROWS: readonly { flag: string; description: string }[] = [
  {
    flag: "--config PATH",
    description: "配置文件（JSON）；显式参数 > 配置文件 > .env > 环境变量 > 默认",
  },
  { flag: "--env-file PATH", description: ".env 文件；只补未设置的键" },
  {
    flag: "--env KIND",
    description: "显式执行环境：auto/windows-native/wsl2/linux-native/macos-native（不自动发现）",
  },
  {
    flag: "--lceda-in LIST",
    description: "WSL2 下客户端实例位置优先级：host / vm / vm,host（默认 host）",
  },
  { flag: "--windows-host HOST", description: "WSL2 下 Windows 宿主地址（默认取默认网关）" },
  { flag: "--cdp-host HOST", description: "CDP 探测地址（覆盖环境推导）" },
  { flag: "--bridge-host HOST", description: "bridge 探测地址（覆盖环境推导）" },
  { flag: "--exe PATH", description: "客户端可执行文件（覆盖自动发现；WSL2 下可传 Windows 路径）" },
];

export interface ResolveRuntimeOptions {
  argv: readonly string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** 全局选项提取策略（命令组同名选项避让）。 */
  global?: GlobalExtractOptions;
  /** 测试注入。 */
  readFile?: (file: string) => string | null;
}

/** 关键环境项的「来源」标记键：让 loadConfig 能正确回报 argv / config-file / env。 */
const ENVIRONMENT_SOURCE_KEYS: Readonly<Record<string, string>> = {
  LCEDA_ENV: "LCEDA_ENV_SOURCE",
  LCEDA_WINDOWS_HOST: "LCEDA_WINDOWS_HOST_SOURCE",
  LCEDA_LEDA_IN: "LCEDA_LEDA_IN_SOURCE",
};

const SOURCE_KEYS = [
  "LCEDA_ENV",
  "LCEDA_LEDA_IN",
  "LCEDA_WINDOWS_HOST",
  "LCEDA_PRO_EXE",
  "LCEDA_CDP_HOST",
  "LCEDA_CDP_PORT",
  "LCEDA_BRIDGE_HOST",
  "LCEDA_BRIDGE_PORT_FIRST",
  "LCEDA_BRIDGE_PORT_LAST",
  "LCEDA_NODE",
  "LCEDA_BRIDGE_SCRIPT",
  "LCEDA_TOOLSETS",
];

/**
 * 解析运行时配置。优先级（高 → 低）：
 *   argv 全局参数 > 配置文件 > 显式 --env-file > 继承的进程环境 > 内置默认。
 * `.env` 只补「还没设置」的键，不会覆盖真实环境变量；配置文件则可以覆盖，
 * 因为它是用户为这个项目显式声明的。
 */
export function resolveRuntime(options: ResolveRuntimeOptions): RuntimeResolution {
  const baseEnv: NodeJS.ProcessEnv = { ...(options.env ?? process.env) };
  const cwd = options.cwd ?? process.cwd();
  const readFile =
    options.readFile ??
    ((file: string) => {
      try {
        return fs.readFileSync(file, "utf8");
      } catch {
        return null;
      }
    });
  const warnings: string[] = [];
  const sources: Record<string, ConfigSource> = {};
  const { argv, options: globalOptions } = extractGlobalOptions(options.argv, options.global);
  const argvValues = new Map<string, string>();
  for (const option of globalOptions) argvValues.set(option.name, option.value);

  // 1) .env：只补未设置的键（dotenv 语义）。
  let envFilePath: string | null = null;
  const envFileRequested = argvValues.get("env-file") ?? baseEnv.LCEDA_ENV_FILE ?? null;
  if (envFileRequested) {
    const resolved = path.resolve(cwd, envFileRequested);
    const text = readFile(resolved);
    if (text === null) {
      throw new RuntimeConfigError(`.env 文件不存在或不可读：${resolved}`, resolved);
    }
    envFilePath = resolved;
    const parsed = parseDotEnv(text, path.basename(resolved));
    warnings.push(...parsed.warnings);
    for (const [key, value] of Object.entries(parsed.values)) {
      if (baseEnv[key] === undefined) {
        baseEnv[key] = value;
        sources[key] = "env-file";
        if (ENVIRONMENT_SOURCE_KEYS[key]) baseEnv[ENVIRONMENT_SOURCE_KEYS[key]] = "env";
      }
    }
  }

  // 2) 配置文件：覆盖 .env / 进程环境。
  let configPath: string | null = null;
  const configRequested = argvValues.get("config") ?? baseEnv.LCEDA_CONFIG ?? null;
  if (configRequested) {
    const resolved = path.resolve(cwd, configRequested);
    const text = readFile(resolved);
    if (text === null) {
      throw new RuntimeConfigError(`配置文件不存在或不可读：${resolved}`, resolved);
    }
    configPath = resolved;
    const parsed = parseConfigFile(text, path.basename(resolved));
    warnings.push(...parsed.warnings);
    for (const [key, value] of Object.entries(configToEnv(parsed.config))) {
      baseEnv[key] = value;
      sources[key] = "config-file";
    }
  }

  // 3) argv 全局参数：最高优先级。
  for (const [name, value] of argvValues) {
    const key = GLOBAL_OPTION_ENV[name];
    if (!key) continue;
    baseEnv[key] = value;
    sources[key] = "argv";
    if (ENVIRONMENT_SOURCE_KEYS[key]) baseEnv[ENVIRONMENT_SOURCE_KEYS[key]] = "argv";
  }

  // 4) 记录剩余关键项的来源，供 lceda env / 排查使用。
  const merged: NodeJS.ProcessEnv = { ...baseEnv };
  for (const key of SOURCE_KEYS) {
    if (sources[key]) continue;
    sources[key] = merged[key] !== undefined ? "process-env" : "default";
    // 进程环境里直接设置的 LCEDA_ENV 等也要有正确的来源标记，否则环境会误报 argv。
    const sourceKey = ENVIRONMENT_SOURCE_KEYS[key];
    if (sourceKey && sources[key] === "process-env" && merged[sourceKey] === undefined) {
      merged[sourceKey] = "env";
    }
  }
  return { argv, env: merged, configPath, envFilePath, sources, warnings };
}

/** 是否存在配置文件（用于帮助与提示，不自动加载）。 */
export function looksLikeConfigFile(file: string): boolean {
  return /\.json$/i.test(file) && fs.existsSync(path.resolve(file));
}
