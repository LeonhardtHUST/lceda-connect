import { mkdtemp, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { boolValue, parseArgs, stringValue, type OptionSpec } from "../core/cliArgs.ts";
import type { Io } from "../core/io.ts";
import { withExtensionManager, type WindowIdentity } from "./lifecycle.ts";
import {
  inspectExtensionPackage,
  readExtensionPackageBytes,
  validateExtensionDisplayName,
  validateExtensionName,
  validateExtensionUuid,
  validateExtensionVersion,
} from "./package.ts";

const local = ["file", "sha256"] as const;
const extension = ["name", "display-name", "uuid", "extension-version"] as const;
const target = ["port", "target", "project", "pcb"] as const;
const flags = ["confirm", "isolated-profile", "headless"] as const;
const options: readonly OptionSpec[] = [
  ...[...local, ...extension, ...target].map((name) => ({
    name,
    type: "string" as const,
    description: "",
  })),
  ...flags.map((name) => ({ name, type: "boolean" as const, description: "" })),
  { name: "json", type: "boolean", description: "输出 JSON（默认）" },
];

const help = [
  "lceda-connect extension inspect --file <包.eext>",
  "lceda-connect extension install --file <包.eext> --sha256 <SHA-256> <窗口选项>",
  "lceda-connect extension uninstall --uuid <UUID> --name <清单名> --display-name <显示名> --extension-version <版本> <窗口选项>",
  "窗口选项：--port <端口> --target <CDP target ID> --project <工程 UUID> --pcb <PCB UUID>",
  "默认只预览，不连接客户端。执行须同时传 --isolated-profile --confirm。",
  "实验性：仅 Windows 嘉立创 EDA 专业版 4.1.105 中文可见窗口。不支持 --headless，不授予权限。",
].join("\n");

function strictHex(value: string, pattern: RegExp, flag: string): string {
  if (!pattern.test(value)) throw new Error(`--${flag} 格式不合法。`);
  return value.toLowerCase();
}

/** Only hand off the bytes whose digest the operator confirmed, not the mutable input path. */
export async function withStagedPackage<T>(
  file: string,
  sha256: string,
  run: (staged: string) => Promise<T>,
): Promise<T> {
  const checked = await readExtensionPackageBytes(file);
  if (checked.sha256 !== sha256)
    throw new Error("包在预检后发生变化，拒绝安装。请重新检查 SHA-256。");
  const dir = await mkdtemp(path.join(tmpdir(), "lceda-extension-"));
  const stage = path.join(dir, "package.eext");
  let created = false;
  try {
    await writeFile(stage, checked.bytes, { flag: "wx", mode: 0o600 });
    created = true;
    return await run(stage);
  } finally {
    try {
      if (created) await unlink(stage);
      await rmdir(dir);
    } catch {
      // This is a copy of the package, not part of the EDA state. Preserve the primary result.
    }
  }
}

export async function runExtensionCommand(argv: readonly string[], io: Io): Promise<number> {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h") || argv[0] === "help") {
    io.out(help);
    return 0;
  }
  try {
    const [verb, ...rest] = argv;
    const args = parseArgs(rest, options);
    if (
      args.positionals.length ||
      (verb !== "inspect" && verb !== "install" && verb !== "uninstall")
    ) {
      throw new Error("只接受 inspect、install、uninstall；见 extension --help。");
    }
    const exactOptions: readonly string[] =
      verb === "inspect"
        ? ["file", "json"]
        : [...(verb === "install" ? local : extension), ...target, ...flags, "json"];
    for (const option of Object.keys(args.values)) {
      if (!exactOptions.includes(option)) throw new Error(`${verb} 不接受 --${option}。`);
    }
    const required = (name: string): string => {
      const value = stringValue(args, name);
      if (!value) throw new Error(`缺少 --${name}。`);
      return value;
    };
    const out = (result: unknown): void => io.out(JSON.stringify(result, null, 2));
    if (verb === "inspect") {
      out(await inspectExtensionPackage(required("file")));
      return 0;
    }
    if (boolValue(args, "headless"))
      throw new Error("扩展安装/卸载没有经验证的无头入口；请使用隔离的可见客户端。");
    const confirmed = boolValue(args, "confirm");
    if (confirmed && !boolValue(args, "isolated-profile")) {
      throw new Error(
        "执行须显式声明 --isolated-profile；仅限独立 OS 用户或虚拟机中的测试客户端。",
      );
    }
    const operation =
      verb === "install"
        ? await inspectExtensionPackage(required("file"))
        : {
            uuid: validateExtensionUuid(required("uuid")),
            name: validateExtensionName(required("name")),
            displayName: validateExtensionDisplayName(required("display-name")),
            version: validateExtensionVersion(required("extension-version")),
          };
    const shaInput = stringValue(args, "sha256");
    const sha256 = confirmed && verb === "install" ? required("sha256") : shaInput;
    if (
      sha256 !== undefined &&
      "path" in operation &&
      strictHex(sha256, /^[0-9a-f]{64}$/i, "sha256") !== operation.sha256
    ) {
      throw new Error("包 SHA-256 不匹配，拒绝安装。");
    }
    if (!confirmed && !target.some((name) => args.values[name] !== undefined)) {
      out({ mode: "preview", action: verb, extension: operation, connected: false });
      return 0;
    }
    const portArg = required("port");
    if (!/^\d{1,5}$/.test(portArg) || Number(portArg) < 1 || Number(portArg) > 65535) {
      throw new Error("--port 必须是 1–65535 的整数。");
    }
    const window: WindowIdentity = {
      port: Number(portArg),
      target: strictHex(required("target"), /^[0-9a-f]{32}$/i, "target").toUpperCase(),
      project: strictHex(required("project"), /^(?:[0-9a-f]{32}|[0-9a-f]{64})$/i, "project"),
      pcb: strictHex(required("pcb"), /^(?:[0-9a-f]{16}|[0-9a-f]{32})$/i, "pcb"),
    };
    if (!confirmed) {
      out({ mode: "preview", action: verb, extension: operation, window, connected: false });
      return 0;
    }
    if (process.platform !== "win32") throw new Error("当前安装/卸载适配只支持 Windows。");
    if ("path" in operation) {
      const readback = await withStagedPackage(operation.path, operation.sha256, (stage) =>
        withExtensionManager(window, operation, (manager) => manager.install(stage)),
      );
      out({ mode: "visible-ui", action: verb, installed: true, extension: operation, ...readback });
    } else {
      await withExtensionManager(window, operation, (manager) => manager.uninstall());
      out({ mode: "visible-ui", action: verb, removedFromManager: true, extension: operation });
    }
    return 0;
  } catch (err) {
    io.err(err instanceof Error ? err.message : String(err));
    return 1;
  }
}
