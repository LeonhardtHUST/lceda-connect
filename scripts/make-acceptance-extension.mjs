#!/usr/bin/env node
// 生成隔离真机验收用的 .eext 测试包。
//
// 包内只有清单、入口脚本和图标；入口脚本提供两个菜单项：只读工程/文档/PCB 身份，
// 以及连接本机回显端口（用于验证「允许外部交互」权限的关闭与开启）。不写板、不读凭据。
//
// 用法：
//   node scripts/make-acceptance-extension.mjs [--out <path>] [--uuid <32位hex>]
//     [--name <5-30位小写名称>] [--echo-port <端口>]
//
// 默认输出 out/acceptance/<name>.eext，并打印身份与 SHA-256。

import { createHash, randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const NAME_RE = /^[a-z0-9_-]{5,30}$/u;
const UUID_RE = /^[0-9a-f]{32}$/u;
const VERSION_RE =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const PORT_RE = /^\d{1,5}$/u;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** 只写 store 方法的 ZIP；成员名都是 ASCII，路径分隔符统一为 `/`。 */
function buildZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    localParts.push(local, nameBytes, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBytes);

    offset += local.length + nameBytes.length + data.length;
  }
  const centralSize = centralParts.reduce((total, part) => total + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, ...centralParts, end]);
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") return { help: true };
    const name = arg.startsWith("--") ? arg.slice(2) : "";
    const value = argv[index + 1];
    if (!name || value === undefined || value.startsWith("--")) {
      throw new Error(`无法识别的参数：${arg}`);
    }
    values[name] = value;
    index += 1;
  }
  return values;
}

function pick(values, key, fallback) {
  const value = values[key];
  return value === undefined ? fallback : value;
}

function entrySource(name, echoPort) {
  return `// 验收探针：只读工程身份，并尝试连接本机回显端口；不写板、不读凭据。
const PROBE = ${JSON.stringify(name)};
const ECHO_PORT = ${echoPort};
const ECHO_ID = \`\${PROBE}-echo\`;

function toast(message, type) {
  try {
    eda.sys_Message.showToastMessage(message, type, 8);
  } catch {
    console.log(message);
  }
}

async function readIdentity() {
  const project = await eda.dmt_Project.getCurrentProjectInfo();
  const document = await eda.dmt_SelectControl.getCurrentDocumentInfo();
  const identity = {
    projectUuid: project?.uuid ?? null,
    documentUuid: document?.uuid ?? null,
    parentProjectUuid: document?.parentProjectUuid ?? null,
    documentType: document?.documentType ?? null,
  };
  toast(\`\${PROBE} 身份 \${JSON.stringify(identity)}\`, "success");
  return identity;
}

export async function showIdentity() {
  try {
    return await readIdentity();
  } catch (error) {
    const message = String(error?.message ?? error);
    toast(\`\${PROBE} 读取身份失败：\${message}\`, "error");
    return { error: message };
  }
}

export function connectEcho() {
  try {
    eda.sys_WebSocket.register(
      ECHO_ID,
      \`ws://127.0.0.1:\${ECHO_PORT}\`,
      (event) => toast(\`\${PROBE} 回显 \${String(event?.data)}\`, "success"),
      () => eda.sys_WebSocket.send(ECHO_ID, "ping"),
    );
    toast(\`\${PROBE} 已请求连接 127.0.0.1:\${ECHO_PORT}\`, "info");
    return { requested: true, port: ECHO_PORT };
  } catch (error) {
    const message = String(error?.message ?? error);
    toast(\`\${PROBE} 外部交互被拒绝：\${message}\`, "warn");
    return { denied: true, message };
  }
}

export function closeEcho() {
  try {
    eda.sys_WebSocket.close(ECHO_ID, 1000, "验收结束");
  } catch {
    // 连接未建立时忽略。
  }
}
`;
}

function manifest(name, uuid, displayName, version) {
  return {
    name,
    uuid,
    displayName,
    description: "隔离环境验收探针：只读工程身份并验证外部交互权限，不写板。",
    version,
    publisher: "lceda-connect acceptance",
    license: "GPL-3.0-only",
    categories: "Other",
    keywords: ["acceptance"],
    images: { logo: "./images/logo.png" },
    entry: "./dist/index",
    headerMenus: {
      pcb: [
        {
          id: "acceptance-probe",
          title: "Acceptance Probe",
          menuItems: [
            { id: "acceptance-read-identity", title: "读取工程身份", registerFn: "showIdentity" },
            { id: "acceptance-connect-echo", title: "连接回显端口", registerFn: "connectEcho" },
            { id: "acceptance-close-echo", title: "关闭回显连接", registerFn: "closeEcho" },
          ],
        },
      ],
    },
  };
}

function usage() {
  return [
    "用法：node scripts/make-acceptance-extension.mjs [选项]",
    "  --out <路径>       输出 .eext（默认 out/acceptance/<name>.eext）",
    "  --uuid <32位hex>   扩展 UUID（默认随机生成）",
    "  --name <名称>      机器名，5-30 位小写字母/数字/下划线/连字符（默认 lceda-acceptance-probe）",
    "  --display-name <显示名>（默认 LCEDA Acceptance Probe）",
    "  --version <版本>   扩展版本（默认 0.0.1；支持 prerelease/build）",
    "  --echo-port <端口> 回显 WebSocket 端口（默认 49631）",
  ].join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  const name = pick(args, "name", "lceda-acceptance-probe");
  const uuid = pick(args, "uuid", randomBytes(16).toString("hex"));
  const displayName = pick(args, "display-name", "LCEDA Acceptance Probe");
  const version = pick(args, "version", "0.0.1");
  const echoPort = pick(args, "echo-port", "49631");
  const output = path.resolve(pick(args, "out", path.join("out", "acceptance", `${name}.eext`)));

  if (!NAME_RE.test(name)) throw new Error("--name 必须是 5-30 位小写字母/数字/下划线/连字符");
  if (!UUID_RE.test(uuid)) throw new Error("--uuid 必须是 32 位小写十六进制");
  if (!VERSION_RE.test(version)) throw new Error("version 必须是 major.minor.patch");
  if (!PORT_RE.test(echoPort) || Number(echoPort) < 1 || Number(echoPort) > 65535) {
    throw new Error("--echo-port 必须是 1-65535 的整数");
  }

  const logo =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const zip = buildZip([
    {
      name: "extension.json",
      data: Buffer.from(`${JSON.stringify(manifest(name, uuid, displayName, version), null, 2)}\n`),
    },
    { name: "dist/index.js", data: Buffer.from(entrySource(name, echoPort)) },
    { name: "images/logo.png", data: Buffer.from(logo, "base64") },
  ]);

  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, zip, { mode: 0o600 });
  const sha256 = createHash("sha256").update(zip).digest("hex");
  console.log(
    JSON.stringify(
      { path: output, sha256, uuid, name, displayName, version, echoPort: Number(echoPort) },
      null,
      2,
    ),
  );
  console.log(`下一步：node dist/cli.mjs extension inspect --file ${JSON.stringify(output)}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
