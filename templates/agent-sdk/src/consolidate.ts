/**
 * One-shot memory consolidation: reads daily logs, asks an ephemeral agent
 * to produce consolidated MEMORY.md content, then writes it.
 * Used by `volute import` when no MEMORY.md exists but daily logs are present.
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { createMessageChannel } from "./lib/message-channel.js";

const projectRoot = process.cwd();
const soulPath = resolve(projectRoot, "home/SOUL.md");
const memoryPath = resolve(projectRoot, "home/MEMORY.md");
const memoryDir = resolve(projectRoot, "home/memory");

const soul = readFileSync(soulPath, "utf-8");

// Read all daily logs
const logs: string[] = [];
try {
  const files = readdirSync(memoryDir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
    .sort();
  for (const filename of files) {
    const date = filename.replace(".md", "");
    const content = readFileSync(resolve(memoryDir, filename), "utf-8").trim();
    if (content) {
      logs.push(`### ${date}\n\n${content}`);
    }
  }
} catch {
  // No logs directory
}

if (logs.length === 0) {
  console.log("No daily logs found.");
  process.exit(0);
}

const abortController = new AbortController();
const channel = createMessageChannel();

channel.push({
  type: "user",
  session_id: "",
  message: {
    role: "user",
    content: [
      {
        type: "text",
        text: [
          "You have daily logs from a previous environment but no long-term memory file yet.",
          "Please review the daily logs below and produce consolidated MEMORY.md content.",
          "Keep it concise and organized by topic. Output ONLY the markdown content for MEMORY.md, nothing else.",
          "",
          "## Daily logs",
          "",
          logs.join("\n\n"),
        ].join("\n"),
      },
    ],
  },
  parent_tool_use_id: null,
});

console.log("Consolidating memory from daily logs...");

const stream = query({
  prompt: channel.iterable,
  options: {
    systemPrompt: soul,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    cwd: projectRoot,
    abortController,
  },
});

const textParts: string[] = [];
for await (const msg of stream) {
  if (msg.type === "assistant") {
    for (const b of msg.message.content) {
      if (b.type === "text" && "text" in b) {
        const text = (b as { text: string }).text;
        textParts.push(text);
        process.stdout.write(text);
      }
    }
  }
  if (msg.type === "result") {
    break;
  }
}

const content = textParts.join("").trim();
if (content) {
  writeFileSync(memoryPath, `${content}\n`);
  console.log("\nMEMORY.md created successfully.");
} else {
  console.warn("\nWarning: No content produced.");
}

process.exit(0);
