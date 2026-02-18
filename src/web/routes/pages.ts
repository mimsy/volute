import { readFile, stat } from "node:fs/promises";
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
};

const app = new Hono().get("/:name/*", async (c) => {
  const name = c.req.param("name");

  if (!findMind(name)) return c.text("Not found", 404);

  const pagesRoot = resolve(mindDir(name), "home", "pages");
  const wildcard = c.req.path.replace(`/pages/${name}`, "") || "/";
  const requestedPath = resolve(pagesRoot, wildcard.slice(1));

  // Path traversal guard
  if (!requestedPath.startsWith(pagesRoot)) return c.text("Forbidden", 403);

  // Try exact file
  let fileStat = await stat(requestedPath).catch(() => null);

  // Directory → try index.html
  if (fileStat?.isDirectory()) {
    const indexPath = resolve(requestedPath, "index.html");
    fileStat = await stat(indexPath).catch(() => null);
    if (fileStat?.isFile()) {
      const body = await readFile(indexPath);
      return c.body(body, 200, { "Content-Type": "text/html" });
    }
    return c.text("Not found", 404);
  }

  if (fileStat?.isFile()) {
    const ext = extname(requestedPath);
    const mime = MIME_TYPES[ext] || "application/octet-stream";
    const body = await readFile(requestedPath);
    return c.body(body, 200, { "Content-Type": mime });
  }

  return c.text("Not found", 404);
});

export default app;
