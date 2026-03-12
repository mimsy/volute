import { readFile, stat } from "node:fs/promises";
import { extname, resolve } from "node:path";
import type { ExtensionContext } from "@volute/extensions";
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

// Lazy-loaded reference to core pages-watcher (available in daemon process)
let _pagesWatcher: {
  getCachedSites: () => Promise<any[]>;
  getCachedRecentPages: () => Promise<any[]>;
} | null = null;

async function getPagesWatcher() {
  if (_pagesWatcher) return _pagesWatcher;
  // Built-in extension: import from core at runtime (bundled by tsup)
  const mod = await import("../../../../src/lib/pages-watcher.js");
  _pagesWatcher = mod;
  return _pagesWatcher;
}

export function createRoutes(_ctx: ExtensionContext): Hono {
  return new Hono()
    .get("/", async (c) => {
      const pw = await getPagesWatcher();
      const sites = await pw.getCachedSites();
      const recentPages = await pw.getCachedRecentPages();
      return c.json({ sites, recentPages });
    })
    .get("/feed", async (c) => {
      const pw = await getPagesWatcher();
      const recentPages = await pw.getCachedRecentPages();
      const rawLimit = c.req.query("limit");
      const limit = rawLimit ? parseInt(rawLimit, 10) : 8;
      return c.json(
        recentPages.slice(0, limit).map((p: any) => ({
          id: `page-${p.mind}-${p.file}`,
          title: `${p.mind}/${p.file}`,
          url: `/pages/${p.mind}/${p.file}`,
          date: p.modified,
          author: p.mind,
          bodyHtml: `<p>Page updated</p>`,
        })),
      );
    });
}

export function createPublicRoutes(ctx: ExtensionContext): Hono {
  return new Hono().get("/:name/*", async (c) => {
    const name = c.req.param("name");

    const mindDirPath = ctx.getMindDir(name);
    if (!mindDirPath) return c.text("Not found", 404);

    const pagesRoot = resolve(mindDirPath, "home", "public", "pages");
    const prefix = `/public/${name}`;
    const idx = c.req.path.indexOf(prefix);
    const wildcard = idx >= 0 ? c.req.path.slice(idx + prefix.length) : "/";
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
