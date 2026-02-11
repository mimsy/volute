import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import type { ServerType } from "@hono/node-server";
import { serve } from "@hono/node-server";
import log from "../lib/logger.js";
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

export async function startServer({
  port,
  hostname = "127.0.0.1",
}: {
  port: number;
  hostname?: string;
}): Promise<ServerType> {
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
      // Never serve SPA for API routes
      if (urlPath.startsWith("/api/")) return c.notFound();
      // Try exact file first (with path traversal guard)
      const filePath = resolve(assetsDir, urlPath.slice(1));
      if (!filePath.startsWith(assetsDir)) return c.text("Forbidden", 403);
      const s = await stat(filePath).catch(() => null);
      if (s?.isFile()) {
        const ext = extname(filePath);
        const mime = MIME_TYPES[ext] || "application/octet-stream";
        const body = await readFile(filePath);
        return c.body(body, 200, { "Content-Type": mime });
      }
      // SPA fallback
      const indexPath = resolve(assetsDir, "index.html");
      const indexStat = await stat(indexPath).catch(() => null);
      if (indexStat?.isFile()) {
        const body = await readFile(indexPath, "utf-8");
        return c.html(body);
      }
      return c.text("Not found", 404);
    });
  }

  const server = serve({ fetch: app.fetch, port, hostname });

  // Wait for the server to start listening (or fail with EADDRINUSE)
  await new Promise<void>((resolve, reject) => {
    server.on("listening", () => {
      log.info("Volute UI running", { hostname, port });
      resolve();
    });
    server.on("error", (err: NodeJS.ErrnoException) => {
      reject(err);
    });
  });

  return server;
}
