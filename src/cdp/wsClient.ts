import { createHash, randomBytes } from "node:crypto";
import net from "node:net";

import { CdpError } from "./errors.ts";

/**
 * 零依赖 RFC6455 WebSocket 客户端，只够 CDP 用：文本帧、分片、ping/pong、close。
 *
 * 为什么不用 `ws` 包或全局 WebSocket：本仓库的连接层要保持零运行时依赖（源仓库脚本
 * 也只用 Python 标准库）；Node 20 没有全局 WebSocket。握手走 node:net 手写 HTTP 升级，
 * 帧编解码在下面单独导出，测试可以直接对字节断言。
 */

/** RFC6455 操作码。 */
export const WS_OPCODE = {
  continuation: 0x0,
  text: 0x1,
  binary: 0x2,
  close: 0x8,
  ping: 0x9,
  pong: 0xa,
} as const;

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
/** 单帧长度上限：CDP 的单条消息远小于这个数，超出说明帧头已经坏了。 */
const MAX_FRAME_BYTES = 64 * 1024 * 1024;

export interface WsFrame {
  fin: boolean;
  opcode: number;
  /** 已去掩码（服务端帧通常不掩码，客户端帧一定会掩码）。 */
  payload: Buffer;
}

/** 计算 `Sec-WebSocket-Accept`（测试里的假 CDP 服务也要用）。 */
export function webSocketAccept(key: string): string {
  return createHash("sha1").update(`${key}${WS_GUID}`).digest("base64");
}

/** 按 4 字节掩码循环异或。 */
export function maskPayload(payload: Buffer, maskKey: Buffer): Buffer {
  if (maskKey.length !== 4) throw new Error("WebSocket 掩码必须是 4 字节");
  const out = Buffer.allocUnsafe(payload.length);
  for (let index = 0; index < payload.length; index += 1) {
    out[index] = payload[index] ^ maskKey[index % 4];
  }
  return out;
}

export interface EncodeFrameOptions {
  /** 客户端发出的帧必须掩码；服务端帧不掩码（测试用）。 */
  mask?: boolean;
  fin?: boolean;
  maskKey?: Buffer;
}

/** 编码一个完整的 WebSocket 帧（不做分片）。 */
export function encodeWsFrame(
  opcode: number,
  payload: Buffer,
  options: EncodeFrameOptions = {},
): Buffer {
  const fin = options.fin ?? true;
  const masked = options.mask ?? false;
  const maskKey = masked ? (options.maskKey ?? randomBytes(4)) : null;
  const extended = payload.length < 126 ? 0 : payload.length < 65536 ? 2 : 8;
  const header = Buffer.allocUnsafe(2 + extended + (masked ? 4 : 0));

  let offset = 0;
  header[offset] = (fin ? 0x80 : 0) | (opcode & 0x0f);
  offset += 1;

  if (extended === 0) {
    header[offset] = (masked ? 0x80 : 0) | payload.length;
    offset += 1;
  } else if (extended === 2) {
    header[offset] = (masked ? 0x80 : 0) | 126;
    offset += 1;
    header.writeUInt16BE(payload.length, offset);
    offset += 2;
  } else {
    header[offset] = (masked ? 0x80 : 0) | 127;
    offset += 1;
    header.writeBigUInt64BE(BigInt(payload.length), offset);
    offset += 8;
  }

  if (maskKey) {
    maskKey.copy(header, offset);
    offset += 4;
  }

  return Buffer.concat([
    header.subarray(0, offset),
    maskKey ? maskPayload(payload, maskKey) : payload,
  ]);
}

export interface DecodedFrame {
  frame: WsFrame;
  rest: Buffer;
}

/**
 * 从缓冲区里解出一帧；数据不完整返回 null，其余字节留在 `rest` 里。
 * 支持 126 / 127 两种扩展长度与掩码帧。
 */
export function decodeWsFrame(buffer: Buffer): DecodedFrame | null {
  if (buffer.length < 2) return null;
  const first = buffer[0];
  const second = buffer[1];
  const fin = (first & 0x80) !== 0;
  const opcode = first & 0x0f;
  const masked = (second & 0x80) !== 0;

  let length = second & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < offset + 2) return null;
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    if (buffer.length < offset + 8) return null;
    const big = buffer.readBigUInt64BE(offset);
    offset += 8;
    if (big > BigInt(MAX_FRAME_BYTES)) {
      throw new CdpError("WS_PROTOCOL", `WebSocket 帧长度异常：${big.toString()} 字节`);
    }
    length = Number(big);
  }

  let maskKey: Buffer | null = null;
  if (masked) {
    if (buffer.length < offset + 4) return null;
    maskKey = buffer.subarray(offset, offset + 4);
    offset += 4;
  }

  if (buffer.length < offset + length) return null;
  const raw = buffer.subarray(offset, offset + length);
  const payload = maskKey ? maskPayload(raw, maskKey) : raw;
  return {
    frame: { fin, opcode, payload },
    rest: buffer.subarray(offset + length),
  };
}

