/** 把 JSON 记录里的未知值转成字符串，避免对象被拼成 `[object Object]`。 */
export function scalarText(value: unknown, nullText = ""): string {
  if (value === null || value === undefined) return nullText;
  switch (typeof value) {
    case "string":
      return value;
    case "number":
    case "boolean":
    case "bigint":
      return String(value);
    case "symbol":
      return value.description ?? "";
    default:
      break;
  }
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}
