import { readFile, realpath, stat } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { Hono } from "hono";
import { findMind, mindDir } from "../../lib/registry.js";
import { readVoluteConfig } from "../../lib/volute-config.js";

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
    const entry = await findMind(name);
    if (!entry) return c.json({ error: "Mind not found" }, 404);

    const dir = mindDir(name);
    const config = readVoluteConfig(dir);
    if (!config?.profile?.avatar) return c.json({ error: "No avatar configured" }, 404);

    const ext = extname(config.profile.avatar).toLowerCase();
    const mime = AVATAR_MIME[ext];
    if (!mime) return c.json({ error: "Invalid avatar extension" }, 400);

    const homeDir = resolve(dir, "home");
    const avatarPath = resolve(homeDir, config.profile.avatar);
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
  });

export default app;