/** 增量帧解析器：socket 的 data 事件喂进来，按需取整帧。 */
export class WsFrameParser {
  private rest: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): void {
    this.rest = this.rest.length === 0 ? chunk : Buffer.concat([this.rest, chunk]);
  }

  next(): WsFrame | null {
    const decoded = decodeWsFrame(this.rest);
    if (!decoded) return null;
    this.rest = decoded.rest;
    return decoded.frame;
  }

  get pendingBytes(): number {
    return this.rest.length;
  }
}

interface PendingReceive {
  resolve: (text: string) => void;
  reject: (error: Error) => void;
}

export interface WsClientOptions {
  host: string;
  port: number;
  /** 形如 /devtools/browser/<uuid> 的路径（含查询串）。 */
  path: string;
  timeoutMs?: number;
}

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 20_000;

/**
 * 已握手的 CDP WebSocket 连接。只提供文本消息收发：
 * - 收到 ping 自动回 pong；
 * - 分片按 continuation 拼成一条消息；
 * - 收到 close 或 socket 断开时，所有等待中的 recvText 都以错误结束。
 */
export class WsClient {
  private readonly socket: net.Socket;
  private readonly parser = new WsFrameParser();
  private readonly pending: PendingReceive[] = [];
  private readonly messages: string[] = [];
  private fragments: Buffer[] = [];
  private failure: Error | null = null;
  private closed = false;

  private constructor(socket: net.Socket, leftover: Buffer) {
    this.socket = socket;
    this.attach();
    if (leftover.length > 0) this.consume(leftover);
  }

  /** 连接并完成 HTTP 升级握手；失败抛带 code 的 CdpError。 */
  static async connect(options: WsClientOptions): Promise<WsClient> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    const key = randomBytes(16).toString("base64");
    const socket = net.createConnection({ host: options.host, port: options.port });
    socket.setNoDelay(true);

