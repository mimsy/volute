/**
 * One-shot memory consolidation: spins up an ephemeral agent with the soul
 * loaded, asks it to consolidate daily logs into MEMORY.md, then exits.
 * Used by `molt import` when no MEMORY.md exists but daily logs are present.
 */
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { query, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { memoryTools } from "./lib/memory-tools.js";
import { createMessageChannel } from "./lib/message-channel.js";

const projectRoot = process.cwd();
const soulPath = resolve(projectRoot, "home/SOUL.md");
const memoryPath = resolve(projectRoot, "home/MEMORY.md");

const soul = readFileSync(soulPath, "utf-8");

const mcpServer = createSdkMcpServer({
  name: "memory",
  tools: memoryTools,
});

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
        text: "You have daily logs from a previous environment but no long-term memory file yet. Please use consolidate_memory (with days=0 so all logs are included) to review your daily logs, then use write_memory to create your MEMORY.md with the important long-term knowledge. Keep it concise and organized by topic.",
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
    mcpServers: { memory: mcpServer },
  },
});

for await (const msg of stream) {
  if (msg.type === "assistant") {
    for (const b of msg.message.content) {
      if (b.type === "text" && "text" in b) {
        console.log((b as { text: string }).text);
      }
    }
  }
  if (msg.type === "result") {
    break;
  }
}

if (existsSync(memoryPath)) {
  console.log("MEMORY.md created successfully.");
} else {
  console.warn("Warning: MEMORY.md was not created.");
}

process.exit(0);
