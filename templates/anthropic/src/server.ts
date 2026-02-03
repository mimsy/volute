#!/usr/bin/env bun
import { readFileSync } from "fs";
import { resolve } from "path";
import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { createAgent } from "./lib/agent.js";
import { selfModifyTools, cleanupAll } from "./lib/self-modify-tools.js";
import type { MoltMessage } from "./lib/types.js";
import { log } from "./lib/logger.js";

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

function loadFile(path: string): string {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return "";
  }
}

const { port } = parseArgs();
const soulPath = resolve("SOUL.md");
const memoryPath = resolve("MEMORY.md");

const soul = loadFile(soulPath);
if (!soul) {
  console.error(`Could not read soul file: ${soulPath}`);
  process.exit(1);
}

const memory = loadFile(memoryPath);
const systemPrompt = memory ? `${soul}\n\n## Memory\n\n${memory}` : soul;

// Read name/version from package.json for health endpoint
let pkgName = "unknown";
let pkgVersion = "0.0.0";
try {
  const pkg = JSON.parse(readFileSync(resolve("package.json"), "utf-8"));
  pkgName = pkg.name || pkgName;
  pkgVersion = pkg.version || pkgVersion;
} catch {}

const selfModifyServer = createSdkMcpServer({
  name: "self-modify",
  tools: selfModifyTools,
});

const abortController = new AbortController();
const agent = createAgent({
  systemPrompt,
  cwd: process.cwd(),
  abortController,
  mcpServers: { "self-modify": selfModifyServer },
});

type SSEClient = {
  controller: ReadableStreamDefaultController;
};

const sseClients = new Set<SSEClient>();

function removeClient(client: SSEClient) {
  sseClients.delete(client);
  try {
    client.controller.close();
  } catch {}
}

agent.onMessage((msg: MoltMessage) => {
  const data = `data: ${JSON.stringify(msg)}\n\n`;
  for (const client of sseClients) {
    try {
      client.controller.enqueue(data);
    } catch {
      removeClient(client);
    }
  }
});

// Keep SSE connections alive so Bun doesn't idle-timeout them
setInterval(() => {
  for (const client of sseClients) {
    try {
      client.controller.enqueue(": keepalive\n\n");
    } catch {
      removeClient(client);
    }
  }
}, 5000);

const server = Bun.serve({
  port,
  fetch(req) {
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname === "/health") {
      return Response.json({ status: "ok", name: pkgName, version: pkgVersion });
    }

    if (req.method === "GET" && url.pathname === "/events") {
      const stream = new ReadableStream({
        start(controller) {
          const client: SSEClient = { controller };
          sseClients.add(client);
          log("server", `SSE client connected (total: ${sseClients.size})`);
          req.signal.addEventListener("abort", () => {
            removeClient(client);
            log("server", `SSE client disconnected (total: ${sseClients.size})`);
          });
        },
      });

      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    }

    if (req.method === "POST" && url.pathname === "/message") {
      return req.json().then((body: { content: string; source?: string }) => {
        log("server", "POST /message:", body.content.slice(0, 120));
        agent.sendMessage(body.content, body.source);
        return new Response("OK", { status: 200 });
      });
    }

    return new Response("Not Found", { status: 404 });
  },
});

log("server", `listening on :${server.port}`);

function shutdown() {
  log("server", "shutdown signal received");
  cleanupAll();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
