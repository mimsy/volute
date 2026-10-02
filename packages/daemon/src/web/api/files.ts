import type { Dirent } from "node:fs";
import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";
import { Hono } from "hono";
import { syncMindProfile } from "../../lib/auth.js";
import { broadcast } from "../../lib/events/activity-events.js";
import { mindFileOwner } from "../../lib/mind/isolation.js";
import {
  MindFileTooLargeError,
  readMindFileBytes,
  removeMindFile,
  replaceMindFile,
} from "../../lib/mind/mind-file-write.js";
import { findMind, getBaseName, mindDir } from "../../lib/mind/registry.js";
import {
  type MindProfile,
  readVoluteConfig,
  UnparseableConfigError,
  updateMindVoluteConfig,
} from "../../lib/mind/volute-config.js";
import { normalizeAvatar } from "../../lib/util/avatar-image.js";
import { fileEtag, isNotModified } from "../../lib/util/http-cache.js";
import {
  PathTraversalError,
  resolveRealWithinBase,
  safeResolveWithinBase,
} from "../../lib/util/paths.js";
import { type AuthEnv, requireAdmin, requireSelf } from "../middleware/auth.js";

const AVATAR_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/**
 * A read the mind-file helpers refused — a link, FIFO or hard link where a file should be,
 * a path out of the tree, a file over its cap — as opposed to an I/O failure (those carry
 * an errno code).
 */
function isReadRefusal(err: unknown): boolean {
  return (
    err instanceof PathTraversalError ||
    err instanceof MindFileTooLargeError ||
    (err instanceof Error && (err as NodeJS.ErrnoException).code === undefined)
  );
}

