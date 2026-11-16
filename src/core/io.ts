/** 终端输出抽象：命令实现只依赖这个接口，便于测试与 --json 模式复用。 */
export interface Io {
  out: (line?: string) => void;
  err: (line?: string) => void;
}

export const stdIo: Io = {
  out: (line = "") => {
    process.stdout.write(`${line}\n`);
  },
  err: (line = "") => {
    process.stderr.write(`${line}\n`);
  },
};

export interface MemoryIo extends Io {
  lines: string[];
  errors: string[];
}

/** 测试用：把输出收进数组，不碰真实 stdout。 */
export function createMemoryIo(): MemoryIo {
  const lines: string[] = [];
  const errors: string[] = [];
  return {
    lines,
    errors,
    out: (line = "") => {
      lines.push(line);
    },
    err: (line = "") => {
      errors.push(line);
    },
  };
}
