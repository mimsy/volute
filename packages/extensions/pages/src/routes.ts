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

export function createRoutes(ctx: ExtensionContext): Hono {
  return new Hono()
    .get("/", async (c) => {
      const pw = await getPagesWatcher();
      const sites = await pw.getCachedSites();
      const recentPages = await pw.getCachedRecentPages();
      return c.json({ sites, recentPages });
    })
    .get("/feed", async (c) => {
      const pw = await getPagesWatcher();
      let recentPages = await pw.getCachedRecentPages();
      const mind = c.req.query("mind");
      if (mind) recentPages = recentPages.filter((p: any) => p.mind === mind);
      const rawLimit = c.req.query("limit");
      const limit = rawLimit ? parseInt(rawLimit, 10) : 8;
      return c.json(
        recentPages.slice(0, limit).map((p: any) => ({
          id: `page-${p.mind}-${p.file}`,
          title: `${p.mind}/${p.file}`,
          url: p.url ?? `/minds/${p.mind}/pages/${p.file}`,
          date: p.modified,
          author: p.mind,
          bodyHtml: `<p>Page updated</p>`,
          iframeUrl: `/ext/pages/public/${p.mind}/${p.file}`,
          icon: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6"/><path d="M2 8h12M8 2c-2 2-2 10 0 12M8 2c2 2 2 10 0 12"/></svg>',
          color: "purple",
        })),
      );
    })
    .put("/publish/:name", async (c) => {
      const user = ctx.resolveUser(c);
      if (!user) return c.json({ error: "Unauthorized" }, 401);
      const name = c.req.param("name");
      if (user.role !== "admin" && user.username !== name) {
        return c.json({ error: "Forbidden" }, 403);
      }
      const config = ctx.getSystemsConfig();
      if (!config) return c.json({ error: "Not connected to volute.systems" }, 400);
      const body = await c.req.text();
      try {
        const res = await fetch(`${config.apiUrl}/api/pages/publish/${name}`, {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${config.apiKey}`,
          },
          body,
        });
        const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        return c.json(data as Record<string, unknown>, res.status as any);
      } catch (err) {
        return c.json({ error: `Connection failed: ${(err as Error).message}` }, 502);
      }
    })
    .get("/status/:name", async (c) => {
      const user = ctx.resolveUser(c);
      if (!user) return c.json({ error: "Unauthorized" }, 401);
      const name = c.req.param("name");
      if (user.role !== "admin" && user.username !== name) {
        return c.json({ error: "Forbidden" }, 403);
      }
      const config = ctx.getSystemsConfig();
      if (!config) return c.json({ error: "Not connected to volute.systems" }, 400);
      try {
        const res = await fetch(`${config.apiUrl}/api/pages/status/${name}`, {
          headers: { Authorization: `Bearer ${config.apiKey}` },
        });
        const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        return c.json(data as Record<string, unknown>, res.status as any);
      } catch (err) {
        return c.json({ error: `Connection failed: ${(err as Error).message}` }, 502);
      }
    });
}

// Lazy-loaded reference to voluteHome for system pages
let _voluteHome: (() => string) | null = null;
async function getVoluteHome(): Promise<string> {
  if (_voluteHome) return _voluteHome();
  const mod = await import("../../../../src/lib/registry.js");
  _voluteHome = mod.voluteHome;
  return _voluteHome();
}

export function createPublicRoutes(ctx: ExtensionContext): Hono {
  return new Hono().get("/:name/*", async (c) => {
    const name = c.req.param("name");

    let pagesRoot: string;
    if (name === "_system") {
      const home = await getVoluteHome();
      pagesRoot = resolve(home, "shared", "pages");
    } else {
      const mindDirPath = ctx.getMindDir(name);
      if (!mindDirPath) return c.text("Not found", 404);
      pagesRoot = resolve(mindDirPath, "home", "public", "pages");
    }
    const prefix = `/public/${name}`;
    const idx = c.req.path.indexOf(prefix);
    const wildcard = idx >= 0 ? c.req.path.slice(idx + prefix.length) : "/";
    const requestedPath = resolve(pagesRoot, wildcard.slice(1));

    if (requestedPath !== pagesRoot && !requestedPath.startsWith(pagesRoot + "/"))
      return c.text("Forbidden", 403);

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
