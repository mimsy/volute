import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { csrf } from "hono/csrf";
import log from "../lib/logger.js";
import { authMiddleware } from "./middleware/auth.js";
import agents from "./routes/agents.js";
import auth from "./routes/auth.js";
import chat from "./routes/chat.js";
import conversations from "./routes/conversations.js";
import files from "./routes/files.js";
import logs from "./routes/logs.js";
import variants from "./routes/variants.js";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

export function startServer({ port }: { port: number }) {
  const app = new Hono();

  // Global error handler
  app.onError((err, c) => {
    log.error("Unhandled error", {
      path: c.req.path,
      method: c.req.method,
      error: err.message,
    });
    return c.json({ error: "Internal server error" }, 500);
  });

  app.notFound((c) => {
    return c.json({ error: "Not found" }, 404);
  });

  // Request logging
  app.use("*", async (c, next) => {
    const start = Date.now();
    await next();
    const duration = Date.now() - start;
    log.info("request", {
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      duration,
    });
  });

  // CSRF protection for API mutation requests
  app.use("/api/*", csrf());

  // Auth routes (unprotected)
  app.route("/api/auth", auth);

  // Protected API routes
  app.use("/api/agents/*", authMiddleware);
  app.route("/api/agents", agents);
  app.route("/api/agents", chat);
  app.route("/api/agents", logs);
  app.route("/api/agents", variants);
  app.route("/api/agents", files);
  app.route("/api/agents", conversations);

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

  log.info("Molt UI running", { port });

  serve({ fetch: app.fetch, port });
}