const MAX_AVATAR_SIZE = 2 * 1024 * 1024; // 2MB
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB

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

    // Downscale + re-encode as webp; fall back to original bytes if sharp is unavailable
    let buffer: Buffer = Buffer.from(await file.arrayBuffer());
    let finalExt = ext;
    const normalized = await normalizeAvatar(buffer);
    if (normalized) {
      buffer = normalized.buffer;
      finalExt = normalized.ext;
    }

    const dir = entry.dir ?? mindDir(name);
    if (!existsSync(resolve(dir, "home"))) {
      return c.json({ error: "Mind home directory not found" }, 404);
    }
    const filename = `avatar${finalExt}`;
    // The daemon writes here with its own privileges (root under user isolation), in a
    // tree the mind controls: the mind-file helpers refuse a link or FIFO it planted
    // anywhere on the way, and hand what they create to the mind (#1072).
    const owner = await mindFileOwner(await getBaseName(name));

    // Delete old avatar if different extension. The stored avatar value is
    // mind-controllable (via volute.json / the profile PATCH), so it is contained
    // like any other path — never let it delete a file outside the mind's home.
    const config = readVoluteConfig(dir);
    // Refuse before touching any file: an unparseable volute.json can't record the new
    // avatar, and deleting the old one first would leave the mind with neither.
    if (!config && existsSync(resolve(dir, "home/.config/volute.json"))) {
      throw new UnparseableConfigError(
        "home/.config/volute.json is unparseable — fix or remove it; not modifying it",
      );
    }
    const oldAvatar = config?.profile?.avatar;
    const oldAvatarPath = oldAvatar && safeResolveWithinBase(resolve(dir, "home"), oldAvatar);
    if (oldAvatarPath && oldAvatar !== filename) {
      await removeMindFile(dir, relative(dir, oldAvatarPath), { owner }).catch(() => {});
    }

    try {
      // Replace rather than overwrite: a link the mind planted at the name is swapped
      // out, never written through.
      await replaceMindFile(dir, `home/${filename}`, buffer, { owner });
    } catch (err) {
      if (err instanceof PathTraversalError) {
        return c.json({ error: "Mind home directory not found" }, 404);
      }
      return c.json({ error: "Failed to write avatar" }, 500);
    }

    // Update volute.json
    let profile: MindProfile = {};
    await updateMindVoluteConfig(name, dir, (config) => {
      profile = { ...config.profile, avatar: filename };
      config.profile = profile;
      return config;
    });

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

    // The stored avatar value is mind-controllable, so contain it — symlinks included.
    const homeDir = resolve(dir, "home");
    let realAvatarPath: string;
    try {
      realAvatarPath = await resolveRealWithinBase(homeDir, config.profile.avatar);
    } catch (err: unknown) {
      if (err instanceof PathTraversalError) return c.json({ error: "Invalid avatar path" }, 400);
      if ((err as NodeJS.ErrnoException).code === "ENOENT")
        return c.json({ error: "Avatar file not found" }, 404);
      return c.json({ error: "Failed to resolve avatar path" }, 500);
    }

    try {
      const fileStat = await stat(realAvatarPath);
      // An avatar must be a regular file. The containment helper permits
      // target === base, so a mind could point `avatar` at a *.png symlink to its
      // own home/ and turn this into a 500 on EISDIR; this keeps the 400 the old
      // strict-prefix check gave, and also covers fifos and sockets. Checked here
      // rather than in the route's own realpath pair — that pair is what this
      // change exists to delete.
      if (!fileStat.isFile()) return c.json({ error: "Invalid avatar path" }, 400);
      // A hard link inside home/ realpaths inside it too, and would serve (on this
      // public route) whatever file elsewhere it links to.
      if (fileStat.nlink !== 1) return c.json({ error: "Invalid avatar path" }, 400);
      if (fileStat.size > MAX_AVATAR_SIZE) return c.json({ error: "Avatar file too large" }, 400);
      const etag = fileEtag(fileStat);
      const headers = {
        "Content-Type": mime,
        "Cache-Control": "public, max-age=300",
        ETag: etag,
      };
      if (isNotModified(c, etag)) return c.body(null, 304, headers);
      // The checks above vet a path the mind can swap before the read; the read itself
      // goes through the mind-file helpers, which refuse a link or FIFO at the name.
      const avatarRel = relative(dir, resolve(homeDir, config.profile.avatar));
      const body = await readMindFileBytes(dir, avatarRel, {
        owner: await mindFileOwner(await getBaseName(name)),
        maxBytes: MAX_AVATAR_SIZE,
      });
      if (!body) return c.json({ error: "Avatar file not found" }, 404);
      return c.body(body as Uint8Array<ArrayBuffer>, 200, headers);
    } catch (err) {
      if (isReadRefusal(err)) return c.json({ error: "Invalid avatar path" }, 400);
      return c.json({ error: "Failed to read avatar file" }, 500);
    }
  })
  // Browse mind home directory (admin-only)
  .get("/:name/files/", requireAdmin, async (c) => {
    const name = c.req.param("name");
    const entry = await findMind(name);
    if (!entry) return c.json({ error: "Mind not found" }, 404);

    const homeDir = resolve(entry.dir ?? mindDir(name), "home");
    let entries: Dirent[];
    try {
      entries = await readdir(homeDir, { withFileTypes: true });
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT")
        return c.json({ error: "Mind home directory not found" }, 404);
      return c.json({ error: "Failed to read directory" }, 500);
    }
    const items = entries
      .filter((e) => !e.name.startsWith("."))
      .map((e) => ({ name: e.name, type: e.isDirectory() ? "directory" : ("file" as const) }));
    return c.json(items);
  })
  .get("/:name/files/*", requireAdmin, async (c) => {
    const name = c.req.param("name");
    const entry = await findMind(name);
    if (!entry) return c.json({ error: "Mind not found" }, 404);

    const dir = entry.dir ?? mindDir(name);
    const homeDir = resolve(dir, "home");
    const wildcard = c.req.path.replace(new RegExp(`^.*/minds/${name}/files`), "") || "/";
    const relativePath = wildcard.slice(1);

    // Hidden-file policy, not containment: dotfiles are filtered out of the
    // directory listings, so they aren't individually fetchable either.
    if (relativePath.split("/").some((seg) => seg.startsWith("."))) return c.text("Forbidden", 403);

    // Containment, symlinks included: a symlink under home/ cannot point out of it.
    let resolvedPath: string;
    try {
      resolvedPath = await resolveRealWithinBase(homeDir, relativePath);
    } catch (err: unknown) {
      if (err instanceof PathTraversalError) return c.text("Forbidden", 403);
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return c.text("Not found", 404);
      return c.text("Internal server error", 500);
    }

    let fileStat: Awaited<ReturnType<typeof stat>>;
    try {
      fileStat = await stat(resolvedPath);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return c.text("Not found", 404);
      console.error(`[files] stat failed for ${resolvedPath}:`, err);
      return c.text("Internal server error", 500);
    }

    if (fileStat.isDirectory()) {
      // Redirect to trailing slash if missing, otherwise list contents
      if (!c.req.path.endsWith("/")) return c.redirect(`${c.req.path}/`);
      const dirEntries = await readdir(resolvedPath, { withFileTypes: true }).catch(
        () => [] as Dirent[],
      );
      const items = dirEntries
        .filter((e) => !e.name.startsWith("."))
        .map((e) => ({ name: e.name, type: e.isDirectory() ? "directory" : ("file" as const) }));
      return c.json(items);
    }

    if (fileStat.size > MAX_FILE_SIZE) return c.text("File too large", 413);

    const mime = MIME_TYPES[extname(resolvedPath).toLowerCase()] || "application/octet-stream";
    const etag = fileEtag(fileStat);
    const headers = { "Content-Type": mime, "Cache-Control": "no-cache", ETag: etag };
    if (isNotModified(c, etag)) return c.body(null, 304, headers);
    // As for the avatar: read through the helpers, not the path vetted above.
    let body: Buffer | null;
    try {
      body = await readMindFileBytes(dir, join("home", relativePath), {
        owner: await mindFileOwner(await getBaseName(name)),
        maxBytes: MAX_FILE_SIZE,
      });
    } catch (err) {
      if (isReadRefusal(err)) return c.text("Forbidden", 403);
      console.error(`[files] read failed for ${resolvedPath}:`, err);
      return c.text("Internal server error", 500);
    }
    if (!body) return c.text("Not found", 404);
    return c.body(body as Uint8Array<ArrayBuffer>, 200, headers);
  });

export default app;
