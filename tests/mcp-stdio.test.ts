import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { expect, test } from "vite-plus/test";

import { allTools } from "../src/mcp/registry.ts";

const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);

test.skipIf(nodeMajor < 22)(
  "stdio MCP 子进程完成握手、列工具、资源和 lceda_info",
  async () => {
    const script = path.resolve("src/cli-mcp.ts");
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    );
    delete env.LCEDA_TOOLSETS;
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--experimental-strip-types", script],
      cwd: process.cwd(),
      env,
      stderr: "pipe",
    });
    const client = new Client({ name: "mcp-stdio-test", version: "0.0.0" });
    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(allTools().length);
      expect(tools.map((tool) => tool.name)).toContain("lceda_info");

      const resources = await client.listResources();
      const skill = resources.resources.find((resource) =>
        resource.uri.startsWith("lceda://skills/"),
      );
      expect(skill).toBeDefined();
      if (skill) {
        const read = await client.readResource({ uri: skill.uri });
        expect(read.contents.length).toBeGreaterThan(0);
      }

      const result = await client.callTool({ name: "lceda_info", arguments: {} });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({ name: "lceda-connect" });
    } finally {
      await client.close();
    }
  },
  90_000,
);
