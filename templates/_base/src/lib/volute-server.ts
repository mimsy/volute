import { createServer, type IncomingMessage, type Server } from "node:http";
import { log } from "./logger.js";
import { loadSessionConfig, resolveBatch, resolveSession } from "./sessions.js";
import type { ChannelMeta, VoluteContentPart, VoluteEvent, VoluteRequest } from "./types.js";

export type VoluteAgent = {
  sendMessage: (content: string | VoluteContentPart[], meta?: ChannelMeta) => void;
  onMessage: (listener: (event: VoluteEvent) => void, sessionName?: string) => () => void;
};

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

type BufferedMessage = {
  text: string;
  sender?: string;
  channel?: string;
  channelName?: string;
  guildName?: string;
  timestamp: string;
};

type BatchBuffer = {
  messages: BufferedMessage[];
  timer: ReturnType<typeof setInterval>;
};

export function createVoluteServer(options: {
  agent: VoluteAgent;
  port: number;
  name: string;
  version: string;
  sessionsConfigPath?: string;
}): Server {
  const { agent, port, name, version } = options;

  const batchBuffers = new Map<string, BatchBuffer>();

  function flushBatch(sessionName: string) {
    const buffer = batchBuffers.get(sessionName);
    if (!buffer || buffer.messages.length === 0) return;

    const messages = buffer.messages.splice(0);

    // Group by channel for header summary
    const channelCounts = new Map<string, number>();
    for (const msg of messages) {
      const label = msg.channelName
        ? `#${msg.channelName}${msg.guildName ? ` in ${msg.guildName}` : ""}`
        : (msg.channel ?? "unknown");
      channelCounts.set(label, (channelCounts.get(label) ?? 0) + 1);
    }
    const summary = [...channelCounts.entries()].map(([ch, n]) => `${n} from ${ch}`).join(", ");

    const header = `[Batch: ${messages.length} message${messages.length === 1 ? "" : "s"} — ${summary}]`;
    const body = messages
      .map((m) => `[${m.sender ?? "unknown"} — ${m.timestamp}]\n${m.text}`)
      .join("\n\n");

    const formatted = `${header}\n\n${body}`;

    // Use the channel from the first message for metadata
    const first = messages[0];
    agent.sendMessage(formatted, {
      channel: first.channel,
      sender: "batch",
      platform: "Discord",
      channelName: first.channelName,
      guildName: first.guildName,
      sessionName,
    });

    log("server", `flushed batch for session ${sessionName}: ${messages.length} messages`);
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://localhost");

    if (req.method === "GET" && url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", name, version }));
      return;
    }

    if (req.method === "POST" && url.pathname === "/message") {
      try {
        const body = JSON.parse(await readBody(req)) as VoluteRequest;

        // Resolve session from routing config (re-read on each request for hot-reload)
        let sessionName = "main";
        let batchMinutes: number | undefined;
        if (options.sessionsConfigPath) {
          const sessionConfig = loadSessionConfig(options.sessionsConfigPath);
          sessionName = resolveSession(sessionConfig, {
            channel: body.channel,
            sender: body.sender,
          });
          batchMinutes = resolveBatch(sessionConfig, {
            channel: body.channel,
            sender: body.sender,
          });
        }
        if (sessionName === "$new") {
          sessionName = `new-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        }

        // Batch mode: buffer the message and return immediately
        if (batchMinutes != null) {
          const text = body.content
            .filter((p): p is { type: "text"; text: string } => p.type === "text")
            .map((p) => p.text)
            .join("\n");

          if (!batchBuffers.has(sessionName)) {
            const timer = setInterval(() => flushBatch(sessionName), batchMinutes * 60 * 1000);
            timer.unref();
            batchBuffers.set(sessionName, { messages: [], timer });
          }

          batchBuffers.get(sessionName)!.messages.push({
            text,
            sender: body.sender,
            channel: body.channel,
            channelName: body.channelName,
            guildName: body.guildName,
            timestamp: new Date().toLocaleTimeString("en-US", {
              hour: "numeric",
              minute: "2-digit",
            }),
          });

          res.writeHead(200, { "Content-Type": "application/x-ndjson" });
          res.end(`${JSON.stringify({ type: "done" })}\n`);
          return;
        }

        const messageId = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

        res.writeHead(200, {
          "Content-Type": "application/x-ndjson",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });

        const removeListener = agent.onMessage((event) => {
          try {
            // Only forward events from our message (skip startup/other messages)
            if (event.messageId !== messageId) return;
            res.write(`${JSON.stringify(event)}\n`);
            if (event.type === "done") {
              removeListener();
              res.end();
            }
          } catch {
            removeListener();
          }
        }, sessionName);

        res.on("close", () => {
          removeListener();
        });

        agent.sendMessage(body.content, {
          channel: body.channel,
          sender: body.sender,
          platform: body.platform,
          isDM: body.isDM,
          channelName: body.channelName,
          guildName: body.guildName,
          sessionName,
          messageId,
        });
      } catch {
        res.writeHead(400);
        res.end("Bad Request");
      }
      return;
    }

    res.writeHead(404);
    res.end("Not Found");
  });

  // Clean up batch timers on server close
  server.on("close", () => {
    for (const [, buffer] of batchBuffers) {
      clearInterval(buffer.timer);
    }
    batchBuffers.clear();
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

  return server;
}
