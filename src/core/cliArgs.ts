export interface OptionSpec {
  name: string;
  aliases?: readonly string[];
  type: "boolean" | "string" | "number";
  /** 帮助文本里的取值占位符，如 "N"。 */
  placeholder?: string;
  description: string;
}

export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

export interface ParsedArgs {
  positionals: string[];
  values: Record<string, string | number | boolean>;
}

type OptionValue = string | number | boolean;

function buildLookup(specs: readonly OptionSpec[]): Map<string, OptionSpec> {
  const lookup = new Map<string, OptionSpec>();
  for (const spec of specs) {
    lookup.set(spec.name.toLowerCase(), spec);
    for (const alias of spec.aliases ?? []) lookup.set(alias.toLowerCase(), spec);
  }
  return lookup;
}

function isOptionToken(token: string): boolean {
  return /^--?[A-Za-z]/.test(token);
}

/**
 * 解析命令行参数。
 * 同时接受 `--json` / `-json` / `-Json` 三种写法，方便从旧的 PowerShell 开关迁移过来。
 */
export function parseArgs(argv: readonly string[], specs: readonly OptionSpec[]): ParsedArgs {
  const lookup = buildLookup(specs);
  const positionals: string[] = [];
  const values: Record<string, OptionValue> = {};
  let index = 0;
  let optionsEnded = false;

  while (index < argv.length) {
    const token = argv[index] ?? "";
    index += 1;

    if (optionsEnded) {
      positionals.push(token);
      continue;
    }
    if (token === "--") {
      optionsEnded = true;
      continue;
    }
    if (!isOptionToken(token)) {
      positionals.push(token);
      continue;
    }

    const withoutDashes = token.replace(/^--?/, "");
    const equalsAt = withoutDashes.indexOf("=");
    const rawName = equalsAt >= 0 ? withoutDashes.slice(0, equalsAt) : withoutDashes;
    const inlineValue = equalsAt >= 0 ? withoutDashes.slice(equalsAt + 1) : undefined;
    const spec = lookup.get(rawName.toLowerCase());

    if (!spec) throw new CliUsageError(`不认识的选项：${token}`);

    if (spec.type === "boolean") {
      if (inlineValue !== undefined) {
        throw new CliUsageError(`选项 ${token} 不接受取值`);
      }
      values[spec.name] = true;
      continue;
    }

    let raw = inlineValue;
    if (raw === undefined) {
      const next = argv[index];
      if (next === undefined || isOptionToken(next)) {
        throw new CliUsageError(`选项 ${token} 缺少取值`);
      }
      raw = next;
      index += 1;
    }

    if (spec.type === "number") {
      const parsed = Number.parseInt(raw, 10);
      if (!Number.isFinite(parsed))
        throw new CliUsageError(`选项 ${token} 需要整数，收到 "${raw}"`);
      values[spec.name] = parsed;
    } else {
      values[spec.name] = raw;
    }
  }

  return { positionals, values };
}

export function boolValue(args: ParsedArgs, name: string): boolean {
  return args.values[name] === true;
}

export function stringValue(args: ParsedArgs, name: string): string | undefined {
  const value = args.values[name];
  return typeof value === "string" ? value : undefined;
}

export function numberValue(args: ParsedArgs, name: string): number | undefined {
  const value = args.values[name];
  return typeof value === "number" ? value : undefined;
}

/** 生成帮助里的「选项」段落。 */
export function formatOptions(specs: readonly OptionSpec[]): string[] {
  const rows = specs.map((spec) => {
    const flags = [`--${spec.name}`];
    for (const alias of spec.aliases ?? [])
      flags.push(alias.length === 1 ? `-${alias}` : `--${alias}`);
    const left = `${flags.join(", ")}${spec.placeholder ? ` <${spec.placeholder}>` : ""}`;
    return { left, description: spec.description };
  });
  const width = rows.reduce((max, row) => Math.max(max, row.left.length), 0);
  return rows.map((row) => `    ${row.left.padEnd(width + 2)}${row.description}`);
}
