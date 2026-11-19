#!/usr/bin/env node
import { main } from "./main.ts";

process.exitCode = await main({ argv: ["mcp", ...process.argv.slice(2)] });
