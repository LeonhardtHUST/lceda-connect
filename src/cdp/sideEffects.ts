/**
 * 副作用表达式拦截。
 *
 * 默认只允许只读求值：命中下面任一模式就拒绝，必须显式放行。规则原样搬自
 * leonskill-easyeda-cdp-connect/scripts/lceda_cdp.py 的 `SIDE_EFFECT_PATTERNS`，
 * 不要按「看起来更精确」改写——这些正则就是对外承诺的判定口径。
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

/** 表达式是否疑似有副作用；空表达式视为只读。 */
export function hasSideEffects(expression: string): boolean {
  if (!expression) return false;
  return COMPILED.some((pattern) => pattern.test(expression));
}

/** 命中的第一条规则，用于在拒绝文案里说明原因。 */
export function firstSideEffectPattern(expression: string): string | null {
  if (!expression) return null;
  for (let index = 0; index < COMPILED.length; index += 1) {
    if (COMPILED[index].test(expression)) return SIDE_EFFECT_PATTERNS[index] ?? null;
  }
  return null;
}