    const request =
      `GET ${options.path} HTTP/1.1\r\n` +
      `Host: ${options.host}:${options.port}\r\n` +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Key: ${key}\r\n` +
      "Sec-WebSocket-Version: 13\r\n\r\n";

    let leftover: Buffer;
    try {
      leftover = await performHandshake(socket, request, key, timeoutMs);
    } catch (error) {
      socket.destroy();
      throw error;
    }
    return new WsClient(socket, leftover);
  }

  /** 发一条文本消息（客户端帧，必掩码）。 */
  sendText(text: string): void {
    this.sendFrame(WS_OPCODE.text, Buffer.from(text, "utf8"));
  }

  /** 等一条完整文本消息；断连/关闭时 reject。 */
  recvText(): Promise<string> {
    if (this.failure) return Promise.reject(this.failure);
    const queued = this.messages.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise<string>((resolve, reject) => {
      this.pending.push({ resolve, reject });
    });
  }

  /** 发 close 帧并关闭 socket；重复调用无害。 */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    const error = new CdpError("WS_CLOSED", "WebSocket 已关闭");
    if (!this.failure) this.failure = error;
    try {
      if (this.socket.writable) {
        this.socket.write(encodeWsFrame(WS_OPCODE.close, Buffer.alloc(0), { mask: true }));
      }
    } catch {
      // 已经断了就只做清理
    }
    this.socket.end();
    // 给对端一点时间收 close 帧，不阻塞调用方（unref 避免拖住进程退出）。
    const timer = setTimeout(() => this.socket.destroy(), 50);
    timer.unref();
    this.rejectPending(error);
  }

  private attach(): void {
    this.socket.on("data", (chunk: Buffer) => {
      this.consume(chunk);
    });
    this.socket.on("error", (error: Error) => {
      this.fail(new CdpError("WS_ERROR", `WebSocket 连接出错：${error.message}`, { cause: error }));
    });
    this.socket.on("end", () => {
      this.fail(new CdpError("WS_CLOSED", "WebSocket 连接已被对端关闭"));
    });
    this.socket.on("close", () => {
      this.fail(new CdpError("WS_CLOSED", "WebSocket 连接已关闭"));
    });
  }

  private consume(chunk: Buffer): void {
    if (this.failure) return;
    this.parser.push(chunk);
    for (;;) {
      let frame: WsFrame | null;
      try {
        frame = this.parser.next();
      } catch (error) {
        this.fail(error instanceof Error ? error : new CdpError("WS_PROTOCOL", String(error)));
        return;
      }
      if (!frame) return;
      this.handleFrame(frame);
    }
  }

  private handleFrame(frame: WsFrame): void {
    switch (frame.opcode) {
      case WS_OPCODE.close:
        this.socket.end();
        this.fail(new CdpError("WS_CLOSED", "WebSocket 被对端关闭"));
        return;
      case WS_OPCODE.ping:
        // 对端探活：原样回 payload，CDP 服务不会主动 ping，但代理/中间层可能会。
        this.sendFrame(WS_OPCODE.pong, frame.payload);
        return;
      case WS_OPCODE.pong:
        return;
      case WS_OPCODE.text:
        this.fragments = [frame.payload];
        break;
      case WS_OPCODE.continuation:
        this.fragments.push(frame.payload);
        break;
      case WS_OPCODE.binary:
        // CDP 只用文本；二进制帧忽略（继续等文本，不要拼进 JSON）
        this.fragments = [];
        return;
      default:
        return;
    }
    if (!frame.fin) return;
    const text = Buffer.concat(this.fragments).toString("utf8");
    this.fragments = [];
    this.deliver(text);
  }

  private deliver(text: string): void {
    const waiter = this.pending.shift();
    if (waiter) waiter.resolve(text);
    else this.messages.push(text);
  }

  private sendFrame(opcode: number, payload: Buffer): void {
    if (this.failure) throw this.failure;
    if (this.closed || !this.socket.writable) {
      throw new CdpError("WS_CLOSED", "WebSocket 已关闭，无法发送消息");
    }
    this.socket.write(encodeWsFrame(opcode, payload, { mask: true }));
  }

  private fail(error: Error): void {
    if (!this.failure) this.failure = error;
    this.rejectPending(this.failure);
  }

  private rejectPending(error: Error): void {
    for (const waiter of this.pending.splice(0)) waiter.reject(error);
  }
}

function performHandshake(
  socket: net.Socket,
  request: string,
  key: string,
  timeoutMs: number,
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    let settled = false;
    let buffer = Buffer.alloc(0);

    const timer = setTimeout(() => {
      finish(new CdpError("CDP_TIMEOUT", `WebSocket 握手超时（${timeoutMs}ms）`, { exitCode: 4 }));
    }, timeoutMs);
    timer.unref();

    const cleanup = (): void => {
      clearTimeout(timer);
      socket.off("connect", onConnect);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
    };

    const finish = (error: Error | null, leftover?: Buffer): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(leftover ?? Buffer.alloc(0));
    };

    const onConnect = (): void => {
      socket.write(request);
    };
    const onError = (error: Error): void => {
      finish(new CdpError("WS_ERROR", `WebSocket 连接失败：${error.message}`, { cause: error }));
    };
    const onClose = (): void => {
      finish(new CdpError("WS_CLOSED", "WebSocket 握手期间连接被关闭"));
    };
    const onData = (chunk: Buffer): void => {
      buffer = Buffer.concat([buffer, chunk]);
      const headEnd = buffer.indexOf("\r\n\r\n");
      if (headEnd < 0) return;
      const head = buffer.subarray(0, headEnd).toString("latin1");
      const rest = buffer.subarray(headEnd + 4);
      const lines = head.split("\r\n");
      const statusLine = lines[0] ?? "";
      if (!/ 101 /.test(`${statusLine} `)) {
        finish(new CdpError("WS_PROTOCOL", `WebSocket 握手被拒绝：${statusLine}`, { exitCode: 4 }));
        return;
      }
      const acceptLine = lines.find((line) => /^sec-websocket-accept:/i.test(line));
      const accept = acceptLine ? acceptLine.slice(acceptLine.indexOf(":") + 1).trim() : "";
      if (accept !== webSocketAccept(key)) {
        finish(new CdpError("WS_PROTOCOL", "WebSocket 握手失败：Sec-WebSocket-Accept 不匹配"));
        return;
      }
      finish(null, rest);
    };

    socket.once("connect", onConnect);
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}
