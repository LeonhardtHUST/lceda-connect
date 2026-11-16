/**
 * `.eprj3` 记录流与文档模型。
 *
 * 记录语法：`{"type":"T","ticket":N,"id":"..."}||{body}|`，空体是墓碑
 * （`...}|||`），末行可以没有结尾的 `|`。只按**第一个** `||` 切分：载荷 JSON
 * 的字符串里可能自己带 `||`，按全部 `||` 切再拼回虽然也能用，但边界更容易
 * 漏算。DOCHEAD 没有 `id`；V4 保存的外层帧带 `ticket`，V3 与 FONT 文档不带，
 * 两种形态可以同时出现在一个文件里，所以判 DOCHEAD 必须解析外层 JSON 后看
 * `type`，不能拿字符串前缀去猜。
 *
 * 容器文件（`.esch2` / `.epcb2` / `.epan2` / `.ecfg`）由若干 DOCHEAD 分段：
 * 库文档（SYMBOL / FOOTPRINT / DEVICE）在前，主文档（SCH_PAGE / PCB / PANEL）
 * 在最后。元素 `id` 只在文档内唯一，跨文档会重复（每个 SYMBOL 都有 e1、e2…），
 * 所以归约键必须是「文档 uuid + 归一化 id」。
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

/** 一行解析后的记录。`body` 只接受 JSON 对象；空体记成墓碑。 */
export interface Eprj3Record {
  /** 外层头对象。 */
  head: Record<string, unknown>;
  /** 内层载荷；空体与坏 JSON 都是 `{}`。 */
  body: Record<string, unknown>;
  /** 外层 `type`。 */
  type: string;
  /** 外层 `ticket`，没有时为 null。 */
  ticket: number | null;
  /** 外层 `id`（DOCHEAD 没有），统一成字符串。 */
  id: string | null;
  /** 原始行（去行尾空白）。 */
  raw: string;
  /** 内层载荷原文（已去掉结尾的 `|`）。 */
  bodyRaw: string;
  /** 空体：删除语义的墓碑。 */
  tombstone: boolean;
  /** 非空体但不是合法 JSON 对象（校验要单独报）。 */
  bodyInvalid: boolean;
}

/** 一个 DOCHEAD 分段。`records` 不含 DOCHEAD 自己。 */
export interface DocSection {
  head: Eprj3Record;
  docType: string | null;
  uuid: string | null;
  client: string | null;
  records: Eprj3Record[];
  /** 段内无法解析的记录行数。 */
  unparsed: number;
}

export interface DocumentSplit {
  sections: DocSection[];
  /** 第一个 DOCHEAD 之前的非空行数（正常文件应为 0）。 */
  orphans: number;
  /** 无法解析的记录行数（不含孤儿行）。 */
  unparsed: number;
}

export interface ReduceInput {
  /** 文档 uuid；参与判优键。 */
  uuid?: string | null;
  /** DOCHEAD 的 client；ticket 平票时字典序大者胜。 */
  client?: string | null;
  records: readonly Eprj3Record[];
}

export interface ReducedRecordSet {
  uuid: string | null;
  /** 存活记录（已剔除墓碑），按首次出现顺序。 */
  records: Eprj3Record[];
  /** 胜出的墓碑（除 META 外）：这些 id 被删除。 */
  tombstones: Eprj3Record[];
  /** 被更大 ticket（或更大 client）覆盖的历史行数。 */
  dropped: number;
  /** 胜出的 META 是空体：非法（删除 META 要用 DELETE_DOC）。 */
  metaEmpty: boolean;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** 去掉 U+FEFF（Windows 编辑器写入的 BOM 会让 JSON.parse 直接失败）。 */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** 读文本并去掉 BOM。 */
export function readTextBomSafe(filePath: string): string {
  return stripBom(readFileSync(filePath, "utf8"));
}

/** 读工程文件的有效行：去 BOM、按行切、丢掉空行。 */
export function readLines(filePath: string): string[] {
  return readTextBomSafe(filePath)
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "");
}

/**
 * 解析一行记录。外层不是 JSON 对象、缺 type、或者一行里没有 `||` 时返回 null。
 *
 * 内层载荷为空串就是墓碑；坏 JSON 保留记录本身（`bodyInvalid`），交给格式门
 * 去报。静默丢掉一条铜箔记录比报错更危险。
 */
