import { timingSafeEqual } from "node:crypto";
import { eq, lt } from "drizzle-orm";
import { getCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import { getUser, type User } from "../../lib/auth.js";
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

const SESSION_MAX_AGE = 86400000; // 24 hours
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

export const authMiddleware = createMiddleware<AuthEnv>(async (c, next) => {
  // Allow internal CLI-to-daemon requests via bearer token
  const authHeader = c.req.header("Authorization");
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice(7);
    if (token && isValidDaemonToken(token)) {
      c.set("user", { id: 0, username: "cli", role: "admin", user_type: "brain" } as User);
      await next();
      return;
    }
  }

  const sessionId = getCookie(c, "volute_session");
  if (!sessionId) return c.json({ error: "Unauthorized" }, 401);

  // Check session cache first
  const cached = sessionCache.get(sessionId);
  if (cached && cached.expires > Date.now()) {
    if (cached.user.role === "pending") return c.json({ error: "Account pending approval" }, 403);
    c.set("user", cached.user);
    await next();
    return;
  }

  const userId = await getSessionUserId(sessionId);
  if (userId == null) {
    sessionCache.delete(sessionId);
    return c.json({ error: "Unauthorized" }, 401);
  }

  const user = await getUser(userId);
  if (!user) {
    sessionCache.delete(sessionId);
    return c.json({ error: "Unauthorized" }, 401);
  }
  if (user.role === "pending") return c.json({ error: "Account pending approval" }, 403);

  sessionCache.set(sessionId, { userId, user, expires: Date.now() + SESSION_CACHE_TTL });
  c.set("user", user);
  await next();
});
