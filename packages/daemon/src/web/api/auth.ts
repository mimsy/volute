import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import { zValidator } from "@hono/zod-validator";
import { isMind } from "@volute/api/user-type";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { issueApiToken, listApiTokens, revokeApiToken } from "../../lib/api-tokens.js";
import {
  approveUser,
  changePassword,
  countAdmins,
  createUser,
  deleteExternalMindUser,
  deleteUser,
  getOrCreateMindUser,
  getUser,
  getUserByUsername,
  listPendingUsers,
  listUsers,
  listUsersByType,
  setUserRole,
  updateUserProfile,
  verifyUser,
} from "../../lib/auth.js";
import { joinSystemChannel } from "../../lib/chat/system-channel.js";
import { getDb } from "../../lib/db.js";
import { broadcast } from "../../lib/events/activity-events.js";
import {
  findMind,
  readAllMinds,
  readRegistry,
  validateMindName,
  voluteHome,
} from "../../lib/mind/registry.js";
import { users } from "../../lib/schema.js";
import { normalizeAvatar } from "../../lib/util/avatar-image.js";
import { fileEtag, isNotModified } from "../../lib/util/http-cache.js";

/**
 * Mark mind users that have no `minds` row: an external mind reaches in over HTTP
 * with a Bearer token and has no port, process, or directory here, so a caller
 * cannot infer this from the mind list alone.
 *
 * `readAllMinds`, not `readRegistry`: readRegistry drops variants (`parent IS NULL`),
 * but every variant gets a users row at split (establishVariantDialogue) and keeps a
 * `minds` row naming its parent — running or stopped, it is local, not external.
 */
async function withExternalFlag<T extends { username: string; user_type: string }>(
  list: T[],
): Promise<(T & { external?: boolean })[]> {
  if (!list.some((u) => isMind(u))) return list;
  const local = new Set((await readAllMinds()).map((m) => m.name));
  return list.map((u) => (isMind(u) ? { ...u, external: !local.has(u.username) } : u));
}

/** Only join system channel when running inside the daemon (not in tests). */
function tryJoinSystem(userId: number): void {
  if (!process.env.VOLUTE_DAEMON_TOKEN) return;
  joinSystemChannel(userId).catch(() => {});
}

import {
  type AuthEnv,
  authMiddleware,
  createSession,
  deleteSession,
  getSessionUserId,
  invalidateSessionCache,
  requireAdmin,
  SESSION_MAX_AGE,
} from "../middleware/auth.js";

const SESSION_COOKIE_OPTIONS = {
  path: "/",
  httpOnly: true,
  sameSite: "Lax" as const,
  maxAge: Math.floor(SESSION_MAX_AGE / 1000),
};

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

const registerMindSchema = z.object({
  name: z.string().min(1),
  displayName: z.string().max(100).optional(),
  description: z.string().max(500).optional(),
  tokenLabel: z.string().max(100).optional(),
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
  // Register an external mind: a `user_type:"mind"` users row with NO `minds`
  // registry row — no port, no process, never spawned. It authenticates with the
  // returned token and pulls its messages. (This is also why `maxMinds` doesn't
  // apply: countCappedMinds counts `minds` rows, of which this has none.)
  //
  // requireAdmin, like the R1 token routes below: this mints a durable credential,
  // so it stays human-gated. That excludes the injectable `system` principal by
  // construction. Public self-signup needs rate-limiting, abuse controls, and a
  // resource cap before it can ship — deferred, not merely disabled.
  .post("/minds", requireAdmin, zValidator("json", registerMindSchema), async (c) => {
    const { name, displayName, description, tokenLabel } = c.req.valid("json");
    // Not a collision check (that's the getUserByUsername lookup below): this
    // rejects reserved names and enforces the slug charset so `sender_name`
    // attribution stays clean.
    const invalid = validateMindName(name);
    if (invalid) return c.json({ error: invalid }, 400);

    // Any existing user — mind, human, puppet, or system — takes the name. The
    // users.username UNIQUE constraint is the backstop against a lost race.
    if (await getUserByUsername(name)) {
      return c.json({ error: `"${name}" is already taken` }, 409);
    }

    const db = await getDb();
    let user: { id: number; username: string; user_type: string; role: string } & {
      display_name: string | null;
    };
    try {
      [user] = await db
        .insert(users)
        .values({
          username: name,
          password_hash: "!mind",
          role: "user",
          user_type: "mind",
          display_name: displayName ?? null,
          description: description ?? null,
        })
        .returning({
          id: users.id,
          username: users.username,
          user_type: users.user_type,
          role: users.role,
          display_name: users.display_name,
        });
    } catch (err) {
      // Two concurrent registrations of the same name both clear the check above
      // and race to insert; the UNIQUE constraint stops the duplicate row, but the
      // loser must still read as a collision rather than an unhandled 500 (which
      // would also log the failed INSERT's SQL and params).
      if (await getUserByUsername(name)) {
        return c.json({ error: `"${name}" is already taken` }, 409);
      }
      throw err;
    }

    // Returned exactly once — only the SHA-256 hash is stored. Never logged.
    const { id: tokenId, token } = await issueApiToken(user.id, tokenLabel);
    // Deliberately no auto-join to any system channel: the mind self-joins via
    // POST /api/v1/channels/:name/join, so registration grants no reach by default.
    return c.json({ name, user, token, tokenId }, 201);
  })
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
    broadcast({
      type: "profile_updated",
      mind: user.username,
      summary: `${user.username} profile updated`,
    });
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

    // Downscale + re-encode as webp; fall back to original bytes if sharp is unavailable
    let buffer: Buffer = Buffer.from(await file.arrayBuffer());
    let finalExt = ext;
    const normalized = await normalizeAvatar(buffer);
    if (normalized) {
      buffer = normalized.buffer;
      finalExt = normalized.ext;
    }

    const dir = avatarsDir();
    mkdirSync(dir, { recursive: true });

    const filename = `avatar-${user.id}${finalExt}`;
    writeFileSync(resolve(dir, filename), buffer);

    // Delete old avatar after writing new one (safe if same filename)
    if (user.avatar && user.avatar !== filename) {
      const oldPath = resolve(dir, user.avatar);
      rmSync(oldPath, { force: true });
    }

    await updateUserProfile(user.id, { avatar: filename });
    const sessionId = getCookie(c, "volute_session");
    if (sessionId) invalidateSessionCache(sessionId);
    broadcast({
      type: "profile_updated",
      mind: user.username,
      summary: `${user.username} avatar updated`,
    });
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
    broadcast({
      type: "profile_updated",
      mind: user.username,
      summary: `${user.username} avatar removed`,
    });
    return c.json({ ok: true });
  });