export function parseRecord(line: string): Eprj3Record | null {
  const raw = line.replace(/\r?\n/g, "").trim();
  const separator = raw.indexOf("||");
  if (separator < 0) return null;

  let head: unknown;
  try {
    head = JSON.parse(raw.slice(0, separator));
  } catch {
    return null;
  }
  if (!isPlainObject(head) || typeof head.type !== "string" || head.type === "") return null;

  const bodyRaw = raw.slice(separator + 2).replace(/\|+\s*$/, "");
  const tombstone = bodyRaw.trim() === "";
  let body: Record<string, unknown> = {};
  let bodyInvalid = false;
  if (!tombstone) {
    try {
      const parsed: unknown = JSON.parse(bodyRaw);
      if (isPlainObject(parsed)) body = parsed;
      else bodyInvalid = true;
    } catch {
      bodyInvalid = true;
    }
  }

  const ticket = typeof head.ticket === "number" ? head.ticket : null;
  let id: string | null = null;
  if (typeof head.id === "string") id = head.id;
  else if (head.id !== undefined && head.id !== null) id = JSON.stringify(head.id);

  return { head, body, type: head.type, ticket, id, raw, bodyRaw, tombstone, bodyInvalid };
}

/** 读一个容器文件里的全部记录（不分文档段）。 */
export function readRecords(filePath: string): Eprj3Record[] {
  return readLines(filePath)
    .map(parseRecord)
    .filter((record): record is Eprj3Record => record !== null);
}

/** 格式化一行记录；空体输出 `...|||`。 */
export function formatRecord(head: Record<string, unknown>, body: unknown): string {
  const empty =
    body === undefined || body === null || (isPlainObject(body) && Object.keys(body).length === 0);
  return `${JSON.stringify(head)}||${empty ? "" : JSON.stringify(body)}|`;
}

/** 这一行是不是文档边界（解析外层后判 type，不靠字符串前缀）。 */
export function isDocHeadLine(line: string): boolean {
  const trimmed = line.trim();
  const separator = trimmed.indexOf("||");
  if (separator < 0 || trimmed.charCodeAt(0) !== 0x7b) return false;
  try {
    const head: unknown = JSON.parse(trimmed.slice(0, separator));
    return isPlainObject(head) && head.type === "DOCHEAD";
  } catch {
    return false;
  }
}

function headText(body: Record<string, unknown>, key: string): string | null {
  const value = body[key];
  return typeof value === "string" ? value : null;
}

/** 按 DOCHEAD 把行拆成文档段，并统计孤儿行与坏记录行。 */
export function splitDocumentLines(lines: readonly string[]): DocumentSplit {
  const sections: DocSection[] = [];
  let current: DocSection | null = null;
  let orphans = 0;
  let unparsed = 0;

  for (const line of lines) {
    if (isDocHeadLine(line)) {
      const head = parseRecord(line);
      if (head === null) {
        unparsed += 1;
        continue;
      }
      current = {
        head,
        docType: headText(head.body, "docType"),
        uuid: headText(head.body, "uuid"),
        client: headText(head.body, "client"),
        records: [],
        unparsed: 0,
      };
      sections.push(current);
      continue;
    }
    const record = parseRecord(line);
    if (current === null) {
      orphans += 1;
      continue;
    }
    if (record === null) {
      current.unparsed += 1;
      unparsed += 1;
    } else {
      current.records.push(record);
    }
  }

  return { sections, orphans, unparsed };
}

/** 读一个容器文件并按 DOCHEAD 分段。 */
export function readDocumentFile(filePath: string): DocumentSplit {
  return splitDocumentLines(readLines(filePath));
}

/**
 * 归一化记录 id：`id` 本身常是一段 JSON（`["NET",""]`、`["PAD_NET",...]`），
 * 不同写入方的空白与键序可能不同。能解析成对象/数组时按紧凑 JSON 归一，
 * 其余保持原字符串。
 */
export function normalizeRecordId(id: string | null | undefined): string {
  if (id === null || id === undefined) return "";
  const text = id.trim();
  if (text === "") return "";
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed !== null && typeof parsed === "object") return JSON.stringify(parsed);
  } catch {
    // 普通字符串 id（e1、随机 16-hex）按原样使用。
  }
  return text;
}

/** 归约键：文档 uuid + 归一化 id；没有 id 的坏行退化成整行，避免互相覆盖。 */
export function reduceKey(record: Eprj3Record): string {
  const id = normalizeRecordId(record.id);
  return id === "" ? `#${record.type}\u0000${record.raw}` : id;
}

