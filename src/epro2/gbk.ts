/**
 * ZIP 成员名解码。
 *
 * 嘉立创EDA 专业版把成员名按本机代码页（GBK）写进 ZIP，而且不设 UTF-8
 * 标志位。Python 标准库按 cp437 解出字符串，原技能再 encode("cp437") 还原
 * 原始字节后按 GBK 解码。这里直接拿到原始字节，省掉往返，但保留同样的
 * 回退顺序：UTF-8 标志位 → UTF-8，否则 GBK → UTF-8 → 替换解码。
 */

/** CP437 的 0x80–0xFF 字符表。用于把 cp437 字符串还原成原始字节。 */
const CP437_HIGH =
  "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐" +
  "└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■\u00a0";

const CP437_REVERSE = new Map<string, number>();
for (let i = 0; i < CP437_HIGH.length; i += 1) {
  CP437_REVERSE.set(CP437_HIGH[i] ?? "", 0x80 + i);
}

/** Python 侧 decode_member_name 的输入形态：cp437 解码后的字符串。 */
export function cp437TextToBytes(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] ?? "";
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x80) {
      bytes[i] = code;
    } else {
      bytes[i] = CP437_REVERSE.get(ch) ?? 0x3f;
    }
  }
  return bytes;
}

function decodeUtf8(bytes: Uint8Array, fatal: boolean): string {
  return new TextDecoder("utf-8", { fatal }).decode(bytes);
}

/**
 * 解码 ZIP 成员名。
 *
 * @param raw 成员名原始字节，或已经按 cp437 解出的字符串。
 * @param utf8Flag 是否设置了 ZIP 的 UTF-8 名称标志位（bit 11）。
 */
export function decodeMemberName(raw: Uint8Array | string, utf8Flag = false): string {
  const bytes = typeof raw === "string" ? cp437TextToBytes(raw) : raw;
  if (utf8Flag) return decodeUtf8(bytes, false);
  try {
    return new TextDecoder("gbk", { fatal: true }).decode(bytes);
  } catch {
    // 不是合法 GBK：可能是别的客户端写的 UTF-8，按 UTF-8 再试一次。
  }
  try {
    return decodeUtf8(bytes, true);
  } catch {
    return decodeUtf8(bytes, false);
  }
}
