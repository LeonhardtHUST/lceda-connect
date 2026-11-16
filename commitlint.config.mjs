// 提交信息校验：在 @commitlint/config-conventional 之上补齐中文简述规范。
// 规则参考 template-mcu-STM32G474VET6-XPulse/commitlint.config.mjs。
//
// 机器能判定的：简述含汉字（至少一个）、不超过 50 字、结尾不加句号或分号。
// 「动词开头」属于语义判断，中文动词没有可靠词表，不在这里强制。
//
// 规则返回 [是否通过, 失败提示]（commitlint plugin rule 约定）。

const SUBJECT_MAX_CHARS = 50;

const chineseSubject = (parsed) => {
  const subject = parsed.subject || "";
  // 只要求「含汉字」，不限定首字：允许 `feat(mcp): MCP 服务骨架` 这类
  // 以型号、英文标识开头的简述。全英文或全符号仍然拒绝。
  if (!/[\u4e00-\u9fa5]/.test(subject)) {
    return [false, "简述必须使用中文（至少含一个汉字）"];
  }
  const length = Array.from(subject).length;
  if (length > SUBJECT_MAX_CHARS) {
    return [false, `简述不得超过 ${SUBJECT_MAX_CHARS} 字（当前 ${length} 字）`];
  }
  if (/[。．.；;]$/.test(subject)) {
    return [false, "简述结尾不得加句号或分号"];
  }
  return [true, ""];
};

export default {
  extends: ["@commitlint/config-conventional"],
  plugins: [
    {
      rules: {
        "chinese-subject": chineseSubject,
      },
    },
  ],
  rules: {
    // config-conventional 的 subject-case 面向英文大小写，会把中文与
    // 「MCP」「CDP」这类混排简述误判；汉字与长度已由 chinese-subject 覆盖。
    "subject-case": [0],
    "chinese-subject": [2, "always"],
  },
};
