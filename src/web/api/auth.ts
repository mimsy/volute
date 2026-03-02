import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import {
  approveUser,
  changePassword,
  createUser,
  getOrCreateMindUser,
  getUser,
  getUserByUsername,
  listPendingUsers,
  listUsers,
  listUsersByType,
  updateUserProfile,
  verifyUser,
} from "../../lib/auth.js";
import { readRegistry, voluteHome } from "../../lib/registry.js";
import {
  type AuthEnv,
  authMiddleware,
  createSession,
  deleteSession,
  getSessionUserId,
  invalidateSessionCache,
} from "../middleware/auth.js";

const credentialsSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(1),
});

const profileSchema = z.object({
  display_name: z.string().max(100).nullable().optional(),
  description: z.string().max(500).nullable().optional(),
});

const AVATAR_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

const MAX_AVATAR_SIZE = 2 * 1024 * 1024; // 2MB

function avatarsDir(): string {
  return resolve(voluteHome(), "avatars");
}

const authenticated = new Hono<AuthEnv>()
  .use(authMiddleware)
  .post("/change-password", zValidator("json", changePasswordSchema), async (c) => {
    const user = c.get("user");
    const { currentPassword, newPassword } = c.req.valid("json");
    const ok = await changePassword(user.id, currentPassword, newPassword);
    if (!ok) return c.json({ error: "Current password is incorrect" }, 400);
    return c.json({ ok: true });
  })
  .put("/profile", zValidator("json", profileSchema), async (c) => {
    const user = c.get("user");
    const body = c.req.valid("json");
    await updateUserProfile(user.id, body);
    // Invalidate session cache so updated profile is picked up
    const sessionId = getCookie(c, "volute_session");
    if (sessionId) invalidateSessionCache(sessionId);
    return c.json({ ok: true });
  })
  .post("/avatar", async (c) => {
    const user = c.get("user");
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

    const dir = avatarsDir();
    mkdirSync(dir, { recursive: true });

    // Delete old avatar if exists
    if (user.avatar) {
      const oldPath = resolve(dir, user.avatar);
      rmSync(oldPath, { force: true });
    }

    const filename = `avatar-${user.id}${ext}`;
    const buffer = Buffer.from(await file.arrayBuffer());
    writeFileSync(resolve(dir, filename), buffer);

    await updateUserProfile(user.id, { avatar: filename });
    const sessionId = getCookie(c, "volute_session");
    if (sessionId) invalidateSessionCache(sessionId);
    return c.json({ ok: true, avatar: filename });
  })
  .delete("/avatar", async (c) => {
    const user = c.get("user");
    if (user.avatar) {
      const path = resolve(avatarsDir(), user.avatar);
      rmSync(path, { force: true });
    }
    await updateUserProfile(user.id, { avatar: null });
    const sessionId = getCookie(c, "volute_session");
    if (sessionId) invalidateSessionCache(sessionId);
    return c.json({ ok: true });
  });

const admin = new Hono<AuthEnv>()
  .use(authMiddleware)
  .get("/users", async (c) => {
    const user = c.get("user");
    if (user.role !== "admin") return c.json({ error: "Forbidden" }, 403);

    // Ensure all registered minds have user records
    const minds = readRegistry();
    for (const mind of minds) {
      await getOrCreateMindUser(mind.name);
    }

    const type = c.req.query("type");
    if (type === "brain" || type === "mind") {
      return c.json(await listUsersByType(type));
    }
    return c.json(await listUsers());
  })
  .get("/users/pending", async (c) => {
    const user = c.get("user");
    if (user.role !== "admin") return c.json({ error: "Forbidden" }, 403);
    return c.json(await listPendingUsers());
  })
  .post("/users/:id/approve", async (c) => {
    const user = c.get("user");
    if (user.role !== "admin") return c.json({ error: "Forbidden" }, 403);
    const id = parseInt(c.req.param("id"), 10);
    await approveUser(id);
    return c.json({ ok: true });
  });

const app = new Hono()
  .post("/register", zValidator("json", credentialsSchema), async (c) => {
    const { username, password } = c.req.valid("json");

    const existing = await getUserByUsername(username);
    if (existing) {
      return c.json({ error: "Username already taken" }, 409);
    }

    const user = await createUser(username, password);

    if (user.role === "admin") {
      // Auto-login first user
      const sessionId = await createSession(user.id);
      setCookie(c, "volute_session", sessionId, { path: "/", httpOnly: true, sameSite: "Lax" });
    }

    return c.json({ id: user.id, username: user.username, role: user.role });
  })
  .post("/login", zValidator("json", credentialsSchema), async (c) => {
    const { username, password } = c.req.valid("json");

    const user = await verifyUser(username, password);
    if (!user) {
      return c.json({ error: "Invalid credentials" }, 401);
    }

    const sessionId = await createSession(user.id);
    setCookie(c, "volute_session", sessionId, { path: "/", httpOnly: true, sameSite: "Lax" });
    return c.json({ id: user.id, username: user.username, role: user.role });
  })
  .post("/logout", async (c) => {
    const sessionId = getCookie(c, "volute_session");
    if (sessionId) {
      await deleteSession(sessionId);
      deleteCookie(c, "volute_session", { path: "/" });
    }
    return c.json({ ok: true });
  })
  .get("/me", async (c) => {
    const sessionId = getCookie(c, "volute_session");
    if (!sessionId) return c.json({ error: "Not logged in" }, 401);

    const userId = await getSessionUserId(sessionId);
    if (userId == null) return c.json({ error: "Not logged in" }, 401);

    const user = await getUser(userId);
    if (!user) return c.json({ error: "Not logged in" }, 401);

    return c.json({
      id: user.id,
      username: user.username,
      role: user.role,
      display_name: user.display_name,
      description: user.description,
      avatar: user.avatar,
    });
  })
  // Serve avatar images (public, unauthenticated)
  .get("/avatars/:filename", async (c) => {
    const filename = c.req.param("filename");
    // Path traversal guard
    if (filename.includes("/") || filename.includes("\\") || filename.includes("..")) {
      return c.json({ error: "Invalid filename" }, 400);
    }
    const dir = avatarsDir();
    const filePath = resolve(dir, filename);
    if (!filePath.startsWith(`${dir}/`)) return c.json({ error: "Invalid path" }, 400);
    if (!existsSync(filePath)) return c.json({ error: "Not found" }, 404);

    const ext = extname(filename).toLowerCase();
    const mime = AVATAR_MIME[ext];
    if (!mime) return c.json({ error: "Invalid file type" }, 400);

    const data = readFileSync(filePath);
    return c.body(data, 200, {
      "Content-Type": mime,
      "Cache-Control": "public, max-age=3600",
    });
  })
  .route("/", admin)
  .route("/", authenticated);

export default app;
