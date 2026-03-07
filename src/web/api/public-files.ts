import { readdir, readFile, stat } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { Hono } from "hono";
import { findMind, mindDir } from "../../lib/registry.js";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain",
  ".xml": "application/xml",
  ".md": "text/markdown",
};

const app = new Hono()
  // Directory listing: GET /public/:name/
  .get("/:name/", async (c) => {
    const name = c.req.param("name");
    if (!findMind(name)) return c.json({ error: "Not found" }, 404);

    const publicRoot = resolve(mindDir(name), "home", "public");
    const entries = await readdir(publicRoot, { withFileTypes: true }).catch(() => []);

    const items = entries
      .filter((e) => !e.name.startsWith("."))
      .map((e) => ({
        name: e.name,
        type: e.isDirectory() ? "directory" : "file",
      }));

    return c.json(items);
  })
  // File serving: GET /public/:name/*
  .get("/:name/*", async (c) => {
    const name = c.req.param("name");
    if (!findMind(name)) return c.text("Not found", 404);

    const publicRoot = resolve(mindDir(name), "home", "public");
    const wildcard = c.req.path.replace(`/public/${name}`, "") || "/";
    const requestedPath = resolve(publicRoot, wildcard.slice(1));

    // Path traversal guard
    if (!requestedPath.startsWith(publicRoot)) return c.text("Forbidden", 403);

    const fileStat = await stat(requestedPath).catch(() => null);

    if (fileStat?.isDirectory()) return c.text("Not found", 404);

    if (fileStat?.isFile()) {
      const ext = extname(requestedPath);
      const mime = MIME_TYPES[ext] || "application/octet-stream";
      const body = await readFile(requestedPath);
      return c.body(body, 200, { "Content-Type": mime });
    }

    return c.text("Not found", 404);
  });

export default app;
