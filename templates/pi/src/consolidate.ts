/**
 * One-shot memory consolidation: reads daily logs, asks an ephemeral agent
 * to produce consolidated MEMORY.md content, then writes it.
 * Used by `volute import` when no MEMORY.md exists but daily logs are present.
 */

import {
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@mariozechner/pi-coding-agent";
import { readdirSync, readFileSync, writeFileSync } from "fs";
import { resolve } from "path";

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

console.log("Consolidating memory from daily logs...");

const authStorage = new AuthStorage();
const modelRegistry = new ModelRegistry(authStorage);

const { session } = await createAgentSession({
  cwd: projectRoot,
  systemPrompt: soul,
  authStorage,
  modelRegistry,
  sessionManager: SessionManager.inMemory(),
  settingsManager: SettingsManager.inMemory({
    compaction: { enabled: false },
  }),
});

const textParts: string[] = [];

session.subscribe((event) => {
  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
    const text = event.assistantMessageEvent.delta;
    textParts.push(text);
    process.stdout.write(text);
  }
});

await session.prompt(
  [
    "You have daily logs from a previous environment but no long-term memory file yet.",
    "Please review the daily logs below and produce consolidated MEMORY.md content.",
    "Keep it concise and organized by topic. Output ONLY the markdown content for MEMORY.md, nothing else.",
    "",
    "## Daily logs",
    "",
    logs.join("\n\n"),
  ].join("\n"),
);

// Wait for agent to finish
await session.agent.waitForIdle();

const content = textParts.join("").trim();
if (content) {
  writeFileSync(memoryPath, content + "\n");
  console.log("\nMEMORY.md created successfully.");
} else {
  console.warn("\nWarning: No content produced.");
}

process.exit(0);
