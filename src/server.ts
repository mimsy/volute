#!/usr/bin/env bun
import { readFileSync } from "fs";
import { resolve } from "path";
import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { createAgent } from "./lib/agent.js";
import { selfModifyTools, cleanupAll } from "./lib/self-modify-tools.js";
import type { ChatMessage } from "./lib/types.js";
import { log } from "./lib/logger.js";

function parseArgs() {
  const args = process.argv.slice(2);
  let soul = "SOUL.md";
  let port = 4100;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--soul" && args[i + 1]) {
      soul = args[++i];
    } else if (args[i] === "--port" && args[i + 1]) {
      port = parseInt(args[++i], 10);
    } else if (!args[i].startsWith("-")) {
      soul = args[i];
    }
  }

  return { soul, port };
}

const { soul, port } = parseArgs();
const soulPath = resolve(soul);
let systemPrompt: string;
try {
  systemPrompt = readFileSync(soulPath, "utf-8");
} catch {
  console.error(`Could not read soul file: ${soulPath}`);
  process.exit(1);
}

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

agent.onMessage((msg: ChatMessage) => {
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

Bun.serve({
  port,
  fetch(req) {
    const url = new URL(req.url);

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
      return req.json().then((body: { content: string }) => {
        log("server", "POST /message:", body.content.slice(0, 120));
        agent.sendMessage(body.content);
        return new Response("OK", { status: 200 });
      });
    }

    return new Response("Not Found", { status: 404 });
  },
});

log("server", `listening on :${port}`);

function shutdown() {
  log("server", "shutdown signal received");
  cleanupAll();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
