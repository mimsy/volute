import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { existsSync, readFileSync, statSync } from "fs";
import { resolve, dirname, extname } from "path";
import agents from "./routes/agents.js";
import chat from "./routes/chat.js";
import logs from "./routes/logs.js";
import variants from "./routes/variants.js";
import files from "./routes/files.js";
import auth from "./routes/auth.js";
import conversations from "./routes/conversations.js";
import { authMiddleware } from "./middleware/auth.js";

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
    app.get("*", (c) => {
      const urlPath = new URL(c.req.url).pathname;
      // Try exact file first (with path traversal guard)
      const filePath = resolve(assetsDir, urlPath.slice(1));
      if (!filePath.startsWith(assetsDir)) return c.text("Forbidden", 403);
      if (existsSync(filePath) && statSync(filePath).isFile()) {
        const ext = extname(filePath);
        const mime = MIME_TYPES[ext] || "application/octet-stream";
        const body = readFileSync(filePath);
        return c.body(body, 200, { "Content-Type": mime });
      }
      // SPA fallback
      const indexPath = resolve(assetsDir, "index.html");
      if (existsSync(indexPath)) {
        const body = readFileSync(indexPath, "utf-8");
        return c.html(body);
      }
      return c.text("Not found", 404);
    });
  }

  console.log(`Molt UI running at http://localhost:${port}`);

  serve({ fetch: app.fetch, port });
}
