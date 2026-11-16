/**
 * `.eprj3` 文件夹工程公共 API。
 *
 * - `records.ts`  记录语法、DOCHEAD 分段、按 ticket 归约（墓碑）；
 * - `project.ts`  索引、文档文件清单、inspect；
 * - `validate.ts` 格式门（墓碑感知，修正了源版对真机的几处误报）；
 * - `netlist.ts`  原理图 / PCB 网表；
 * - `sidecar.ts`  源技能脚本的子进程封装（建工程、原子编辑、门禁）；
 * - `mcpTools.ts` / `cli.ts`  MCP 工具与 CLI 入口。
 */
export * from "./cli.ts";
export * from "./mcpTools.ts";
export * from "./netlist.ts";
export * from "./project.ts";
export * from "./records.ts";
export * from "./sidecar.ts";
export * from "./validate.ts";
