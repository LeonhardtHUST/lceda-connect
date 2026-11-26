import { loadConfig } from "../core/config.ts";
import { describeEnvironment, liveStrategy, type ClientLocation } from "../core/environment.ts";
import type { RuntimeResolution } from "../core/runtimeConfig.ts";
import { boolValue, parseArgs, type OptionSpec } from "../core/cliArgs.ts";
import { hr, paint } from "../core/term.ts";
import type { Io } from "../core/io.ts";

/**
 * `lceda-connect env` —— 执行环境自检（只读）。
 *
 * 回答四个问题：当前是什么环境、客户端装在哪、在线通道该往哪个地址连、
 * 配置最终来自哪里。不做网络写操作，也不启动客户端。
 */

const ENV_OPTIONS: readonly OptionSpec[] = [
  { name: "json", type: "boolean", description: "以 JSON 输出" },
  {
    name: "deep",
    type: "boolean",
    description: "额外用 where/which 深探客户端路径（较慢）",
  },
];

function envHelp(): string[] {
  return [
    "",
    paint.cyan("  lceda-connect env  --  执行环境与在线通道策略自检"),
    paint.gray(`  ${hr()}`),
    "  用法: lceda-connect env [选项]",
    "",
    paint.white("  选项:"),
    "    --json      以 JSON 输出",
    "    --deep      额外用 where/which 深探客户端路径（较慢）",
    "    --env KIND  显式环境（不做自动发现）",
    "    --lceda-in  WSL2 客户端位置：host / vm / vm,host（越靠前优先级越高）",
    "    --config    配置文件；--env-file 指定 .env",
    "",
    paint.gray("  例子: lceda-connect env --json"),
    "",
  ];
}

function locationLabel(location: ClientLocation): string {
  return location === "vm" ? "WSL VM" : "Windows 宿主";
}

export async function runEnvironmentCommand(
  argv: readonly string[],
  io: Io,
  env: NodeJS.ProcessEnv,
  runtime?: RuntimeResolution,
): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h") || argv.includes("help")) {
    io.out(envHelp().join("\n"));
    return 0;
  }
  let parsed;
  try {
    parsed = parseArgs(argv, ENV_OPTIONS);
  } catch (error) {
    io.err(paint.red(`  ${error instanceof Error ? error.message : String(error)}`));
    io.out(envHelp().join("\n"));
    return 1;
  }
  if (parsed.positionals.length > 0) {
    io.err(paint.red(`  多余的参数: ${parsed.positionals.join(" ")}`));
    io.out(envHelp().join("\n"));
    return 1;
  }

  const cfg = loadConfig(env, {}, { deepExe: boolValue(parsed, "deep") });
  const strategy = liveStrategy(cfg.environment, {
    cdpHost: cfg.cdp.host,
    bridgeHost: cfg.bridge.host,
  });
  const { environment, client } = cfg;
  const payload = {
    environment,
    liveStrategy: strategy,
    cdpProbeHosts: [...cfg.cdp.hosts],
    bridgeProbeHost: cfg.bridge.host,
    clientExe: {
      primary: client.exe
        ? {
            status: client.exe.status,
            path: client.exe.path,
            hostPath: client.exe.hostPath,
            location: client.exe.location,
            source: client.exe.source,
          }
        : null,
      locations: client.plan.locations.map((item) => ({
        location: item.location,
        status: item.status,
        path: item.path,
        source: item.source,
        candidates: item.candidates,
      })),
      warnings: client.plan.warnings,
    },
    config: {
      path: runtime?.configPath ?? null,
      envFile: runtime?.envFilePath ?? null,
      sources: runtime?.sources ?? {},
      warnings: runtime?.warnings ?? [],
    },
  };

  if (boolValue(parsed, "json")) {
    io.out(JSON.stringify(payload, null, 2));
    return client.exe ? 0 : 1;
  }

  io.out("");
  io.out(paint.cyan("  执行环境"));
  io.out(`    ${describeEnvironment(environment)}`);
  io.out(
    `    ${paint.gray(`宿主=${environment.hostOs} · 平台=${environment.platform} · 显式=${environment.explicit ? "是" : "否"} · 置信=${environment.confidence}`)}`,
  );
  if (environment.kind === "wsl2") {
    io.out(
      `    客户端位置优先级: ${environment.clientLocations.map(locationLabel).join(" → ")} ${paint.gray(`(${environment.clientLocationSource})`)}`,
    );
  }
  if (environment.windowsHost) {
    io.out(`    Windows 宿主地址: ${environment.windowsHost}`);
  }
  for (const item of environment.evidence) {
    io.out(paint.gray(`    · ${item.source}: ${item.value}`));
  }

  io.out("");
  io.out(paint.cyan("  客户端可执行文件"));
  if (client.exe) {
    io.out(`    ${paint.green("OK")} ${client.exe.path}`);
    io.out(
      paint.gray(
        `       来源=${client.exe.source} · 位置=${locationLabel(client.exe.location)} · hostPath=${client.exe.hostPath ?? "-"}`,
      ),
    );
  } else {
    io.out(`    ${paint.yellow("未找到")} 用 --exe 指定，或安装客户端后重试`);
  }
  for (const item of client.plan.locations) {
    if (item.status === "discovered" || item.status === "explicit") continue;
    const tried = item.candidates.slice(0, 6).map((candidate) => candidate.path);
    io.out(paint.gray(`    ${locationLabel(item.location)}: ${item.status}`));
    for (const candidate of tried) io.out(paint.gray(`      - ${candidate}`));
    if (item.candidates.length > tried.length) {
      io.out(paint.gray(`      … 另有 ${item.candidates.length - tried.length} 个候选未显示`));
    }
  }

  io.out("");
  io.out(paint.cyan("  在线通道策略"));
  io.out(`    ${strategy.summary}`);
  for (const item of strategy.locations) {
    io.out(
      paint.gray(
        `    · ${locationLabel(item.location)}: CDP ${item.cdpHosts.join(" → ")} · bridge ${item.bridgeHost}${item.bridgeReachable ? "" : "（跨命名空间不可达）"}`,
      ),
    );
  }
  io.out(`    CDP 探测地址: ${strategy.cdpHosts.join(" → ")}`);
  io.out(`    下一步: ${strategy.nextAction}`);

  if (runtime?.configPath || runtime?.envFilePath) {
    io.out("");
    io.out(paint.cyan("  配置来源"));
    if (runtime.configPath) io.out(`    配置文件: ${runtime.configPath}`);
    if (runtime.envFilePath) io.out(`    .env: ${runtime.envFilePath}`);
    const nonDefault = Object.entries(runtime.sources)
      .filter(([, source]) => source !== "default")
      .map(([key, source]) => `${key}=${source}`);
    if (nonDefault.length > 0) io.out(paint.gray(`    ${nonDefault.join(" · ")}`));
  }

  const warnings = [...environment.warnings, ...client.plan.warnings, ...(runtime?.warnings ?? [])];
  if (warnings.length > 0) {
    io.out("");
    io.out(paint.yellow("  提醒"));
    for (const warning of warnings) io.out(`    ! ${warning}`);
  }
  io.out("");
  return client.exe ? 0 : 1;
}
