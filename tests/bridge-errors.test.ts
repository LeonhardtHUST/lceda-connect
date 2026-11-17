import { expect, test, vi } from "vite-plus/test";

import { BridgeClientError, health } from "../src/bridge/client.ts";

for (const [transportCode, expectedCode] of [
  ["ECONNREFUSED", "NO_BRIDGE"],
  ["ECONNRESET", "PROTOCOL"],
  ["EHOSTUNREACH", "PROTOCOL"],
  ["ENOTFOUND", "PROTOCOL"],
  ["EACCES", "PROTOCOL"],
]) {
  test(`bridge health 对 ${transportCode} 返回 ${expectedCode}`, async () => {
    const error = new TypeError("fetch failed", {
      cause: Object.assign(new Error("transport failed"), { code: transportCode }),
    });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(error));
    try {
      const result = await health(49620).catch((caught: unknown) => caught);
      expect(result).toBeInstanceOf(BridgeClientError);
      expect((result as BridgeClientError).code).toBe(expectedCode);
    } finally {
      vi.unstubAllGlobals();
    }
  });
}

for (const name of ["TimeoutError", "AbortError"]) {
  test(`bridge health 保留 ${name} 的超时语义`, async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new DOMException("deadline", name)));
    try {
      const result = await health(49620).catch((caught: unknown) => caught);
      expect(result).toBeInstanceOf(BridgeClientError);
      expect((result as BridgeClientError).code).toBe("TIMEOUT");
    } finally {
      vi.unstubAllGlobals();
    }
  });
}
