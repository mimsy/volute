import { createServer, type IncomingMessage, type Server } from "node:http";
import { log } from "./logger.js";
import type { VoluteContentPart, VoluteEvent, VoluteRequest } from "./types.js";

export type VoluteAgent = {
  sendMessage: (content: string | VoluteContentPart[], channel?: string, sender?: string) => void;
  onMessage: (listener: (event: VoluteEvent) => void) => () => void;
};

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

export function createVoluteServer(options: {
  agent: VoluteAgent;
  port: number;
  name: string;
  version: string;
}): Server {
  const { agent, port, name, version } = options;

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

        res.writeHead(200, {
          "Content-Type": "application/x-ndjson",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });

        const removeListener = agent.onMessage((event) => {
          try {
            res.write(`${JSON.stringify(event)}\n`);
            if (event.type === "done") {
              removeListener();
              res.end();
            }
          } catch {
            removeListener();
          }
        });

        res.on("close", () => {
          removeListener();
        });

        agent.sendMessage(body.content, body.channel, body.sender);
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

  return server;
}
