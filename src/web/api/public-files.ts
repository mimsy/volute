import type { Dirent, Stats } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { Hono } from "hono";
import { findMind, mindDir, voluteHome } from "../../lib/registry.js";

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB

function resolvePublicRoot(name: string): string | null {
  if (name === "_system") return resolve(voluteHome(), "shared");
  if (!findMind(name)) return null;
  return resolve(mindDir(name), "home", "public");
}

function hasDotSegment(relativePath: string): boolean {
  return relativePath.split("/").some((seg) => seg.startsWith("."));
}

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
  ".webp": "image/webp",
};

async function listDir(dirPath: string) {
  let entries: Dirent[];
  try {
    entries = await readdir(dirPath, { withFileTypes: true });
  } catch (err: any) {
    if (err?.code === "ENOENT") return [];
    throw err;
  }
  return entries
    .filter((e) => !e.name.startsWith("."))
    .map((e) => ({
      name: e.name,
      type: e.isDirectory() ? ("directory" as const) : ("file" as const),
    }));
}

const app = new Hono()
  // Directory listing: GET /public/:name/
  .get("/:name/", async (c) => {
    const name = c.req.param("name");
    const publicRoot = resolvePublicRoot(name);
    if (!publicRoot) return c.json({ error: "Not found" }, 404);

    return c.json(await listDir(publicRoot));
  })
  // File serving or subdirectory listing: GET /public/:name/*
  .get("/:name/*", async (c) => {
    const name = c.req.param("name");
    const publicRoot = resolvePublicRoot(name);
    if (!publicRoot) return c.text("Not found", 404);

    const wildcard = c.req.path.replace(`/public/${name}`, "") || "/";
    const relativePath = wildcard.slice(1);
    const requestedPath = resolve(publicRoot, relativePath);

    // Path traversal guard
    if (!requestedPath.startsWith(publicRoot)) return c.text("Forbidden", 403);

    // Block dotfiles and dot-directories
    if (hasDotSegment(relativePath)) return c.text("Forbidden", 403);

    let fileStat: Stats;
    try {
      fileStat = await stat(requestedPath);
    } catch (err: any) {
      if (err?.code === "ENOENT") return c.text("Not found", 404);
      if (err?.code === "EACCES") return c.text("Forbidden", 403);
      return c.text("Internal server error", 500);
    }

    // Directory → return JSON listing if path ends with /
    if (fileStat.isDirectory()) {
      if (wildcard.endsWith("/")) {
        return c.json(await listDir(requestedPath));
      }
      return c.text("Not found", 404);
    }

    if (fileStat.isFile()) {
      if (fileStat.size > MAX_FILE_SIZE) return c.text("File too large", 413);
      const ext = extname(requestedPath);
      const mime = MIME_TYPES[ext] || "application/octet-stream";
      try {
        const body = await readFile(requestedPath);
        return c.body(body, 200, { "Content-Type": mime });
      } catch (err: any) {
        if (err?.code === "ENOENT") return c.text("Not found", 404);
        if (err?.code === "EACCES") return c.text("Forbidden", 403);
        return c.text("Failed to read file", 500);
      }
    }

    return c.text("Not found", 404);
  });

export default app;
