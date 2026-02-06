import { getCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import { getUser, type User } from "../../lib/auth.js";

export type AuthEnv = {
  Variables: {
    user: User;
  };
};

// In-memory session store (sessions don't survive server restart — acceptable for local tool)
const SESSION_MAX_AGE = 86400000; // 24 hours
const sessions = new Map<string, { userId: number; createdAt: number }>();

export function createSession(userId: number): string {
  const sessionId = crypto.randomUUID();
  sessions.set(sessionId, { userId, createdAt: Date.now() });
  return sessionId;
}

export function deleteSession(sessionId: string): void {
  sessions.delete(sessionId);
}

export function getSessionUserId(sessionId: string): number | undefined {
  const session = sessions.get(sessionId);
  if (!session) return undefined;
  if (Date.now() - session.createdAt > SESSION_MAX_AGE) {
    sessions.delete(sessionId);
    return undefined;
  }
  return session.userId;
}

export const authMiddleware = createMiddleware<AuthEnv>(async (c, next) => {
  const sessionId = getCookie(c, "molt_session");
  if (!sessionId) return c.json({ error: "Unauthorized" }, 401);

  const userId = getSessionUserId(sessionId);
  if (userId == null) return c.json({ error: "Unauthorized" }, 401);

  const user = await getUser(userId);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  if (user.role === "pending") return c.json({ error: "Account pending approval" }, 403);

  c.set("user", user);
  await next();
});
