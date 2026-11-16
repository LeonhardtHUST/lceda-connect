/** 极简 ANSI 着色：非 TTY / NO_COLOR / --json 场景自动降级为纯文本。 */
const COLOR_ENABLED: boolean = (() => {
  const env = process.env;
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== "0") return true;
  return Boolean(process.stdout.isTTY);
})();

type Painter = (text: string) => string;

function painter(open: number, close: number): Painter {
  return (text: string): string =>
    COLOR_ENABLED ? `\u001B[${open}m${text}\u001B[${close}m` : text;
}

export const paint = {
  cyan: painter(36, 39),
  green: painter(32, 39),
  yellow: painter(33, 39),
  red: painter(31, 39),
  gray: painter(90, 39),
  white: painter(97, 39),
  darkRed: painter(31, 39),
  bold: painter(1, 22),
  dim: painter(2, 22),
} satisfies Record<string, Painter>;

export function isColorEnabled(): boolean {
  return COLOR_ENABLED;
}

/** 中文对齐时 `-` 分隔线（按显示宽度无关的固定长度即可）。 */
export function hr(width = 58): string {
  return "-".repeat(width);
}
