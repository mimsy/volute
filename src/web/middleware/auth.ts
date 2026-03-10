import { timingSafeEqual } from "node:crypto";
import { eq, lt } from "drizzle-orm";
import { getCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import { getOrCreateMindUser, getUser, type User } from "../../lib/auth.js";
import { resolveMindToken } from "../../lib/daemon/mind-tokens.js";
import { getDb } from "../../lib/db.js";
import { sessions } from "../../lib/schema.js";

function isValidDaemonToken(token: string): boolean {
  const expected = process.env.VOLUTE_DAEMON_TOKEN;
  if (!expected || token.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(token), Buffer.from(expected));
}

export type AuthEnv = {
  Variables: {
    user: User;
  };
};

export const SESSION_MAX_AGE = 365 * 24 * 60 * 60 * 1000; // 1 year
const SESSION_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

type CachedSession = { userId: number; user: User; expires: number };
const sessionCache = new Map<string, CachedSession>();

export function invalidateSessionCache(sessionId: string): void {
  sessionCache.delete(sessionId);
}

export async function createSession(userId: number): Promise<string> {
  const db = await getDb();
  const sessionId = crypto.randomUUID();
  await db.insert(sessions).values({ id: sessionId, userId, createdAt: Date.now() });
  return sessionId;
}

export async function deleteSession(sessionId: string): Promise<void> {
  sessionCache.delete(sessionId);
  const db = await getDb();
  await db.delete(sessions).where(eq(sessions.id, sessionId));
}

export async function getSessionUserId(sessionId: string): Promise<number | undefined> {
  const db = await getDb();
  const row = await db.select().from(sessions).where(eq(sessions.id, sessionId)).get();
  if (!row) return undefined;
  if (Date.now() - row.createdAt > SESSION_MAX_AGE) {
    await db.delete(sessions).where(eq(sessions.id, sessionId));
    return undefined;
  }
  return row.userId;
}

export async function cleanExpiredSessions(): Promise<void> {
  const db = await getDb();
  const cutoff = Date.now() - SESSION_MAX_AGE;
  await db.delete(sessions).where(lt(sessions.createdAt, cutoff));
}

export const requireAdmin = createMiddleware<AuthEnv>(async (c, next) => {
  const user = c.get("user");
  if (user.role !== "admin") {
    return c.json({ error: "Forbidden" }, 403);
  }
  await next();
});

async function resolveSession(sessionId: string): Promise<User | null> {
  // Check session cache first
  const cached = sessionCache.get(sessionId);
  if (cached && cached.expires > Date.now()) {
    return cached.user;
  }

  const userId = await getSessionUserId(sessionId);
  if (userId == null) {
    sessionCache.delete(sessionId);
    return null;
  }

  const user = await getUser(userId);
  if (!user) {
    sessionCache.delete(sessionId);
    return null;
  }

  sessionCache.set(sessionId, { userId, user, expires: Date.now() + SESSION_CACHE_TTL });
  return user;
}

export const authMiddleware = createMiddleware<AuthEnv>(async (c, next) => {
  const authHeader = c.req.header("Authorization");
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice(7);

    // 1. Daemon token — internal, always admin
    if (token && isValidDaemonToken(token)) {
      c.set("user", {
        id: 0,
        username: "daemon",
        role: "admin",
        user_type: "brain",
        display_name: null,
        description: null,
        avatar: null,
      } as User);
      await next();
      return;
    }

    // 2. Mind token — per-mind, resolves to mind's user record
    const mindName = resolveMindToken(token);
    if (mindName) {
      const mindUser = await getOrCreateMindUser(mindName);
      c.set("user", mindUser);
      await next();
      return;
    }

    // 3. Session token via Bearer (CLI login)
    if (token) {
      const user = await resolveSession(token);
      if (user) {
        if (user.role === "pending") return c.json({ error: "Account pending approval" }, 403);
        c.set("user", user);
        await next();
        return;
      }
    }
  }

  // 4. Cookie-based session (web UI)
  const sessionId = getCookie(c, "volute_session");
  if (!sessionId) return c.json({ error: "Unauthorized" }, 401);

  const user = await resolveSession(sessionId);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  if (user.role === "pending") return c.json({ error: "Account pending approval" }, 403);

  c.set("user", user);
  await next();
});

export const requireSelf = (paramName = "name") =>
  createMiddleware<AuthEnv>(async (c, next) => {
    const user = c.get("user");
    if (user.role !== "admin") {
      const target = c.req.param(paramName) ?? "";
      const [baseName] = target.split("@", 2);
      if (user.username !== baseName) {
        return c.json({ error: "Forbidden" }, 403);
      }
    }
    await next();
  });