const admin = new Hono<AuthEnv>()
  .use(authMiddleware)
  .get("/users", async (c) => {
    const user = c.get("user");
    if (user.role !== "admin") return c.json({ error: "Forbidden" }, 403);

    // Ensure all registered minds have user records
    const minds = await readRegistry();
    for (const mind of minds) {
      await getOrCreateMindUser(mind.name);
    }

    const type = c.req.query("type");
    if (type === "human" || type === "mind") {
      return c.json(await withExternalFlag(await listUsersByType(type)));
    }
    return c.json(await withExternalFlag(await listUsers()));
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
    if (Number.isNaN(id)) return c.json({ error: "Invalid user ID" }, 400);
    await approveUser(id);
    return c.json({ ok: true });
  })
  .post(
    "/users/:id/role",
    zValidator("json", z.object({ role: z.enum(["admin", "user"]) })),
    async (c) => {
      const user = c.get("user");
      if (user.role !== "admin") return c.json({ error: "Forbidden" }, 403);
      const id = parseInt(c.req.param("id"), 10);
      if (Number.isNaN(id)) return c.json({ error: "Invalid user ID" }, 400);
      const { role } = c.req.valid("json");
      if (role !== "admin") {
        const adminCount = await countAdmins();
        if (adminCount <= 1) {
          const target = await getUser(id);
          if (target?.role === "admin") {
            return c.json({ error: "Cannot remove the last admin" }, 400);
          }
        }
      }
      await setUserRole(id, role);
      return c.json({ ok: true });
    },
  )
  // --- Durable per-user API tokens ---
  // requireAdmin throughout: durable credential issuance is human-gated. Only a
  // role:"admin" principal may mint or rotate tokens — a mind gets this power
  // only by being deliberately made an admin. Neither a role:"user" principal
  // (what every mind token resolves to) nor the system principal (the spirit)
  // qualifies, which closes the prompt-injection path where untrusted text
  // could talk the spirit into issuing a durable credential to an attacker.
  .post(
    "/users/:id/tokens",
    requireAdmin,
    zValidator("json", z.object({ label: z.string().max(200).optional() })),
    async (c) => {
      const id = parseInt(c.req.param("id"), 10);
      if (Number.isNaN(id)) return c.json({ error: "Invalid user ID" }, 400);
      const target = await getUser(id);
      if (!target) return c.json({ error: "User not found" }, 404);
      const { label } = c.req.valid("json");
      // The plaintext token exists only in this response — never logged.
      const issued = await issueApiToken(id, label);
      return c.json(
        {
          id: issued.id,
          token: issued.token,
          label: issued.label,
          createdAt: issued.created_at,
        },
        201,
      );
    },
  )
  .get("/users/:id/tokens", requireAdmin, async (c) => {
    const id = parseInt(c.req.param("id"), 10);
    if (Number.isNaN(id)) return c.json({ error: "Invalid user ID" }, 400);
    const target = await getUser(id);
    if (!target) return c.json({ error: "User not found" }, 404);
    const tokens = await listApiTokens(id);
    return c.json(tokens.map((t) => ({ id: t.id, label: t.label, createdAt: t.created_at })));
  })
  .delete("/users/:id/tokens/:tokenId", requireAdmin, async (c) => {
    const id = parseInt(c.req.param("id"), 10);
    const tokenId = parseInt(c.req.param("tokenId"), 10);
    if (Number.isNaN(id) || Number.isNaN(tokenId)) return c.json({ error: "Invalid ID" }, 400);
    // Scoped to :id inside the DELETE, so a token id belonging to another user
    // can't be revoked through a path that claims to be this user's.
    const revoked = await revokeApiToken(id, tokenId);
    if (!revoked) return c.json({ error: "Token not found" }, 404);
    return c.json({ ok: true });
  })
  .put("/users/:id/profile", zValidator("json", profileSchema), async (c) => {
    const user = c.get("user");
    if (user.role !== "admin") return c.json({ error: "Forbidden" }, 403);
    const id = parseInt(c.req.param("id"), 10);
    if (Number.isNaN(id)) return c.json({ error: "Invalid user ID" }, 400);
    const body = c.req.valid("json");
    await updateUserProfile(id, body);
    const updatedUser = await getUser(id);
    if (updatedUser) {
      broadcast({
        type: "profile_updated",
        mind: updatedUser.username,
        summary: `${updatedUser.username} profile updated`,
      });
    }
    return c.json({ ok: true });
  })
  .delete("/users/:id", async (c) => {
    const user = c.get("user");
    if (user.role !== "admin") return c.json({ error: "Forbidden" }, 403);
    const id = parseInt(c.req.param("id"), 10);
    if (Number.isNaN(id)) return c.json({ error: "Invalid user ID" }, 400);
    if (id === user.id) return c.json({ error: "Cannot delete yourself" }, 400);
    const target = await getUser(id);
    if (!target) return c.json({ error: "User not found" }, 404);
    if (target.role === "admin") {
      const adminCount = await countAdmins();
      if (adminCount <= 1) return c.json({ error: "Cannot delete the last admin" }, 400);
    }
    if (isMind(target)) {
      // Only a mind the daemon spawns needs the mind-deletion API, which exists to
      // stop the process and remove the directory. An external mind has neither, so
      // deleting its account is the whole teardown — and the mind API would 404 on
      // it, leaving no way to remove it at all.
      //
      // Re-derived from the registry rather than trusted from the caller: the client
      // chooses which endpoint to call, but only the registry knows whether a live
      // mind's process and directory are at stake.
      if (await findMind(target.username)) {
        return c.json({ error: "Use the mind deletion API to delete minds" }, 400);
      }
      await deleteExternalMindUser(id);
      return c.json({ ok: true });
    }
    await deleteUser(id);
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
      setCookie(c, "volute_session", sessionId, SESSION_COOKIE_OPTIONS);
    }

    // Auto-join #system channel
    tryJoinSystem(user.id);

    return c.json({ id: user.id, username: user.username, role: user.role });
  })
  .post("/login", zValidator("json", credentialsSchema), async (c) => {
    const { username, password } = c.req.valid("json");

    const user = await verifyUser(username, password);
    if (!user) {
      return c.json({ error: "Invalid credentials" }, 401);
    }

    const sessionId = await createSession(user.id);
    setCookie(c, "volute_session", sessionId, SESSION_COOKIE_OPTIONS);

    // Auto-join #system channel
    tryJoinSystem(user.id);

    return c.json({ id: user.id, username: user.username, role: user.role, sessionId });
  })
  .post("/logout", async (c) => {
    // Check cookie first, then Bearer header (for CLI logout)
    const cookieSession = getCookie(c, "volute_session");
    if (cookieSession) {
      await deleteSession(cookieSession);
      deleteCookie(c, "volute_session", { path: "/" });
      return c.json({ ok: true });
    }

    const authHeader = c.req.header("Authorization");
    if (authHeader?.startsWith("Bearer ")) {
      const token = authHeader.slice(7);
      if (token) {
        await deleteSession(token);
      }
    }
    return c.json({ ok: true });
  })
  .get("/me", async (c) => {
    // Accept Bearer token (remote UI) or cookie (same-origin)
    let sessionId = getCookie(c, "volute_session");
    if (!sessionId) {
      const authHeader = c.req.header("Authorization");
      if (authHeader?.startsWith("Bearer ")) {
        sessionId = authHeader.slice(7);
      }
    }
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

    const fileStat = statSync(filePath);
    const etag = fileEtag(fileStat);
    const headers = {
      "Content-Type": mime,
      "Cache-Control": "public, max-age=3600",
      "X-Content-Type-Options": "nosniff",
      ETag: etag,
    };
    if (isNotModified(c, etag)) return c.body(null, 304, headers);
    const data = readFileSync(filePath);
    return c.body(data, 200, headers);
  })
  .route("/", admin)
  .route("/", authenticated);

export default app;
