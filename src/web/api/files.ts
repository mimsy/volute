import { existsSync } from "node:fs";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { Hono } from "hono";
import { findMind, mindDir } from "../../lib/registry.js";
import { readVoluteConfig } from "../../lib/volute-config.js";

const ALLOWED_FILES = new Set(["SOUL.md", "MEMORY.md", "CLAUDE.md", "VOLUTE.md"]);

const AVATAR_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

const MAX_AVATAR_SIZE = 2 * 1024 * 1024; // 2MB

const app = new Hono()
  // Serve avatar image
  .get("/:name/avatar", async (c) => {
    const name = c.req.param("name");
    const entry = findMind(name);
    if (!entry) return c.json({ error: "Mind not found" }, 404);

    const dir = mindDir(name);
    const config = readVoluteConfig(dir);
    if (!config?.avatar) return c.json({ error: "No avatar configured" }, 404);

    const ext = extname(config.avatar).toLowerCase();
    const mime = AVATAR_MIME[ext];
    if (!mime) return c.json({ error: "Invalid avatar extension" }, 400);

    const homeDir = resolve(dir, "home");
    const avatarPath = resolve(homeDir, config.avatar);
    if (!avatarPath.startsWith(`${homeDir}/`)) return c.json({ error: "Invalid avatar path" }, 400);

    // Resolve symlinks and re-check containment
    let realAvatarPath: string;
    try {
      const realHome = await realpath(homeDir);
      realAvatarPath = await realpath(avatarPath);
      if (!realAvatarPath.startsWith(`${realHome}/`))
        return c.json({ error: "Invalid avatar path" }, 400);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT")
        return c.json({ error: "Avatar file not found" }, 404);
      return c.json({ error: "Failed to resolve avatar path" }, 500);
    }

    try {
      const fileStat = await stat(realAvatarPath);
      if (fileStat.size > MAX_AVATAR_SIZE) return c.json({ error: "Avatar file too large" }, 400);
      const body = await readFile(realAvatarPath);
      return c.body(body, 200, {
        "Content-Type": mime,
        "Cache-Control": "public, max-age=300",
      });
    } catch {
      return c.json({ error: "Failed to read avatar file" }, 500);
    }
  })
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
