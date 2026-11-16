import { applyRelaxations } from "./relaxations.ts";
import {
  hasSchema,
  isKnownDocType,
  knownDocTypes,
  loadSchema,
  resolveSchemaKey,
} from "./registry.ts";
import {
  validateSchema,
  type ValidationIssue,
  type ValidationSeverity,
} from "./schemaValidator.ts";

/**
 * 格式记录（文件源里的一整行）的解析与校验。
 *
 * 行格式：`{外层 JSON}||{内层 JSON}|`
 * - 只按第一个 `||` 切分（外层只有 type/id/ticket，不会出现 `||`）。
 * - 末尾的 `|` 是记录终止符，可以缺；内层为空串表示删除（`{...}|||` 合法）。
 * - 外层 DOCHEAD 行没有 id，ticket 由写入方决定；其余图元要求 type/id/ticket。
 */

export type { ValidationIssue, ValidationSeverity };

export interface ParsedRecord {
  /** 去掉行尾空白与终止符后的整行。 */
  raw: string;
  outer: Record<string, unknown>;
  /** 内层载荷；空体是空字符串。 */
  payload: unknown;
  /** 内层是否为空串（删除语义）。 */
  emptyPayload: boolean;
}

export class RecordParseError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "RecordParseError";
    this.code = code;
  }
}

export interface RecordValidation {
  valid: boolean;
  /** 外层 type；解析不出时是空串。 */
  type: string;
  /** 解析到的 schema key；未知类型时是尝试解析出来的名字。 */
  schema: string;
  /** 显式传入或从 DOCHEAD 载荷读到的文档类型。 */
  docType?: string;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  outer?: unknown;
  payload?: unknown;
}

function issue(
  field: string,
  message: string,
  severity: ValidationSeverity = "ERROR",
  keyword?: string,
  value?: unknown,
): ValidationIssue {
  const result: ValidationIssue = { field, message, severity };
  if (keyword !== undefined) result.keyword = keyword;
  if (value !== undefined) result.value = value;
  return result;
}

