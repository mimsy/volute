import { createServer, type ServerResponse, type IncomingMessage } from "http";
import { readFileSync, existsSync, unlinkSync } from "fs";
import { resolve } from "path";
import { createAgent } from "./lib/agent.js";
import type { MoltMessage } from "./lib/types.js";
import { log } from "./lib/logger.js";

function parseArgs() {
  const args = process.argv.slice(2);
  let port = 4100;
  let model: string | undefined;
  let thinkingLevel: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--port" && args[i + 1]) {
      port = parseInt(args[++i], 10);
    } else if (args[i] === "--model" && args[i + 1]) {
      model = args[++i];
    } else if (args[i] === "--thinking-level" && args[i + 1]) {
      thinkingLevel = args[++i];
    }
  }

  return { port, model, thinkingLevel };
}

function loadFile(path: string): string {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return "";
  }
}

const { port, model, thinkingLevel } = parseArgs();
const soulPath = resolve("home/SOUL.md");
const memoryPath = resolve("home/MEMORY.md");
const identityPath = resolve("home/IDENTITY.md");
const userPath = resolve("home/USER.md");

const soul = loadFile(soulPath);
if (!soul) {
  console.error(`Could not read soul file: ${soulPath}`);
  process.exit(1);
}

const identity = loadFile(identityPath);
const user = loadFile(userPath);
const memory = loadFile(memoryPath);

const promptParts = [soul];
if (identity) promptParts.push(identity);
if (user) promptParts.push(user);
if (memory) promptParts.push(`## Memory\n\n${memory}`);
const systemPrompt = promptParts.join("\n\n---\n\n");

// Check if a session directory exists (indicates resumable session)
const sessionsDir = resolve("home/.pi/sessions");
const hasExistingSession = existsSync(sessionsDir);
if (hasExistingSession) {
  log("server", "found existing sessions, will attempt resume");
}

// Read name/version from package.json for health endpoint
let pkgName = "unknown";
let pkgVersion = "0.0.0";
try {
  const pkg = JSON.parse(readFileSync(resolve("package.json"), "utf-8"));
  pkgName = pkg.name || pkgName;
  pkgVersion = pkg.version || pkgVersion;
} catch {}

const agent = await createAgent({
  systemPrompt,
  cwd: resolve("home"),
  model,
  thinkingLevel,
  resume: hasExistingSession,
  onCompact: () => {
    log("server", "compact boundary — asking agent to update daily log");
    agent.sendMessage(
      "Conversation history was just compacted. Please update today's daily log with a summary of what we've discussed and accomplished so far, so context is preserved.",
      "system",
    );
  },
});

const sseClients = new Set<ServerResponse>();

function removeClient(res: ServerResponse) {
  sseClients.delete(res);
  try {
    res.end();
  } catch {}
}

agent.onMessage((msg: MoltMessage) => {
  const data = `data: ${JSON.stringify(msg)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(data);
    } catch {
      removeClient(client);
    }
  }
});

// Keep SSE connections alive
setInterval(() => {
  for (const client of sseClients) {
    try {
      client.write(": keepalive\n\n");
    } catch {
      removeClient(client);
    }
  }
}, 5000);

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url!, `http://localhost`);

  if (req.method === "GET" && url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", name: pkgName, version: pkgVersion }));
    return;
  }

  if (req.method === "GET" && url.pathname === "/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    sseClients.add(res);
    log("server", `SSE client connected (total: ${sseClients.size})`);

    req.on("close", () => {
      removeClient(res);
      log("server", `SSE client disconnected (total: ${sseClients.size})`);
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/message") {
    try {
      const body = JSON.parse(await readBody(req)) as { content: string; source?: string };
      log("server", "POST /message:", body.content.slice(0, 120));
      agent.sendMessage(body.content, body.source);
      res.writeHead(200);
      res.end("OK");
    } catch {
      res.writeHead(400);
      res.end("Bad Request");
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/command") {
    try {
      const body = JSON.parse(await readBody(req)) as { type: string; context?: string };
      log("server", `POST /command: type=${body.type}`);

      if (body.type === "update-memory" && body.context) {
        agent.sendMessage(
          `Please update your memory with the following context:\n\n${body.context}`,
          "command",
        );
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
      } else {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unknown command type" }));
      }
    } catch {
      res.writeHead(400);
      res.end("Bad Request");
    }
    return;
  }

  res.writeHead(404);
  res.end("Not Found");
});

let retries = 0;
const maxRetries = 5;
server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    retries++;
    if (retries > maxRetries) {
      log("server", `port ${port} in use after ${maxRetries} retries, exiting`);
      process.exit(1);
    }
    log("server", `port ${port} in use, retrying in 1s... (${retries}/${maxRetries})`);
    setTimeout(() => server.listen(port), 1000);
  } else {
    throw err;
  }
});

server.listen(port, () => {
  const addr = server.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : port;
  log("server", `listening on :${actualPort}`);

  // Build orientation message parts
  const orientationParts: string[] = [];

  // Check for post-merge context
  const mergedPath = resolve(".molt/merged.json");
  if (existsSync(mergedPath)) {
    try {
      const merged = JSON.parse(readFileSync(mergedPath, "utf-8"));
      unlinkSync(mergedPath);

      const parts = [`Variant "${merged.name}" has been merged successfully and you have been restarted.`];
      if (merged.summary) parts.push(`Changes: ${merged.summary}`);
      if (merged.justification) parts.push(`Why: ${merged.justification}`);
      if (merged.memory) parts.push(`Context: ${merged.memory}`);
      parts.push("Please update your memory with any relevant information from this merge.");

      orientationParts.push(parts.join("\n"));
      log("server", `sent post-merge orientation for variant: ${merged.name}`);
    } catch (e) {
      log("server", "failed to process merged.json:", e);
    }
  }

  if (orientationParts.length > 0) {
    agent.sendMessage(orientationParts.join("\n\n---\n\n"));
  }
});

function shutdown() {
  log("server", "shutdown signal received");
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
