import { readFile, stat } from "node:fs/promises";
import { extname, resolve } from "node:path";
import type { ExtensionContext } from "@volute/extension-sdk";
import { Hono } from "hono";

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

export function createRoutes(_ctx: ExtensionContext): Hono {
  // Authenticated API routes — sites listing is handled by the core pages-watcher for now
  return new Hono();
}

export function createPublicRoutes(ctx: ExtensionContext): Hono {
  return new Hono().get("/:name/*", async (c) => {
    const name = c.req.param("name");

    const mindDirPath = ctx.getMindDir(name);
    if (!mindDirPath) return c.text("Not found", 404);

    const pagesRoot = resolve(mindDirPath, "home", "public", "pages");
    const wildcard = c.req.path.replace(new RegExp(`^.*/public/${name}`), "") || "/";
    const requestedPath = resolve(pagesRoot, wildcard.slice(1));

    if (!requestedPath.startsWith(pagesRoot)) return c.text("Forbidden", 403);

    let fileStat = await stat(requestedPath).catch(() => null);

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
}
