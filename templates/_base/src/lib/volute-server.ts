import { createServer, type IncomingMessage, type Server } from "node:http";
import { log } from "./logger.js";
import type { Router } from "./router.js";
import type { VoluteRequest } from "./types.js";

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

export function createVoluteServer(options: {
  router: Router;
  port: number;
  name: string;
  version: string;
}): Server {
  const { router, port, name, version } = options;

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

        let usage: { input_tokens: number; output_tokens: number } | undefined;
        let done = false;

        const { unsubscribe } = router.route(body.content, body, (event) => {
          if (event.type === "usage") {
            usage = { input_tokens: event.input_tokens, output_tokens: event.output_tokens };
          }
          if (event.type === "done") {
            done = true;
            clearTimeout(timeout);
            const response: { ok: true; usage?: { input_tokens: number; output_tokens: number } } =
              { ok: true };
            if (usage) response.usage = usage;
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(response));
          }
        });

        const timeout = setTimeout(
          () => {
            if (!done) {
              done = true;
              unsubscribe();
              res.writeHead(504, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ ok: false, error: "Agent processing timed out" }));
            }
          },
          5 * 60 * 1000,
        );

        res.on("close", () => {
          clearTimeout(timeout);
          if (!done) unsubscribe();
        });
      } catch (err) {
        if (err instanceof SyntaxError) {
          res.writeHead(400);
          res.end("Bad Request");
        } else {
          log("server", "error handling /message:", err);
          res.writeHead(500);
          res.end("Internal Server Error");
        }
      }
      return;
    }

    res.writeHead(404);
    res.end("Not Found");
  });

  server.on("close", () => router.close());

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
