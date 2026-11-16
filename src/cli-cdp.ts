#!/usr/bin/env node
import { main } from "./main.ts";

process.exitCode = await main({ argv: process.argv.slice(2), defaultGroup: "cdp" });
