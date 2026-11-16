/**
 * 嘉立创EDA/EasyEDA Pro 文件格式知识库与校验器。
 *
 * - registry.ts       类型名 → JSON Schema 解析表（来自 validate.js）
 * - schemaValidator.ts 无依赖的 JSON Schema 子集校验
 * - relaxations.ts    schema 与真实样本矛盾的放宽表
 * - record.ts         整行 `{外层}||{内层}|` 解析与校验
 * - knowledge.ts      types-index / primitives / examples / FORMATLOG 检索
 */

export {
  applyRelaxations,
  relaxationRules,
  type RelaxationRule,
  type RelaxedIssues,
} from "./relaxations.ts";
export {
  clearFormatCaches,
  formatAssetsRoot,
  hasSchema,
  isKnownDocType,
  isRegisteredPair,
  knownDocTypes,
  loadOuterSchema,
  loadRegistry,
  loadSchema,
  resolveSchemaKey,
  schemaRelativePath,
  type FormatRegistry,
  type FormatRegistryCounts,
  type FormatRegistrySource,
  type JsonSchema,
} from "./registry.ts";
export {
  describeValue,
  typeOfValue,
  validateSchema,
  type ValidateSchemaOptions,
  type ValidationIssue,
  type ValidationSeverity,
} from "./schemaValidator.ts";
export {
  parseRecordLine,
  RecordParseError,
  validateFormat,
  validateLine,
  validateOuter,
  type ParsedRecord,
  type RecordValidation,
} from "./record.ts";
export {
  formatAssetsPresent,
  getDocument,
  getExample,
  getFormatLog,
  getPrimitive,
  listTypes,
  schemaAssetPath,
  type FormatExampleResult,
  type FormatPrimitiveResult,
  type FormatTypeQuery,
  type FormatTypeSummary,
} from "./knowledge.ts";
