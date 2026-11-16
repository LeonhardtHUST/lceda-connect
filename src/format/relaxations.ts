import type { ValidationIssue } from "./schemaValidator.ts";

/**
 * Schema 与真实样本的已知矛盾（放宽表）。
 *
 * assets/format/schemas 里的 JSON Schema 是按设计稿整理的，跟编辑器 3.0 实际写盘
 * 的形态有几处对不上。上游 validate.js 用 ajv 直接校，这些地方会误报。
 * 这里把这些矛盾登记成规则：命中规则的问题降级为 WARNING，不挡 `valid`。
 *
 * 新发现一处矛盾时在这里补一条，并写清依据（文档/样本/版本）。
 */

export interface RelaxationRule {
  /** 目标 schema key；`*` 表示所有 schema。 */
  schema: string;
  /** 只对某个外层 type 生效（大小写不敏感）；省略表示不限。 */
  type?: string;
  /** 出问题的字段路径（与 ValidationIssue.field 一致，如 `zIndex`、`defaultPad.padType`）。 */
  field: string;
  /** 触发问题的关键字。 */
  keyword: "required" | "type";
  /** keyword 为 type 时，实际值还要过这个判定才放宽；否则仍按错误处理。 */
  check?: (value: unknown) => boolean;
  /** 降级说明，会附在 WARNING 里。 */
  note: string;
}

export const relaxationRules: readonly RelaxationRule[] = [
  {
    schema: "t-pcb-via",
    type: "VIA",
    field: "zIndex",
    keyword: "required",
    note: "VIA 3.0 写盘不出 zIndex（写盘 switch 无该分支），schema 的 required 与真机不符；读取侧仍可能遇到 2.0 遗留的 zIndex",
  },
  {
    schema: "*",
    field: "groupId",
    keyword: "type",
    check: (value) => value === 0,
    note: '未分组时写数字 0（不是字符串 "0"）；schema 把 groupId 定成 string，真实数据与文档都以数字 0 为准',
  },
];

export interface RelaxedIssues {
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

function matches(
  rule: RelaxationRule,
  schemaKey: string,
  type: string,
  issue: ValidationIssue,
): boolean {
  if (rule.schema !== "*" && rule.schema !== schemaKey) return false;
  if (rule.type !== undefined && rule.type.toLowerCase() !== type.toLowerCase()) return false;
  if (rule.field !== issue.field) return false;
  if (rule.keyword !== issue.keyword) return false;
  if (rule.check && !rule.check(issue.value)) return false;
  return true;
}

/**
 * 把放宽表命中的问题从 errors 挪到 warnings。
 *
 * schemaKey 用 resolveSchemaKey 的结果，type 用外层 type（如 VIA、PAD），
 * 两者一起定位规则，避免把别的文档域的字段冲突也放宽掉。
 */
export function applyRelaxations(
  schemaKey: string,
  type: string,
  issues: readonly ValidationIssue[],
): RelaxedIssues {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  for (const issue of issues) {
    const rule = relaxationRules.find((item) => matches(item, schemaKey, type, issue));
    if (!rule) {
      errors.push(issue);
      continue;
    }
    warnings.push({
      ...issue,
      severity: "WARNING",
      message: `${issue.message}（已放宽：${rule.note}）`,
    });
  }
  return { errors, warnings };
}