/** 解析一整行；格式不对时抛 RecordParseError，调用方负责转成校验错误。 */
export function parseRecordLine(line: string): ParsedRecord {
  const trimmed = line.replace(/\r?\n/g, "").trim();
  if (trimmed === "") throw new RecordParseError("EMPTY_LINE", "整行是空的");
  const separator = trimmed.indexOf("||");
  if (separator < 0) {
    throw new RecordParseError(
      "LINE_FORMAT",
      "缺少外层与载荷的分隔符 ||（整行应为 {外层JSON}||{内层JSON}|）",
    );
  }

  const outerRaw = trimmed.slice(0, separator).trim();
  if (outerRaw === "") throw new RecordParseError("OUTER_EMPTY", "外层数据是空的");
  // 记录终止符属于行，不属于载荷：`...}|||` 的内层是空串，`...}||{...}|` 去掉尾部的 |
  const payloadRaw = trimmed
    .slice(separator + 2)
    .trim()
    .replace(/\|+$/, "")
    .trim();

  let outer: unknown;
  try {
    outer = JSON.parse(outerRaw);
  } catch (error) {
    throw new RecordParseError(
      "OUTER_JSON",
      `外层不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (typeof outer !== "object" || outer === null || Array.isArray(outer)) {
    throw new RecordParseError("OUTER_OBJECT", "外层必须是 JSON 对象");
  }

  if (payloadRaw === "") {
    return {
      raw: trimmed,
      outer: outer as Record<string, unknown>,
      payload: "",
      emptyPayload: true,
    };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(payloadRaw);
  } catch (error) {
    throw new RecordParseError(
      "PAYLOAD_JSON",
      `内层载荷不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return {
    raw: trimmed,
    outer: outer as Record<string, unknown>,
    payload,
    emptyPayload: false,
  };
}

/** 校验外层元数据：type 必填；非 DOCHEAD 行还要求 id 与 ticket。 */
export function validateOuter(outer: unknown): ValidationIssue[] {
  if (typeof outer !== "object" || outer === null || Array.isArray(outer)) {
    return [issue("root", "外层必须是对象", "ERROR", "type")];
  }
  const record = outer as Record<string, unknown>;
  const errors: ValidationIssue[] = [];

  if (!Object.prototype.hasOwnProperty.call(record, "type")) {
    errors.push(issue("type", "缺少必需字段 type", "ERROR", "required"));
  } else if (typeof record.type !== "string" || record.type.trim() === "") {
    errors.push(issue("type", "type 必须是非空字符串", "ERROR", "type", record.type));
  }

  if (Object.prototype.hasOwnProperty.call(record, "id") && typeof record.id !== "string") {
    errors.push(
      issue("id", `id 必须是字符串，实际是 ${typeof record.id}`, "ERROR", "type", record.id),
    );
  }

  if (Object.prototype.hasOwnProperty.call(record, "ticket")) {
    const ticket = record.ticket;
    if (typeof ticket !== "number" || !Number.isInteger(ticket)) {
      errors.push(issue("ticket", "ticket 必须是整数", "ERROR", "type", ticket));
    } else if (ticket < 0) {
      errors.push(issue("ticket", `ticket 不能小于 0，收到 ${ticket}`, "ERROR", "minimum", ticket));
    }
  }

  // DOCHEAD 与 DELETE_DOC 是控制行，没有 id；ticket 由写入方决定
  if (record.type !== "DOCHEAD" && record.type !== "DELETE_DOC") {
    if (!Object.prototype.hasOwnProperty.call(record, "id")) {
      errors.push(
        issue("id", "缺少必需字段 id（DOCHEAD / DELETE_DOC 行才允许没有 id）", "ERROR", "required"),
      );
    }
    if (!Object.prototype.hasOwnProperty.call(record, "ticket")) {
      errors.push(issue("ticket", "缺少必需字段 ticket", "ERROR", "required"));
    }
  }

  return errors;
}

function unknownDocType(docType: string): ValidationIssue {
  return issue(
    "docType",
    `未知的文档类型 ${docType}；已知：${knownDocTypes().join(", ")}`,
    "ERROR",
    "docType",
    docType,
  );
}

/**
 * 校验一段内层载荷。
 *
 * schema 与真实样本的矛盾（见 relaxations.ts）会降级成 warnings，不影响 valid。
 */
export function validateFormat(type: string, data: unknown, docType?: string): RecordValidation {
  const result: RecordValidation = {
    valid: false,
    type: typeof type === "string" ? type : "",
    schema: "",
    errors: [],
    warnings: [],
  };
  if (docType !== undefined) result.docType = docType;

  if (typeof type !== "string" || type.trim() === "") {
    result.errors.push(issue("type", "图元类型必须是非空字符串", "ERROR", "type"));
    return result;
  }

  if (docType !== undefined && !isKnownDocType(docType)) {
    result.errors.push(unknownDocType(docType));
  }

  const schemaKey = resolveSchemaKey(type, docType);
  result.schema = schemaKey;
  const schema = loadSchema(schemaKey);
  if (!schema) {
    result.errors.push(
      issue(
        "type",
        `未知类型 ${type}（解析为 schema ${schemaKey}）；用 <文档类型>_<图元名> 前缀名或 --doc 指定文档类型`,
        "ERROR",
        "unknown-type",
        type,
      ),
    );
    return result;
  }

  const issues = validateSchema(schema, data);
  const relaxed = applyRelaxations(schemaKey, type, issues);
  result.errors.push(...relaxed.errors);
  result.warnings.push(...relaxed.warnings);
  result.valid = result.errors.length === 0;
  return result;
}

interface DeleteDocCheck {
  schema: string;
  errors: ValidationIssue[];
}

/** DELETE_DOC 没有对应 schema（在 e-atom-type 枚举里），载荷规则单独校。 */
function validateDeleteDoc(payload: unknown, emptyPayload: boolean): DeleteDocCheck {
  const errors: ValidationIssue[] = [];
  if (emptyPayload) {
    errors.push(
      issue(
        "payload",
        'DELETE_DOC 的载荷不能是空串（会被判成「未删除」而复活文档），要写 {"isDelete":true} 或 {"isDelete":false}',
        "ERROR",
        "delete-doc-payload",
      ),
    );
  } else if (
    typeof payload !== "object" ||
    payload === null ||
    Array.isArray(payload) ||
    typeof (payload as Record<string, unknown>).isDelete !== "boolean"
  ) {
    errors.push(
      issue(
        "payload",
        'DELETE_DOC 的载荷必须是 {"isDelete":true} 或 {"isDelete":false}',
        "ERROR",
        "delete-doc-payload",
        payload,
      ),
    );
  }
  return { schema: "delete_doc", errors };
}

/** 校验一整行：外层 + 内层，docType 可显式传入（--doc 的写法）。 */
export function validateLine(line: string, docType?: string): RecordValidation {
  const result: RecordValidation = { valid: false, type: "", schema: "", errors: [], warnings: [] };
  let parsed: ParsedRecord;
  try {
    parsed = parseRecordLine(line);
  } catch (error) {
    if (error instanceof RecordParseError) {
      result.errors.push(issue("line", error.message, "ERROR", error.code));
      return result;
    }
    throw error;
  }

  result.outer = parsed.outer;
  result.payload = parsed.payload;
  const outerType = typeof parsed.outer.type === "string" ? parsed.outer.type : "";
  result.type = outerType;
  const payload = parsed.payload as unknown;
  const payloadDocType =
    outerType === "DOCHEAD" &&
    typeof payload === "object" &&
    payload !== null &&
    !Array.isArray(payload) &&
    typeof (payload as Record<string, unknown>).docType === "string"
      ? String((payload as Record<string, unknown>).docType)
      : undefined;
  const effectiveDocType = docType ?? payloadDocType;
  if (effectiveDocType !== undefined) result.docType = effectiveDocType;

  result.errors.push(...validateOuter(parsed.outer));
  if (outerType === "") {
    // validateOuter 已经报了 type 的问题；没有类型就无从选 schema
    return result;
  }

  if (outerType === "DELETE_DOC") {
    const checked = validateDeleteDoc(payload, parsed.emptyPayload);
    result.schema = checked.schema;
    result.errors.push(...checked.errors);
    result.valid = result.errors.length === 0;
    return result;
  }

  if (parsed.emptyPayload) {
    if (outerType === "META") {
      result.errors.push(
        issue(
          "payload",
          'META 的载荷绝不能是空串（消费方直接取 dataObj.title，空串会解析成 null 并中止重放）；删 META 用 {"type":"DELETE_DOC",...}||{"isDelete":true}',
          "ERROR",
          "delete-meta",
        ),
      );
    }
    if (effectiveDocType !== undefined && !isKnownDocType(effectiveDocType)) {
      result.errors.push(unknownDocType(effectiveDocType));
    }
    // 其余类型空串表示「删除这条原子数据」，是合法行，不再按字段校验
    if (result.errors.length === 0) {
      result.warnings.push(
        issue(
          "payload",
          "载荷为空串：按最终一致性的删除语义处理，跳过字段校验",
          "WARNING",
          "empty-payload",
        ),
      );
    }
    const schemaKey = resolveSchemaKey(outerType, effectiveDocType);
    result.schema = hasSchema(schemaKey) ? schemaKey : "";
    result.valid = result.errors.length === 0;
    return result;
  }

  const payloadResult = validateFormat(outerType, payload, effectiveDocType);
  result.schema = payloadResult.schema;
  result.errors.push(...payloadResult.errors);
  result.warnings.push(...payloadResult.warnings);
  result.valid = result.errors.length === 0;
  return result;
}
