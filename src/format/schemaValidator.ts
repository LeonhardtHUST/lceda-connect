/**
 * 无依赖的 JSON Schema 子集校验器。
 *
 * 只覆盖 assets/format/schemas 实际用到的关键字：
 * type / properties / required / enum / default / minimum / maximum / items / pattern / anyOf
 * （default 是标注，不参与校验；$schema、title、description、enumDescriptions 同样忽略）。
 *
 * 返回的 field 是从载荷根算起的路径：根字段直接是名字，嵌套用 `.`，数组元素用 `[i]`。
 * 与 ajv 的差别只在错误文案与路径写法；判定口径保持一致，已知矛盾交给 relaxations.ts 降级。
 */

export type ValidationSeverity = "ERROR" | "WARNING";

export interface ValidationIssue {
  /** 出问题的字段路径；根级类型错误是 `root`。 */
  field: string;
  message: string;
  severity: ValidationSeverity;
  /** 触发问题的关键字，放宽表据此匹配。 */
  keyword?: string;
  /** 出错位置的实际值（给放宽规则判断用，不写进文案）。 */
  value?: unknown;
}

export interface ValidateSchemaOptions {
  /** 最多收集多少条问题，避免脏数据刷屏；默认 100。 */
  maxErrors?: number;
}

const DEFAULT_MAX_ERRORS = 100;

export function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "string") return "string";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  if (value === undefined) return "undefined";
  return typeof value;
}

export function typeOfValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") {
    return Number.isInteger(value) ? "integer" : "number";
  }
  return typeof value;
}

function matchesType(value: unknown, expected: string): boolean {
  switch (expected) {
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    default:
      // 不认识的 type 名（schema 写错）不拦，ajv strict:false 也是忽略
      return true;
  }
}

function typeMatches(value: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) {
    return expected.some((item) => typeof item === "string" && matchesType(value, item));
  }
  return typeof expected === "string" ? matchesType(value, expected) : true;
}

function enumEqual(left: unknown, right: unknown): boolean {
  if (typeof left === "number" && typeof right === "number") return Object.is(left, right);
  return left === right;
}

function joinPath(path: string, key: string): string {
  return path === "" ? key : `${path}.${key}`;
}

function indexPath(path: string, index: number): string {
  return `${path === "" ? "root" : path}[${index}]`;
}

function fieldName(path: string): string {
  return path === "" ? "root" : path;
}

function checkNumber(
  node: Record<string, unknown>,
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): void {
  if (typeof value !== "number" || !Number.isFinite(value)) return;
  const minimum = node.minimum;
  if (typeof minimum === "number" && value < minimum) {
    issues.push({
      field: fieldName(path),
      message: `值 ${value} 小于最小值 ${minimum}`,
      severity: "ERROR",
      keyword: "minimum",
      value,
    });
  }
  const maximum = node.maximum;
  if (typeof maximum === "number" && value > maximum) {
    issues.push({
      field: fieldName(path),
      message: `值 ${value} 大于最大值 ${maximum}`,
      severity: "ERROR",
      keyword: "maximum",
      value,
    });
  }
}

function checkString(
  node: Record<string, unknown>,
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): void {
  if (typeof value !== "string") return;
  const source = node.pattern;
  if (typeof source !== "string") return;
  let regex: RegExp;
  try {
    regex = new RegExp(source);
  } catch {
    return; // schema 里的正则本身不合法：忽略，不把 schema 的问题算到数据上
  }
  if (!regex.test(value)) {
    issues.push({
      field: fieldName(path),
      message: `字符串 ${JSON.stringify(value)} 不匹配模式 ${source}`,
      severity: "ERROR",
      keyword: "pattern",
      value,
    });
  }
}

function checkAnyOf(
  node: Record<string, unknown>,
  value: unknown,
  path: string,
  issues: ValidationIssue[],
  maxErrors: number,
): void {
  const branches = node.anyOf;
  if (!Array.isArray(branches) || branches.length === 0) return;
  for (const branch of branches) {
    const branchIssues: ValidationIssue[] = [];
    checkNode(branch, value, path, branchIssues, maxErrors);
    if (branchIssues.length === 0) return;
  }
  issues.push({
    field: fieldName(path),
    message: `不满足 anyOf 中任何一组约束（共 ${branches.length} 组）`,
    severity: "ERROR",
    keyword: "anyOf",
    value,
  });
}

function typeListOf(expected: unknown): string {
  if (Array.isArray(expected)) return expected.map((item) => String(item)).join(" | ");
  return typeof expected === "string" ? expected : JSON.stringify(expected);
}

function checkNode(
  schema: unknown,
  value: unknown,
  path: string,
  issues: ValidationIssue[],
  maxErrors: number,
): void {
  if (issues.length >= maxErrors) return;
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) return;
  const node = schema as Record<string, unknown>;

  if (node.type !== undefined && !typeMatches(value, node.type)) {
    issues.push({
      field: fieldName(path),
      message: `期望 ${typeListOf(node.type)}，实际是 ${typeOfValue(value)}`,
      severity: "ERROR",
      keyword: "type",
      value,
    });
    // 类型都不对，后续 required/properties 检查没有意义
    return;
  }

  if (Array.isArray(node.enum)) {
    const allowed = node.enum;
    if (!allowed.some((item) => enumEqual(item, value))) {
      issues.push({
        field: fieldName(path),
        message: `取值 ${JSON.stringify(value ?? null)} 不在允许值里：${allowed
          .map((item) => JSON.stringify(item))
          .join(" / ")}`,
        severity: "ERROR",
        keyword: "enum",
        value,
      });
    }
  }

  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (Array.isArray(node.required)) {
      for (const name of node.required) {
        if (typeof name !== "string" || Object.prototype.hasOwnProperty.call(record, name))
          continue;
        issues.push({
          field: joinPath(path, name),
          message: `缺少必需字段 ${name}`,
          severity: "ERROR",
          keyword: "required",
          value: undefined,
        });
      }
    }
    if (node.properties !== null && typeof node.properties === "object") {
      const properties = node.properties as Record<string, unknown>;
      for (const [key, child] of Object.entries(properties)) {
        if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
        checkNode(child, record[key], joinPath(path, key), issues, maxErrors);
      }
    }
  }

  if (Array.isArray(value) && node.items !== undefined) {
    if (Array.isArray(node.items)) {
      node.items.forEach((child, index) => {
        if (index < value.length)
          checkNode(child, value[index], indexPath(path, index), issues, maxErrors);
      });
    } else {
      value.forEach((item, index) => {
        checkNode(node.items, item, indexPath(path, index), issues, maxErrors);
      });
    }
  }

  checkNumber(node, value, path, issues);
  checkString(node, value, path, issues);
  checkAnyOf(node, value, path, issues, maxErrors);
}

/** 按 schema 校验一段载荷，返回问题列表（空数组表示通过）。 */
export function validateSchema(
  schema: unknown,
  data: unknown,
  options: ValidateSchemaOptions = {},
): ValidationIssue[] {
  const maxErrors = Math.max(1, Math.trunc(options.maxErrors ?? DEFAULT_MAX_ERRORS));
  const issues: ValidationIssue[] = [];
  checkNode(schema, data, "", issues, maxErrors);
  return issues;
}
