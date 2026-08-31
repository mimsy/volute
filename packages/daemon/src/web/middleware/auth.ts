import { timingSafeEqual } from "node:crypto";
import { eq, lt } from "drizzle-orm";
import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import { API_TOKEN_PREFIX, resolveApiToken } from "../../lib/api-tokens.js";
import { getOrCreateMindUser, getUser, type User } from "../../lib/auth.js";
import { resolveMindToken, resolveScriptToken } from "../../lib/daemon/mind-tokens.js";
import { getDb } from "../../lib/db.js";
import { getBaseName } from "../../lib/mind/registry.js";
import { sessions } from "../../lib/schema.js";

const MIND_USER_CACHE_TTL = 5 * 60 * 1000;
const mindUserCache = new Map<string, { user: User; ts: number }>();

export function invalidateMindUserCache(mindName: string): void {
  mindUserCache.delete(mindName);
}

function isValidDaemonToken(token: string): boolean {
  const expected = process.env.VOLUTE_DAEMON_TOKEN;
  if (!expected || token.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(token), Buffer.from(expected));
}

export type AuthEnv = {
  Variables: {
    user: User;
    mindSession?: string;
  };
};

export const SESSION_MAX_AGE = 365 * 24 * 60 * 60 * 1000; // 1 year
const SESSION_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

type CachedSession = { userId: number; user: User; expires: number };
const sessionCache = new Map<string, CachedSession>();

/** Test seam: direct access to the in-memory session cache. */
export const _sessionCacheForTest = sessionCache;

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
  // Sweep expired in-memory cache entries. They're only ever removed on read/logout
  // otherwise, so every token that ever authenticated leaves a permanent entry
  // (each holding a full User object). This runs on the daemon's maintenance timer.
  const now = Date.now();
  for (const [id, cached] of sessionCache) {
    if (cached.expires <= now) sessionCache.delete(id);
  }

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

/** A caller's identity, resolved from whichever credential they presented. */
export type Principal = { user: User; mindSession?: string };

/**
 * Resolve the caller's identity from the credentials on the request, or null if
 * none of them check out. This is the single place that knows how a Volute
 * credential is presented: every route needing "who is this?" goes through here
 * rather than re-parsing the header, because duplicated resolution is how the two
 * drifted apart — `GET /api/auth/me` understood only session tokens and 401'd
 * validly-authenticated `vmt_` callers (#753).
 *
 * Authentication only. Authorization — the pending-account gate, admin checks,
 * `requireSelf` — stays with the callers, so a route can deliberately answer a
 * principal that `authMiddleware` would turn away.
 */
export async function resolvePrincipal(c: Context): Promise<Principal | null> {
  const authHeader = c.req.header("Authorization");
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice(7);
    // Mind session, captured for turn resolution.
    const mindSession = c.req.header("X-Volute-Thread") || undefined;

    // 1. Daemon token — internal, always admin
    if (token && isValidDaemonToken(token)) {
      return {
        user: {
          id: 0,
          username: "daemon",
          role: "admin",
          user_type: "human",
          display_name: null,
          description: null,
          avatar: null,
        } as User,
        mindSession,
      };
    }

    // 2. Mind token — per-mind, resolves to mind's user record. A script token
    // resolves the same way: same authority, but scoped to one daemon-spawned run.
    const mindName = resolveScriptToken(token) ?? resolveMindToken(token);
    if (mindName) {
      const cached = mindUserCache.get(mindName);
      let mindUser: User;
      if (cached && Date.now() - cached.ts < MIND_USER_CACHE_TTL) {
        mindUser = cached.user;
      } else {
        mindUser = await getOrCreateMindUser(mindName);
        mindUserCache.set(mindName, { user: mindUser, ts: Date.now() });
      }
      return { user: mindUser, mindSession };
    }

    // 3. Durable per-user API token (vmt_-prefixed) — resolves to any users row.
    // Disjoint from the branches around it by construction: the daemon token and
    // session ids are bare UUIDs, and the in-memory mind-token map only ever
    // holds UUIDs, so a vmt_ value misses them and falls through to here.
    if (token.startsWith(API_TOKEN_PREFIX)) {
      const userId = await resolveApiToken(token);
      if (userId != null) {
        const user = await getUser(userId);
        if (user) return { user };
      }
    }

    // 4. Session token via Bearer (CLI login)
    if (token) {
      const user = await resolveSession(token);
      if (user) return { user };
    }
  }

  // 5. Cookie-based session (web UI)
  const sessionId = getCookie(c, "volute_session");
  if (!sessionId) return null;

  const user = await resolveSession(sessionId);
  return user ? { user } : null;
}

