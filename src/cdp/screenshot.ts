import fs from "node:fs";
import path from "node:path";

import { CdpError } from "./errors.ts";
import { apiExpression, evaluateExpression } from "./eval.ts";
import type { CdpSession } from "./session.ts";

/**
 * 截当前页面可视区（`Page.captureScreenshot`）。
 *
 * 截图前可先缩放到板框（`fit`）、临时隐藏若干层，截完把层恢复。恢复放在 finally 里，
 * 失败也不掩盖原始错误；`restored` 字段说明是否所有临时隐藏都恢复成功。
 *
 * 提醒：画面里可能带账号信息、工程名、器件编号，外发前自行确认。
 */

export interface ScreenshotOptions {
  /** 截图前缩放到板框（PCB 文档才有意义）。 */
  fit?: boolean;
  /** 临时隐藏的层 id；截完自动恢复。 */
  hideLayers?: readonly number[];
}

export interface CaptureResult {
  /** PNG 的 base64（与 CDP 返回一致）。 */
  data: string;
  fit: boolean;
  hidden: number[];
  /** 所有临时隐藏的层是否都恢复成功；没隐藏任何层时为 true。 */
  restored: boolean;
}

export interface ScreenshotResult {
  path: string;
  bytes: number;
  fit: boolean;
  hidden: number[];
  restored: boolean;
  warning: string;
}

/** 直接返回 base64，不落盘（供需要自己处理数据的调用方）。 */
export async function captureScreenshot(
  session: CdpSession,
  options: ScreenshotOptions = {},
): Promise<CaptureResult> {
  const fit = options.fit ?? false;
  const layers = options.hideLayers ?? [];
  for (const layer of layers) {
    if (!Number.isInteger(layer) || layer < 0) {
      throw new CdpError("SCREENSHOT_LAYER", `层 id 必须是非负整数，收到 ${String(layer)}`);
    }
  }

  await session.call("Page.enable");
  const hidden: number[] = [];
  let restored = true;

  try {
    if (fit) {
      await evaluateExpression(
        session,
        apiExpression("await A.pcb_Document.zoomToBoardOutline(); return true;"),
      );
    }
    for (const layer of layers) {
      await evaluateExpression(
        session,
        apiExpression(`await A.pcb_Layer.setLayerInvisible(${layer}); return true;`),
      );
      hidden.push(layer);
    }

    const shot = await session.call<{ data?: string }>("Page.captureScreenshot", {
      format: "png",
    });
    if (typeof shot.data !== "string" || shot.data === "") {
      throw new CdpError("SCREENSHOT_EMPTY", "截图失败：没有返回数据。", { exitCode: 4 });
    }
    return { data: shot.data, fit, hidden, restored };
  } finally {
    for (const layer of hidden) {
      try {
        await evaluateExpression(
          session,
          apiExpression(`await A.pcb_Layer.setLayerVisible(${layer}); return true;`),
        );
      } catch {
        // 恢复失败不掩盖原始错误，但要在结果里说清楚
        restored = false;
      }
    }
  }
}

/** 截图并落盘到 `outPath`（自动建目录）。 */
export async function screenshotToFile(
  session: CdpSession,
  outPath: string,
  options: ScreenshotOptions = {},
): Promise<ScreenshotResult> {
  const captured = await captureScreenshot(session, options);
  const target = path.resolve(outPath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const buffer = Buffer.from(captured.data, "base64");
  fs.writeFileSync(target, buffer);
  return {
    path: target,
    bytes: buffer.byteLength,
    fit: captured.fit,
    hidden: captured.hidden,
    restored: captured.restored,
    warning: "截图可能含账号、工程名、器件编号，外发前自行确认。",
  };
}
