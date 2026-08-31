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
import log from "../../lib/util/logger.js";
import {
  type Effective,
  hasAdminAuthority,
  hasSystemAuthority,
  resolveEffective,
} from "./effective-principal.js";

const alog = log.child("authz");

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
    /**
     * The authority this request actually runs at. `user` stays the authenticated
     * account so the audit trail keeps saying who made the call; `effective` is what
     * the guards read. For everyone but the spirit the two agree.
     */
    effective: Effective;
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

/**
 * Strict admin. The spirit passes only while acting on behalf of a verified admin;
 * its own self-initiated work (`system`) is deliberately excluded.
 *
 * That exclusion is what keeps mind creation out of reach of a subverted spirit. The
 * `system` tier is *structurally* self-reachable — the spirit configures its own
 * schedules, and a schedule fire is self-initiated by definition — so anything gated
 * only on `system` is gated on nothing where the spirit is concerned. Mind creation
 * is the crash-the-host vector and stays admin-gated, exactly as decided in #433.
 */
export const requireAdmin = createMiddleware<AuthEnv>(async (c, next) => {
  const effective = c.get("effective");
  if (!hasAdminAuthority(effective)) {
    return c.json({ error: "Forbidden" }, 403);
  }
  logDelegation(c, effective);
  await next();
});

/**
 * Record whose authority a privileged action ran on, when it ran on someone's.
 *
 * `c.get("user")` stays the spirit on these calls — the audit trail should keep saying
 * which account made the request — so without this line borrowed authority leaves no
 * trace anywhere. Only `actingFor` is logged: the `system` tier is the spirit posting
 * its own events all through a schedule turn, and a line per request would be noise
 * over something the `turns` and `mind_history` rows already reconstruct.
 */
function logDelegation(c: Context, effective: Effective): void {
  if (!effective.actingFor) return;
  alog.info(`privileged ${c.req.method} ${c.req.path} on behalf of ${effective.actingFor}`, {
    actingFor: effective.actingFor,
    role: effective.role,
  });
}

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
export type Principal = {
  user: User;
  mindSession?: string;
  /** Set when the credential was one the daemon minted for a script it spawned. */
  viaScript?: boolean;
};

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
    // resolves the same way but is flagged: it is the daemon's own evidence that
    // this call came from a process it spawned for the mind (see mind-tokens.ts).
    const scriptMind = resolveScriptToken(token);
    const mindName = scriptMind ?? resolveMindToken(token);
    if (mindName) {
      const cached = mindUserCache.get(mindName);
      let mindUser: User;
      if (cached && Date.now() - cached.ts < MIND_USER_CACHE_TTL) {
        mindUser = cached.user;
      } else {
        mindUser = await getOrCreateMindUser(mindName);
        mindUserCache.set(mindName, { user: mindUser, ts: Date.now() });
      }
      return { user: mindUser, mindSession, viaScript: scriptMind != null };
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
  c.set("effective", await resolveEffective(principal));
  await next();
});

export const requireSelf = (paramName = "name") =>
  createMiddleware<AuthEnv>(async (c, next) => {
    const effective = c.get("effective");
    if (hasSystemAuthority(effective)) {
      // Reaching *another* mind's data on borrowed authority is the case worth a line:
      // it is the affordance #433 kept, and the one that needs a trail. The spirit's own
      // routes during that same turn are not (`scopes[0]` is always the caller itself).
      if (effective.actingFor && c.req.param(paramName) !== effective.scopes[0]) {
        logDelegation(c, effective);
      }
    } else {
      const target = c.req.param(paramName) ?? "";
      const baseName = await getBaseName(target);
      // Base-map the caller too: a variant's token resolves to its own name,
      // but the variant shares its parent's trust domain (same OS user, history
      // recorded under the parent) — without this, a variant 403s on its own
      // routes and can't even report its events (#652).
      //
      // More than one scope only ever happens for the spirit mid-delegation: its
      // own name plus the name of whoever it is acting for.
      const scopes = effective?.scopes ?? [];
      const matches = await Promise.all(
        scopes.map(async (s) => s === baseName || (await getBaseName(s)) === baseName),
      );
      if (!matches.some(Boolean)) {
        return c.json({ error: "Forbidden" }, 403);
      }
    }
    await next();
  });
