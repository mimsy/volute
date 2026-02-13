#!/usr/bin/env npx tsx
/**
 * Session reader — displays a human-readable log of another session's activity.
 *
 * Usage: npx tsx .config/scripts/session-reader.ts <session-name> [--lines N]
 *
 * Runs from the agent's home/ directory.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  readSessionLog,
  resolveAgentSdkJsonl,
  resolvePiJsonl,
} from "../../src/lib/session-monitor.js";

const args = process.argv.slice(2);
let sessionName: string | undefined;
let lines = 50;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--lines" && args[i + 1]) {
    lines = parseInt(args[++i], 10);
  } else if (!sessionName && !args[i].startsWith("-")) {
    sessionName = args[i];
  }
}

if (!sessionName) {
  console.error("Usage: npx tsx .config/scripts/session-reader.ts <session-name> [--lines N]");
  process.exit(1);
}

// Detect template type and resolve JSONL path
const cwd = process.cwd();
const agentSdkSessions = resolve(cwd, "../.volute/sessions");
const piSessions = resolve(cwd, "../.volute/pi-sessions");

let jsonlPath: string | null = null;
let format: "agent-sdk" | "pi";

if (existsSync(agentSdkSessions)) {
  format = "agent-sdk";
  jsonlPath = resolveAgentSdkJsonl(agentSdkSessions, sessionName, cwd);
} else if (existsSync(piSessions)) {
  format = "pi";
  jsonlPath = resolvePiJsonl(piSessions, sessionName);
} else {
  console.error("No session directory found. Expected .volute/sessions/ or .volute/pi-sessions/");
  process.exit(1);
}

if (!jsonlPath || !existsSync(jsonlPath)) {
  console.error(`No session log found for "${sessionName}".`);
  process.exit(1);
}

const output = readSessionLog({ jsonlPath, format, lines });
console.log(output);
