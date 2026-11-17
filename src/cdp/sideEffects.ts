/**
 * 副作用表达式拦截。
 *
 * 只读判定采用保守白名单：先剥离字符串、模板字面量与注释，再检查赋值、
 * 高风险全局 API，以及 A/eda 的调用形状。任何无法证明只读的表达式都要求确认。
 */

export const SIDE_EFFECT_PATTERNS: readonly string[] = [
  String.raw`\.click\s*\(`,
  String.raw`\.dispatchEvent\s*\(`,
  String.raw`\.value\s*=(?!=)`,
  String.raw`\.submit\s*\(`,
  String.raw`\.remove\s*\(`,
  String.raw`\.appendChild\s*\(`,
  String.raw`innerHTML\s*=`,
  String.raw`document\.write`,
  String.raw`\bfetch\s*\(`,
  String.raw`XMLHttpRequest`,
  String.raw`\brequire\s*\(`,
  String.raw`localStorage\s*\.\s*set`,
  String.raw`sessionStorage\s*\.\s*set`,
  String.raw`\beval\s*\(`,
];

const COMPILED = SIDE_EFFECT_PATTERNS.map((pattern) => new RegExp(pattern));
const ASSIGNMENT_RE =
  /(?:\+\+|--|(?:\+=|-=|\*=|\/=|%=|\*\*=|&=|\|=|\^=|&&=|\|\|=|\?\?=)|(?<![=!<>])=(?!=|>))/;
const ALLOWED_API_CALL_RE =
  /^(?:A|eda)\.[A-Za-z_$][\w$]*\.(?:get|is|has|list|find|query|search)[A-Z_][\w$]*\s*\(/;
const IDENTIFIER_RE = /\b(?:A|eda)\b/g;
const FORBIDDEN_PATTERNS: readonly [string, RegExp][] = [
  ["window", /\bwindow\b/],
  ["globalThis", /\bglobalThis\b/],
  ["self", /\bself\b/],
  ["top", /\btop\b/],
  ["parent", /\bparent\b/],
  ["frames", /\bframes\b/],
  ["Reflect", /\bReflect\b/],
  ["Function", /\bFunction\b/],
  ["eval", /\beval\s*\(/],
  ["import", /\bimport\s*\(/],
  ["require", /\brequire\s*\(/],
  ["fetch", /\bfetch\s*\(/],
  ["XMLHttpRequest", /\bXMLHttpRequest\b/],
  ["WebSocket", /\bWebSocket\b/],
  ["EventSource", /\bEventSource\b/],
  ["navigator.sendBeacon", /\bnavigator\s*\.\s*sendBeacon\s*\(/],
  ["location", /\blocation\b/],
  ["document.cookie", /\bdocument\s*\.\s*cookie\b/],
  ["localStorage", /\blocalStorage\b/],
  ["sessionStorage", /\bsessionStorage\b/],
  ["indexedDB", /\bindexedDB\b/],
  ["postMessage", /\bpostMessage\s*\(/],
  ["dispatchEvent", /\bdispatchEvent\s*\(/],
  [".click(", /\.click\s*\(/],
  ["setTimeout", /\bsetTimeout\s*\(/],
  ["setInterval", /\bsetInterval\s*\(/],
  ["constructor", /\bconstructor\b/],
  ["__proto__", /\b__proto__\b/],
  ["prototype", /\bprototype\b/],
];

export interface EvalClassification {
  readonly: boolean;
  reasons: string[];
  stripped: string;
}

/** 将非代码字面量替换为空格，保留换行与字符位置，避免字符串内容误报。 */
export function stripJavaScriptLiterals(code: string): string {
  let out = "";
  let state: "code" | "lineComment" | "blockComment" | "single" | "double" | "template" = "code";
  let escaped = false;
  for (let index = 0; index < code.length; index += 1) {
    const current = code[index] ?? "";
    const next = code[index + 1] ?? "";
    if (state === "code") {
      if (current === "/" && next === "/") {
        out += "  ";
        index += 1;
        state = "lineComment";
      } else if (current === "/" && next === "*") {
        out += "  ";
        index += 1;
        state = "blockComment";
      } else if (current === "'") {
        out += " ";
        state = "single";
        escaped = false;
      } else if (current === '"') {
        out += " ";
        state = "double";
        escaped = false;
      } else if (current === "`") {
        out += " ";
        state = "template";
        escaped = false;
      } else {
        out += current;
      }
    } else if (state === "lineComment") {
      if (current === "\n" || current === "\r") {
        out += current;
        state = "code";
      } else {
        out += " ";
      }
    } else if (state === "blockComment") {
      if (current === "*" && next === "/") {
        out += "  ";
        index += 1;
        state = "code";
      } else {
        out += current === "\n" || current === "\r" ? current : " ";
      }
    } else {
      if (escaped) {
        out += current === "\n" || current === "\r" ? current : " ";
        escaped = false;
      } else if (current === "\\") {
        out += " ";
        escaped = true;
      } else if (
        (state === "single" && current === "'") ||
        (state === "double" && current === '"') ||
        (state === "template" && current === "`")
      ) {
        out += " ";
        state = "code";
      } else {
        out += current === "\n" || current === "\r" ? current : " ";
      }
    }
  }
  return out;
}

/** 以保守规则判断表达式是否能直接执行；reasons 用于确认预览。 */
export function classifyEval(expression: string): EvalClassification {
  const stripped = stripJavaScriptLiterals(expression);
  const reasons: string[] = [];
  if (!expression.trim()) return { readonly: true, reasons, stripped };

  if (ASSIGNMENT_RE.test(stripped) || /(?:<<|>>|>>>)=/.test(stripped)) reasons.push("assignment");
  if (/`[\s\S]*?\$\{/.test(expression)) reasons.push("template interpolation");
  for (const [name, pattern] of FORBIDDEN_PATTERNS) {
    if (pattern.test(stripped)) reasons.push(name);
  }
  let match: RegExpExecArray | null;
  while ((match = IDENTIFIER_RE.exec(stripped)) !== null) {
    const tail = stripped.slice(match.index);
    if (!ALLOWED_API_CALL_RE.test(tail))
      reasons.push(`${match[0]} access is not a permitted read-only API call`);
  }
  IDENTIFIER_RE.lastIndex = 0;
  for (const pattern of COMPILED) {
    if (pattern.test(stripped) && !reasons.includes(pattern.source)) reasons.push(pattern.source);
  }
  return { readonly: reasons.length === 0, reasons, stripped };
}

/** 表达式是否疑似有副作用；保留旧 API 名称。 */
export function hasSideEffects(expression: string): boolean {
  return !classifyEval(expression).readonly;
}

/** 命中的第一条旧规则，用于兼容旧调用方的错误文案。 */
export function firstSideEffectPattern(expression: string): string | null {
  const stripped = stripJavaScriptLiterals(expression);
  for (let index = 0; index < COMPILED.length; index += 1) {
    if (COMPILED[index]?.test(stripped)) return SIDE_EFFECT_PATTERNS[index] ?? null;
  }
  const classification = classifyEval(expression);
  return classification.reasons[0] ?? null;
}
