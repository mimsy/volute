import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Hono } from "hono";
import { findMind, mindDir } from "../../lib/registry.js";

const ALLOWED_FILES = new Set(["SOUL.md", "MEMORY.md", "CLAUDE.md", "VOLUTE.md"]);

const app = new Hono()
  // List markdown files in home/
  .get("/:name/files", async (c) => {
    const name = c.req.param("name");
    const entry = findMind(name);
    if (!entry) return c.json({ error: "Mind not found" }, 404);

    const dir = mindDir(name);
    const homeDir = resolve(dir, "home");
    if (!existsSync(homeDir)) return c.json({ error: "Home directory missing" }, 404);

    const allFiles = await readdir(homeDir);
    const files = allFiles.filter((f) => f.endsWith(".md") && ALLOWED_FILES.has(f));

    return c.json(files);
  })
  // Read a file
  .get("/:name/files/:filename", async (c) => {
    const name = c.req.param("name");
    const filename = c.req.param("filename");

    if (!ALLOWED_FILES.has(filename)) {
      return c.json({ error: "File not allowed" }, 403);
    }

    const entry = findMind(name);
    if (!entry) return c.json({ error: "Mind not found" }, 404);

    const dir = mindDir(name);
    const filePath = resolve(dir, "home", filename);

    if (!existsSync(filePath)) {
      return c.json({ error: "File not found" }, 404);
    }

    const content = await readFile(filePath, "utf-8");
    return c.json({ filename, content });
  });

export default app;
