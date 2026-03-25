import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { Hono } from "hono";
import { syncMindProfile } from "../../lib/auth.js";
import { broadcast } from "../../lib/events/activity-events.js";
import { findMind, mindDir } from "../../lib/registry.js";
import { readVoluteConfig, writeVoluteConfig } from "../../lib/volute-config.js";
import { type AuthEnv, requireAdmin, requireSelf } from "../middleware/auth.js";

const AVATAR_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

const MAX_AVATAR_SIZE = 2 * 1024 * 1024; // 2MB

const app = new Hono<AuthEnv>()
  // Upload avatar image
  .post("/:name/avatar", requireSelf(), async (c) => {
    const name = c.req.param("name");
    const entry = await findMind(name);
    if (!entry) return c.json({ error: "Mind not found" }, 404);

    const body = await c.req.parseBody();
    const file = body.file;
    if (!(file instanceof File)) {
      return c.json({ error: "No file uploaded" }, 400);
    }
    if (file.size > MAX_AVATAR_SIZE) {
      return c.json({ error: "File too large (max 2MB)" }, 400);
    }
    const ext = extname(file.name).toLowerCase();
    if (!AVATAR_MIME[ext]) {
      return c.json({ error: "Invalid file type (png, jpg, gif, webp only)" }, 400);
    }

    const dir = entry.dir ?? mindDir(name);
    const homeDir = resolve(dir, "home");
    const filename = `avatar${ext}`;
    const avatarPath = resolve(homeDir, filename);

    // Delete old avatar if different extension
    const config = readVoluteConfig(dir) ?? {};
    const oldAvatar = config.profile?.avatar;
    if (oldAvatar && oldAvatar !== filename) {
      rmSync(resolve(homeDir, oldAvatar), { force: true });
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    mkdirSync(homeDir, { recursive: true });
    writeFileSync(avatarPath, buffer);

    // Update volute.json
    const profile = config.profile ?? {};
    profile.avatar = filename;
    config.profile = profile;
    writeVoluteConfig(dir, config);

    // Sync to users table and broadcast
    await syncMindProfile(name, profile);
    broadcast({ type: "profile_updated", mind: name, summary: `${name} avatar updated` });

    return c.json({ ok: true, avatar: filename });
  })
  // Serve avatar image
  .get("/:name/avatar", async (c) => {
    const name = c.req.param("name");
    const entry = await findMind(name);
    if (!entry) return c.json({ error: "Mind not found" }, 404);

    const dir = entry.dir ?? mindDir(name);
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
  })
  // Browse mind home directory (admin-only)
  .get("/:name/files/", requireAdmin, async (c) => {
    const name = c.req.param("name");
    const entry = await findMind(name);
    if (!entry) return c.json({ error: "Mind not found" }, 404);

    const homeDir = resolve(entry.dir ?? mindDir(name), "home");
    const entries = await readdir(homeDir, { withFileTypes: true }).catch(() => []);
    const items = entries
      .filter((e) => !e.name.startsWith("."))
      .map((e) => ({ name: e.name, type: e.isDirectory() ? "directory" : ("file" as const) }));
    return c.json(items);
  })
  .get("/:name/files/*", requireAdmin, async (c) => {
    const name = c.req.param("name");
    const entry = await findMind(name);
    if (!entry) return c.json({ error: "Mind not found" }, 404);

    const homeDir = resolve(entry.dir ?? mindDir(name), "home");
    const wildcard = c.req.path.replace(new RegExp(`^.*/minds/${name}/files`), "") || "/";
    const relativePath = wildcard.slice(1);
    const requestedPath = resolve(homeDir, relativePath);

    // Path traversal protection
    if (requestedPath !== homeDir && !requestedPath.startsWith(`${homeDir}/`))
      return c.text("Forbidden", 403);
    if (relativePath.split("/").some((seg) => seg.startsWith("."))) return c.text("Forbidden", 403);

    let fileStat: Awaited<ReturnType<typeof stat>>;
    try {
      fileStat = await stat(requestedPath);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return c.text("Not found", 404);
      return c.text("Internal server error", 500);
    }

    if (fileStat.isDirectory()) {
      // Redirect to trailing slash if missing, otherwise list contents
      if (!c.req.path.endsWith("/")) return c.redirect(c.req.path + "/");
      const dirEntries = await readdir(requestedPath, { withFileTypes: true }).catch(() => []);
      const items = dirEntries
        .filter((e) => !e.name.startsWith("."))
        .map((e) => ({ name: e.name, type: e.isDirectory() ? "directory" : ("file" as const) }));
      return c.json(items);
    }

    const MIME_TYPES: Record<string, string> = {
      ".html": "text/html",
      ".css": "text/css",
      ".js": "application/javascript",
      ".json": "application/json",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".webp": "image/webp",
      ".txt": "text/plain",
      ".md": "text/markdown",
      ".xml": "application/xml",
      ".woff": "font/woff",
      ".woff2": "font/woff2",
    };

    const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB
    if (fileStat.size > MAX_FILE_SIZE) return c.text("File too large", 413);

    const body = await readFile(requestedPath);
    const mime = MIME_TYPES[extname(requestedPath).toLowerCase()] || "application/octet-stream";
    return c.body(body, 200, { "Content-Type": mime });
  });

export default app;