/**
 * 这条记录是否真的按删除处理。
 *
 * PCB 的空 NET（id `["NET",""]`）是结构占位：builder 与客户端都会把它写成空体
 * （`|||`），它不属于删除语义，归约时要保留，否则合法工程会报“缺空 NET”。
 * META 的空体由调用方单独处理（不删除，但要报错）。
 */
function isDeleted(record: Eprj3Record): boolean {
  if (!record.tombstone) return false;
  return !(record.type === "NET" && normalizeRecordId(record.id) === '["NET",""]');
}

interface WinnerEntry {
  winner: Eprj3Record;
  winnerClient: string;
  lastLive: Eprj3Record | null;
}

/**
 * 按「文档 + 归一化 id」归约：ticket 大者胜；ticket 相同比 DOCHEAD client，
 * 字典序大者胜；client 也相同则后写的那行胜。空体是墓碑，删除该原子；META
 * 例外：空体 META 不删除，记 `metaEmpty`，由格式门报错。
 *
 * 同一文档 uuid 在多个输入段里出现时（例如容器里复制了一份文档），它们的
 * 记录一起参与判优，这正是 client 平票规则有意义的场景。
 */
export function reduceRecords(inputs: readonly ReduceInput[]): ReducedRecordSet[] {
  interface Group {
    uuid: string | null;
    entries: Map<string, WinnerEntry>;
    rows: number;
  }
  const groups = new Map<string, Group>();

  inputs.forEach((input, index) => {
    const groupKey = input.uuid ? `uuid:${input.uuid}` : `index:${index}`;
    let group = groups.get(groupKey);
    if (group === undefined) {
      group = { uuid: input.uuid ?? null, entries: new Map<string, WinnerEntry>(), rows: 0 };
      groups.set(groupKey, group);
    }
    const client = input.client ?? "";
    for (const record of input.records) {
      group.rows += 1;
      const key = reduceKey(record);
      const previous = group.entries.get(key);
      const ticket = record.ticket ?? -1;
      const previousTicket = previous?.winner.ticket ?? -1;
      const better =
        previous === undefined ||
        ticket > previousTicket ||
        (ticket === previousTicket && client >= previous.winnerClient);
      if (!better) continue;
      group.entries.set(key, {
        winner: record,
        winnerClient: client,
        lastLive: isDeleted(record) ? (previous?.lastLive ?? null) : record,
      });
    }
  });

  const result: ReducedRecordSet[] = [];
  for (const group of groups.values()) {
    const records: Eprj3Record[] = [];
    const tombstones: Eprj3Record[] = [];
    let metaEmpty = false;
    for (const entry of group.entries.values()) {
      if (!isDeleted(entry.winner)) {
        records.push(entry.winner);
        continue;
      }
      if (entry.winner.type === "META") {
        metaEmpty = true;
        if (entry.lastLive !== null) records.push(entry.lastLive);
        continue;
      }
      tombstones.push(entry.winner);
    }
    result.push({
      uuid: group.uuid,
      records,
      tombstones,
      dropped: group.rows - group.entries.size,
      metaEmpty,
    });
  }
  return result;
}

/** 单段文档的归约。 */
export function reduceDocSection(section: DocSection): ReducedRecordSet {
  const [reduced] = reduceRecords([
    { uuid: section.uuid, client: section.client, records: section.records },
  ]);
  return (
    reduced ?? { uuid: section.uuid, records: [], tombstones: [], dropped: 0, metaEmpty: false }
  );
}

/** 文档里的 META 载荷（后写覆盖先写；空体 META 不会进 `records`）。 */
export function metaOf(records: readonly Eprj3Record[]): Record<string, unknown> {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (record !== undefined && record.type === "META") return record.body;
  }
  return {};
}

/** 文档类型编号（META.docType，SYMBOL=2 / 电源符号=18 / 端口符号=19）。 */
export function docTypeNumber(records: readonly Eprj3Record[]): number | undefined {
  const value = metaOf(records).docType;
  return typeof value === "number" ? value : undefined;
}

/** 客户端 id：owner uuid 的 md5 前 16 位（源仓库的实现，客户端按同一规则推导）。 */
export function clientIdFrom(ownerUuid: string): string {
  return createHash("md5").update(ownerUuid).digest("hex").slice(0, 16);
}
