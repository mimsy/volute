import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer as createHttpsServer } from "node:https";
import { dirname, extname, resolve } from "node:path";
import type { ServerType } from "@hono/node-server";
import { serve } from "@hono/node-server";
import log from "../lib/util/logger.js";
import app from "./app.js";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

/** Stops accepting new connections; established ones are left to finish. */
export type StopListening = () => void;

/**
 * Build the `stopListening` handle for every listener this daemon opened. With
 * TLS there are two — the public HTTPS one and the internal HTTP one that minds
 * and the CLI talk to — and the daemon previously closed only the first, leaving
 * the port minds actually use bound until the process exited.
 *
 * The daemon calls this at the *end* of `shutdown()`, deliberately: since Node 19
 * `close()` destroys idle keep-alive connections as well as the listening socket,
 * so calling it early would cut off the log/history events minds POST while they
 * shut down rather than letting them drain. `isShuttingDown()` is what makes the
 * outgoing daemon honest in the meantime.
 */
function stopListeningFor(listeners: ServerType[]): StopListening {
  return () => {
    for (const listener of listeners) {
      // close() reports "not running" through its callback rather than throwing;
      // an already-closed listener is not an error worth surfacing at shutdown.
      listener.close(() => {});
    }
  };
}

export async function startServer({
  port,
  hostname = "127.0.0.1",
  tls,
}: {
  port: number;
  hostname?: string;
  tls?: { key: Buffer; cert: Buffer };
}): Promise<{ stopListening: StopListening; internalPort?: number }> {
  // Find built frontend assets
  let assetsDir = "";
  let searchDir = dirname(new URL(import.meta.url).pathname);
  for (let i = 0; i < 5; i++) {
    const candidate = resolve(searchDir, "dist", "web-assets");
    if (existsSync(candidate)) {
      assetsDir = candidate;
      break;
    }
    searchDir = dirname(searchDir);
  }

  if (assetsDir) {
    // Serve static files and SPA fallback
    app.get("*", async (c) => {
      const urlPath = new URL(c.req.url).pathname;
      // Never serve SPA for API or extension routes
      if (urlPath.startsWith("/api/") || urlPath.startsWith("/ext/")) return c.notFound();
      // Try exact file first (with path traversal guard)
      const filePath = resolve(assetsDir, urlPath.slice(1));
      if (!filePath.startsWith(assetsDir)) return c.text("Forbidden", 403);
      const s = await stat(filePath).catch(() => null);
      if (s?.isFile()) {
        const ext = extname(filePath);
        const mime = MIME_TYPES[ext] || "application/octet-stream";
        const body = await readFile(filePath);
        const basename = filePath.slice(filePath.lastIndexOf("/") + 1);
        const nameWithoutExt = basename.slice(0, basename.lastIndexOf("."));
        const isHashed = /[-.][\da-f]{8,}$/.test(nameWithoutExt);
        const cacheControl = isHashed ? "public, max-age=31536000, immutable" : "no-cache";
        return c.body(body, 200, { "Content-Type": mime, "Cache-Control": cacheControl });
      }
      // SPA fallback
      const indexPath = resolve(assetsDir, "index.html");
      const indexStat = await stat(indexPath).catch(() => null);
      if (indexStat?.isFile()) {
        const body = await readFile(indexPath, "utf-8");
        return c.html(body, 200, { "Cache-Control": "no-cache" });
      }
      return c.text("Not found", 404);
    });
  }

  // When TLS is enabled, HTTPS is the primary listener on the user-facing port.
  // A secondary HTTP listener on localhost handles internal CLI/mind communication.
  if (tls) {
    const server = serve({
      fetch: app.fetch,
      port,
      hostname,
      createServer: createHttpsServer,
      serverOptions: { key: tls.key, cert: tls.cert },
    });
    await new Promise<void>((resolve, reject) => {
      server.on("listening", () => {
        log.info("Volute UI running (https)", { hostname, port });
        resolve();
      });
      server.on("error", (err: NodeJS.ErrnoException) => {
        reject(err);
      });
    });

    const internalPort = port + 1;
    const internalServer = serve({ fetch: app.fetch, port: internalPort, hostname: "127.0.0.1" });
    await new Promise<void>((resolve, reject) => {
      internalServer.on("listening", () => {
        log.info("Volute API running (http, internal)", {
          hostname: "127.0.0.1",
          port: internalPort,
        });
        resolve();
      });
      internalServer.on("error", (err: NodeJS.ErrnoException) => {
        reject(err);
      });
    });

    return { stopListening: stopListeningFor([server, internalServer]), internalPort };
  }

  // No TLS: single HTTP listener
  const server = serve({ fetch: app.fetch, port, hostname });

  await new Promise<void>((resolve, reject) => {
    server.on("listening", () => {
      log.info("Volute API running (http)", { hostname, port });
      resolve();
    });
    server.on("error", (err: NodeJS.ErrnoException) => {
      reject(err);
    });
  });

  return { stopListening: stopListeningFor([server]) };
}
