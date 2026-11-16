/**
 * 脱敏：把 URL / 标题里的账号标识替换成 `<REDACTED>`。
 *
 * 客户端会在页面 URL 里带上账号、token 等字段，target 标题里带工程名。所有对外
 * 输出（CLI 打印、MCP 返回值、错误文案）都先过这里，保证同一套规则不会各处漂移。
 * 来源：leonskill-easyeda-cdp-connect/scripts/lceda_cdp.py 的 `redact()`。
 */

/** 一旦出现就整段抹掉的查询参数名（小写比较）。 */
export const SENSITIVE_PARAMS: readonly string[] = [
  "username",
  "email",
  "phone",
  "customer_code",
  "license",
  "token",
  "access_token",
  "session",
  "ticket",
];

const PARAM_RE = new RegExp(`\\b(${SENSITIVE_PARAMS.join("|")})=[^&"'\\s>]*`, "g");
const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
/** 中国大陆手机号：前后不能紧邻数字，避免把长串里的 11 位误伤。 */
const PHONE_RE = /(?<!\d)1[3-9]\d{9}(?!\d)/g;

/**
 * 三类一起抹：已知 URL 参数、邮箱、手机号。
 * 空串原样返回；非字符串输入按字符串处理（脱敏不该因为类型意外而抛错）。
 */
export function redact(text: string): string {
  if (!text) return text;
  let out = text.replace(PARAM_RE, (_match, name: string) => `${name}=<REDACTED>`);
  out = out.replace(EMAIL_RE, "<REDACTED>");
  out = out.replace(PHONE_RE, "<REDACTED>");
  return out;
}

/** 递归脱敏 JSON 值里的每个字符串，供 MCP 返回 target 列表时统一处理。 */
export function redactDeep<T>(value: T): T {
  if (typeof value === "string") return redact(value) as T;
  if (Array.isArray(value)) return value.map((item) => redactDeep(item)) as T;
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = redactDeep(item);
    return out as T;
  }
  return value;
}
