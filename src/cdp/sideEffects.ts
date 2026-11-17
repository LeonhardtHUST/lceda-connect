/**
 * 副作用表达式拦截。
 *
 * 只读判定采用严格白名单：只有纯 JSON 值、四个固定的 document 只读属性，
 * 或单条 A/eda 查询调用（参数必须是 JSON 字面量）可以直接执行。
 * 其余写法一律要求确认；旧模式列表只用于生成原因提示，不参与放行。
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
const DOCUMENT_READ_RE = /^document\.(?:title|URL|documentURI|readyState)$/;
/** 单条 A.<ns>.<query>(<args>)；参数里的括号交给 JSON 校验兜底。 */
const API_CALL_RE = /^(?:A|eda)\.([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\s*\(([\s\S]*)\)$/;
const ALLOWED_QUERY_RE = /^(?:get|is|has|list|find|query|search)[A-Z_][\w$]*$/;
const FORBIDDEN_NAMESPACES: ReadonlySet<string> = new Set([
  "constructor",
  "__proto__",
  "prototype",
  "caller",
  "callee",
]);
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

interface ScannedSource {
  /** 注释替换为空格、字符串逐字保留后的源码。 */
  code: string;
  error: string | null;
  backslashOutsideString: boolean;
  regexOrDivisionOutsideString: boolean;
  semicolonOutsideString: boolean;
}

/**
 * 只剥离注释，字符串保持原样。
 *
 * 只读判定不能把字符串内容当成代码（会误报），也不能把字符串吞掉后让
 * 非法结构看起来合法（例如 `A.x.getY("/*") ; sideEffect()`）。
 */
function scanSource(source: string): ScannedSource {
  let code = "";
  let state: "code" | "lineComment" | "blockComment" | "single" | "double" = "code";
  let backslashOutsideString = false;
  let regexOrDivisionOutsideString = false;
  let semicolonOutsideString = false;
  for (let index = 0; index < source.length; index += 1) {
    const current = source[index] ?? "";
    const next = source[index + 1] ?? "";
    if (state === "code") {
      if (current === "/" && next === "/") {
        code += "  ";
        index += 1;
        state = "lineComment";
      } else if (current === "/" && next === "*") {
        code += "  ";
        index += 1;
        state = "blockComment";
      } else if (current === "'") {
        code += current;
        state = "single";
      } else if (current === '"') {
        code += current;
        state = "double";
      } else if (current === "\\") {
        backslashOutsideString = true;
        code += current;
      } else if (current === "/") {
        regexOrDivisionOutsideString = true;
        code += current;
      } else {
        if (current === ";") semicolonOutsideString = true;
        code += current;
      }
    } else if (state === "lineComment") {
      if (current === "\n" || current === "\r" || current === "\u2028" || current === "\u2029") {
        code += current;
        state = "code";
      } else {
        code += " ";
      }
    } else if (state === "blockComment") {
      if (current === "*" && next === "/") {
        code += "  ";
        index += 1;
        state = "code";
      } else {
        code +=
          current === "\n" || current === "\r" || current === "\u2028" || current === "\u2029"
            ? current
            : " ";
      }
    } else {
      // 字符串状态：逐字保留，避免注释标记或括号被吞掉。
      if (current === "\\") {
        const escaped = source[index + 1];
        if (escaped === undefined) {
          return {
            code,
            error: "unterminated string literal",
            backslashOutsideString,
            regexOrDivisionOutsideString,
            semicolonOutsideString,
          };
        }
        code += current + escaped;
        index += 1;
      } else if (
        (state === "single" && current === "'") ||
        (state === "double" && current === '"')
      ) {
        code += current;
        state = "code";
      } else {
        code += current;
      }
    }
  }
  let error: string | null = null;
  if (state === "blockComment") error = "unterminated block comment";
  else if (state === "single" || state === "double") error = "unterminated string literal";
  return {
    code,
    error,
    backslashOutsideString,
    regexOrDivisionOutsideString,
    semicolonOutsideString,
  };
}

function isJsonValue(source: string): boolean {
  try {
    JSON.parse(source);
    return true;
  } catch {
    return false;
  }
}

/** 参数只接受 JSON 字面量：`[` + args + `]` 必须能被 JSON.parse 解析。 */
function isJsonArguments(args: string): boolean {
  try {
    return Array.isArray(JSON.parse(`[${args}]`) as unknown);
  } catch {
    return false;
  }
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
      if (current === "\n" || current === "\r" || current === "\u2028" || current === "\u2029") {
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
        out +=
          current === "\n" || current === "\r" || current === "\u2028" || current === "\u2029"
            ? current
            : " ";
      }
    } else {
      if (escaped) {
        out +=
          current === "\n" || current === "\r" || current === "\u2028" || current === "\u2029"
            ? current
            : " ";
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
        out +=
          current === "\n" || current === "\r" || current === "\u2028" || current === "\u2029"
            ? current
            : " ";
      }
    }
  }
  return out;
}