export const authMiddleware = createMiddleware<AuthEnv>(async (c, next) => {
  const principal = await resolvePrincipal(c);
  if (!principal) return c.json({ error: "Unauthorized" }, 401);
  if (principal.user.role === "pending") {
    return c.json({ error: "Account pending approval" }, 403);
  }

  c.set("user", principal.user);
  if (principal.mindSession) c.set("mindSession", principal.mindSession);
  await next();
});

/**
 * Routes the spirit may reach on *another* mind, in addition to its own.
 *
 * The spirit is not a superuser and has no standing authority: it passes `requireSelf`
 * only on itself. This middleware is the entire exception, and the exception is the
 * list of places it is named — six routes, countable by a person and pinned by
 * `test/authz-coverage.test.ts`.
 *
 * It is a separate middleware rather than a clause inside `requireSelf` on purpose. The
 * blanket grant this replaces lived as a `role === "spirit"` short-circuit *inside*
 * `requireSelf`, which meant no mind-scoped route looked like it granted the spirit
 * anything — the guard read as "self only" at all ~40 call sites while meaning "self,
 * or the spirit, on all of them." That invisibility is how it survived review for
 * months. A middleware you have to name at each site can be counted; a bypass cannot.
 *
 * What belongs here is bounded by one rule: *the spirit can keep the system running,
 * but cannot grant capability, read secrets, create, or destroy.* Every member is a
 * read the spirit needs for tending, or an availability action whose worst outcome is
 * disruption that heals — `start` and `restart` end with the mind running, `sleep` and
 * `wake` are the mind's own rhythm. `stop` is deliberately absent: `clock sleep` is the
 * humane form of the same intent (pre-sleep ritual, session archived, messages queued,
 * the mind comes back continuous), so the spirit can rest a mind but not silence one.
 */
export const requireSelfOrSpirit = (paramName = "name") =>
  createMiddleware<AuthEnv>(async (c, next) => {
    if (c.get("user").role === "spirit") return next();
    return requireSelf(paramName)(c, next);
  });

/**
 * True when the spirit is acting on a mind that is not itself.
 *
 * Lives here, beside `requireSelfOrSpirit`, because it is the same question: this file
 * is where "what does being the spirit mean" is decided, and keeping the role check in
 * one place is what lets `test/authz-coverage.test.ts` treat a role check anywhere else
 * as a finding. Callers use it to *narrow* what the allowlist grants — see the bounded
 * `wakeAt` on `POST /:name/sleep` — never to widen it.
 */
export async function isSpiritActingOnAnother(
  user: { role: string; username: string },
  targetName: string,
): Promise<boolean> {
  if (user.role !== "spirit") return false;
  return (await getBaseName(targetName)) !== user.username;
}

export const requireSelf = (paramName = "name") =>
  createMiddleware<AuthEnv>(async (c, next) => {
    const user = c.get("user");
    // No spirit clause. Anyone can talk to the spirit — every mind has a system DM,
    // humans DM it, it reads #system — so "the spirit may reach any mind's data" meant
    // "anything any mind talks the spirit into may reach any mind's data" (#433). The
    // six places it genuinely needs cross-mind access name `requireSelfOrSpirit`.
    if (user.role !== "admin") {
      const target = c.req.param(paramName) ?? "";
      const baseName = await getBaseName(target);
      // Base-map the caller too: a variant's token resolves to its own name,
      // but the variant shares its parent's trust domain (same OS user, history
      // recorded under the parent) — without this, a variant 403s on its own
      // routes and can't even report its events (#652).
      if (user.username !== baseName && (await getBaseName(user.username)) !== baseName) {
        return c.json({ error: "Forbidden" }, 403);
      }
    }
    await next();
  });
