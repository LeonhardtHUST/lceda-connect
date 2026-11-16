/**
 * ngspice deck 生成器：清洗 LCEDA 网表 + 注入 .control 分析脚本
 * （源仓库 scripts/build_deck.py）。
 *
 * 清洗规则（LCEDA 网表实测坑）：
 *   - 元件值里的全角/希腊字符 Ω 删除（"43kΩ" -> "43k"）
 *   - 移除原有 .tran / .ac / .dc 行（分析改由 .control 控制，避免重复执行）
 *   - 丢弃 *BeginTrace / *EndTrace（LCEDA 偶发的超长注释行）
 */
import { readFileSync } from "node:fs";

export type DeckMode = "op" | "tran" | "ac" | "dc" | "custom";

const TEMPLATES: Record<Exclude<DeckMode, "custom">, string> = {
  op: "\n.control\nop\nprint all\n.endc\n",
  tran: "\n.control\ntran {args}\nwrite {raw}tran.raw all\n.endc\n",
  ac: "\n.control\nac {args}\nwrite {raw}ac.raw all\n.endc\n",
  dc: "\n.control\ndc {args}\nwrite {raw}dc.raw all\n.endc\n",
};

export const DECK_DEFAULT_ARGS: Record<string, string> = {
  tran: "5u 25m",
  ac: "dec 100 10 100meg",
};

export class DeckError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "DeckError";
    this.code = code;
  }
}

/** 清洗原始网表：去 Ω、去分析行、去 LCEDA 跟踪注释。 */
export function cleanNetlist(rawText: string): string {
  const lines: string[] = [];
  for (const line of rawText.split("\n")) {
    const text = line.trim();
    if (text.startsWith(".tran") || text.startsWith(".ac ") || text.startsWith(".dc ")) continue;
    if (text.startsWith("*BeginTrace") || text.startsWith("*EndTrace")) continue;
    lines.push(line.replace(/\r$/, "").replace(/Ω/g, ""));
  }
  return lines.join("\n");
}

/** 网表里是否已经有 .control 块（用来决定要不要再注入）。 */
export function hasControlBlock(text: string): boolean {
  return /(^|\n)[ \t]*\.control[ \t]*(\n|$)/i.test(text);
}

/**
 * 返回完整 deck 文本。rawDir 形如 "runs/case_1/"（末尾带斜杠）。
 *
 * `arg`：tran/ac/dc 的分析参数；custom 模式下是控制块正文文件路径。
 */
export function buildDeck(
  rawText: string,
  mode: string,
  arg?: string | null,
  rawDir?: string | null,
): string {
  let deck = cleanNetlist(rawText);
  let prefix = rawDir ? String(rawDir).replace(/\\/g, "/") : "";
  if (prefix && !prefix.endsWith("/")) prefix += "/";

  let ctrl: string;
  if (mode === "custom") {
    if (!arg) {
      throw new DeckError("DECK_CUSTOM_NEEDS_FILE", "custom 模式需要控制块正文文件作为参数");
    }
    let body: string;
    try {
      body = readFileSync(arg, "utf8");
    } catch {
      throw new DeckError("DECK_CUSTOM_NEEDS_FILE", `custom 模式的控制块文件读不到: ${arg}`);
    }
    ctrl = "\n.control\n" + body.trim() + "\n.endc\n";
  } else if (mode === "op" || mode === "tran" || mode === "ac" || mode === "dc") {
    const template = TEMPLATES[mode];
    if (template.includes("{args}")) {
      const args = arg || DECK_DEFAULT_ARGS[mode];
      if (!args) {
        throw new DeckError("DECK_ARGS_REQUIRED", `${mode} 模式需要分析参数（如 V1 0 12 0.1）`);
      }
      ctrl = template.replace("{args}", args).replace("{raw}", prefix);
    } else {
      ctrl = template;
    }
  } else {
    throw new DeckError(
      "DECK_MODE_UNKNOWN",
      `未知模式: ${mode}（支持 op/tran/ac/dc/custom，参数扫描请用配置里的 sweep）`,
    );
  }

  if (!deck.includes(".end")) deck += "\n.end\n";
  // 只在"整行 .end"之前插控制块，避免误命中 .ENDS / .ENDL。
  const anchored = /^[ \t]*\.end[ \t]*$/im.exec(deck);
  const block = ctrl.replace(/^\n+|\n+$/g, "");
  if (anchored && anchored.index !== undefined) {
    deck =
      deck.slice(0, anchored.index) +
      block +
      "\n.end\n" +
      deck.slice(anchored.index + anchored[0].length);
  } else {
    deck = deck + "\n" + block + "\n.end\n";
  }
  return deck;
}
