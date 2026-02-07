import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createAgent } from "./lib/agent.js";
import { log } from "./lib/logger.js";
import { createVoluteServer } from "./lib/volute-server.js";

function parseArgs() {
  const args = process.argv.slice(2);
  let port = 4100;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--port" && args[i + 1]) {
      port = parseInt(args[++i], 10);
    }
  }

  return { port };
}

function loadConfig(): { model?: string } {
  try {
    return JSON.parse(readFileSync(resolve("volute.json"), "utf-8"));
  } catch {
    return {};
  }
}

function loadFile(path: string): string {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return "";
  }
}

const { port } = parseArgs();
const config = loadConfig();
const model = config.model;
if (model) {
  log("server", `using model: ${model}`);
}
const soulPath = resolve("home/SOUL.md");
const memoryPath = resolve("home/MEMORY.md");
const volutePath = resolve("home/VOLUTE.md");

const soul = loadFile(soulPath);
if (!soul) {
  console.error(`Could not read soul file: ${soulPath}`);
  process.exit(1);
}

const memory = loadFile(memoryPath);
const volute = loadFile(volutePath);

const promptParts = [soul];
if (volute) promptParts.push(volute);
if (memory) promptParts.push(`## Memory\n\n${memory}`);
const systemPrompt = promptParts.join("\n\n---\n\n");

const sessionPath = resolve(".volute/session.json");

function loadSessionId(): string | undefined {
  try {
    const data = JSON.parse(readFileSync(sessionPath, "utf-8"));
    return data.sessionId;
  } catch {
    return undefined;
  }
}

function saveSessionId(sessionId: string) {
  mkdirSync(dirname(sessionPath), { recursive: true });
  writeFileSync(sessionPath, JSON.stringify({ sessionId }));
}

let shuttingDown = false;

function deleteSessionFile() {
  if (shuttingDown) return;
  try {
    unlinkSync(sessionPath);
    log("server", "deleted session file");
  } catch {}
}

// Read name/version from package.json for health endpoint
let pkgName = "unknown";
let pkgVersion = "0.0.0";
try {
  const pkg = JSON.parse(readFileSync(resolve("package.json"), "utf-8"));
  pkgName = pkg.name || pkgName;
  pkgVersion = pkg.version || pkgVersion;
} catch {}

const abortController = new AbortController();
const savedSessionId = loadSessionId();
if (savedSessionId) {
  log("server", `resuming session: ${savedSessionId}`);
}
const agent = createAgent({
  systemPrompt,
  cwd: resolve("home"),
  abortController,
  model,
  resume: savedSessionId,
  onSessionId: saveSessionId,
  onStreamError: deleteSessionFile,
  onCompact: () => {
    log("server", "pre-compact — asking agent to update daily log");
    agent.sendMessage(
      "Conversation is about to be compacted. Please update today's daily log with a summary of what we've discussed and accomplished so far, so context is preserved before compaction.",
      "system",
    );
  },
  onIdentityReload: async () => {
    log("server", "identity file changed — restarting to reload");
    await agent.waitForCommits();
    server.close();
    process.exit(0);
  },
});

const server = createVoluteServer({ agent, port, name: pkgName, version: pkgVersion });

server.listen(port, () => {
  const addr = server.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : port;
  log("server", `listening on :${actualPort}`);

  // Check for post-merge context
  const mergedPath = resolve(".volute/merged.json");
  if (existsSync(mergedPath)) {
    try {
      const merged = JSON.parse(readFileSync(mergedPath, "utf-8"));
      unlinkSync(mergedPath);

      const parts = [
        `[system] Variant "${merged.name}" has been merged and you have been restarted.`,
      ];
      if (merged.summary) parts.push(`Changes: ${merged.summary}`);
      if (merged.justification) parts.push(`Why: ${merged.justification}`);
      if (merged.memory) parts.push(`Context: ${merged.memory}`);

      agent.sendMessage(parts.join("\n"));
      log("server", `sent post-merge orientation for variant: ${merged.name}`);
    } catch (e) {
      log("server", "failed to process merged.json:", e);
    }
  }
});

function shutdown() {
  shuttingDown = true;
  log("server", "shutdown signal received");
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