/** 以严格白名单判断表达式是否能直接执行；reasons 用于确认预览。 */
export function classifyEval(expression: string): EvalClassification {
  const stripped = stripJavaScriptLiterals(expression);
  const reasons: string[] = [];
  const trimmed = expression.trim();
  if (!trimmed) return { readonly: true, reasons, stripped };

  // 模板/标签模板一律拒绝：不做插值分析，避免把标签调用当成普通字符串。
  if (trimmed.includes("`")) {
    reasons.push("template literals and tagged templates are not allowed");
    return { readonly: false, reasons, stripped };
  }

  const scanned = scanSource(trimmed);
  if (scanned.error) {
    reasons.push(scanned.error);
    return { readonly: false, reasons, stripped };
  }
  if (scanned.backslashOutsideString) {
    reasons.push("backslash outside a string literal (Unicode escapes) is not allowed");
    return { readonly: false, reasons, stripped };
  }
  if (scanned.regexOrDivisionOutsideString) {
    reasons.push("regular expression literals and division are not allowed");
    return { readonly: false, reasons, stripped };
  }

  let core = scanned.code.trim();
  if (core.endsWith(";")) core = core.slice(0, -1).trimEnd();
  const prefix = /^(?:return\s+await|await)\s+/.exec(core);
  if (prefix) core = core.slice(prefix[0].length).trimStart();
  if (core.endsWith(";")) {
    reasons.push("multiple statements are not allowed (only one trailing semicolon)");
    return { readonly: false, reasons, stripped };
  }
  if (!core) return { readonly: true, reasons, stripped };

  if (DOCUMENT_READ_RE.test(core) || isJsonValue(core)) {
    return { readonly: true, reasons, stripped };
  }

  const call = API_CALL_RE.exec(core);
  if (call) {
    const namespace = call[1] ?? "";
    const method = call[2] ?? "";
    const args = call[3] ?? "";
    if (FORBIDDEN_NAMESPACES.has(namespace)) {
      reasons.push(`namespace "${namespace}" is not allowed`);
    } else if (!ALLOWED_QUERY_RE.test(method)) {
      reasons.push(
        `method "${method}" is not a permitted read-only query (get/is/has/list/find/query/search + [A-Z_] suffix)`,
      );
    } else if (!isJsonArguments(args)) {
      reasons.push(
        "arguments must be JSON literals (no variables, functions, or object shorthand)",
      );
    } else {
      return { readonly: true, reasons: [], stripped };
    }
    return { readonly: false, reasons, stripped };
  }

  if (/\bwith\s*\(/.test(core)) reasons.push("with statements are not allowed");
  if (/\bnew\b/.test(core)) reasons.push("constructor calls (new) are not allowed");
  if (/\bObject\s*\./.test(core)) reasons.push("Object API calls are not allowed");
  if (/=>/.test(stripped)) reasons.push("arrow functions are not allowed");
  if (/\.then\s*\(/.test(core)) reasons.push("promise chains and callbacks are not allowed");
  if (/^(?:A|eda)\b/.test(core)) {
    reasons.push("A/eda may only be used as a single A.<namespace>.<query>(<JSON args>) call");
  }
  if (ASSIGNMENT_RE.test(stripped) && !reasons.includes("assignment")) reasons.push("assignment");
  for (const [name, pattern] of FORBIDDEN_PATTERNS) {
    if (pattern.test(stripped) && !reasons.includes(name)) reasons.push(name);
  }
  if (
    scanned.semicolonOutsideString &&
    !reasons.some((reason) => reason.includes("multiple statements"))
  ) {
    reasons.push("multiple statements are not allowed");
  }
  if (reasons.length === 0) reasons.push("expression is not a whitelisted read-only form");
  return { readonly: false, reasons, stripped };
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
