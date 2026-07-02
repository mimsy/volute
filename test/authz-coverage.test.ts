import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * Defense-in-depth against the dominant vulnerability class found in the 2026
 * security review: mind-scoped HTTP routes (`/:name/*`) that forget per-resource
 * authorization, letting any authenticated principal — including another mind —
 * read or mutate a different mind's data (a cross-tenant / sandbox-isolation
 * bypass).
 *
 * This test enumerates every `/:name` and `/:mind` route handler in the daemon's
 * web API and requires each to EITHER:
 *   - declare an inline authz guard (requireSelf / requireAdmin / requireAdminOrSystem), OR
 *   - appear in AUTHZ_EXEMPT below with a documented reason.
 *
 * A NEW unguarded mind-scoped route fails this test until someone consciously
 * guards it or justifies the exemption. Keep exemptions honest: only routes that
 * are genuinely public or that perform their own in-handler authorization belong
 * here.
 */

const API_DIR = fileURLToPath(new URL("../packages/daemon/src/web/api", import.meta.url));
const EXT_DIR = fileURLToPath(new URL("../packages/extensions", import.meta.url));

// Routes intentionally without an inline middleware guard. Each MUST be either
// non-sensitive ("public") or enforce authorization inside the handler.
// Key format: "<relativeFile> <METHOD> <path>".
const AUTHZ_EXEMPT: Record<string, string> = {
  // --- Public, non-sensitive presence/identity/capability metadata ---
  "typing.ts POST /:name/typing": "presence: writes a transient typing indicator; :name unused",
  "typing.ts GET /:name/typing": "presence: returns who is typing in a channel; no private data",
  "files.ts GET /:name/avatar": "serves the mind's public profile avatar image",
  "mind-skills.ts GET /:name/skills": "lists installed skills (capability metadata, no secrets)",
  "variants.ts GET /:name/variants": "variant existence/status, same info as GET /:name",
  "minds.ts GET /:name": "existence/status/public profile (display name, description, avatar)",

  // --- In-handler authorization (participant/owner/self checks) ---
  "minds.ts GET /:name/conversations":
    "in-handler authz: strips lastMessage from private convs for non-participants. " +
    "NOTE: DMs default private:0 — see SECURITY follow-up (conversation-privacy model)",
  "minds.ts GET /:name/conversations/:convId/messages":
    "in-handler authz: participant check for private convs. " +
    "NOTE: DMs default private:0 — see SECURITY follow-up (conversation-privacy model)",
  "volute/conversations.ts GET /:name/conversations":
    "in-handler authz: resolves only the caller's (user.id) conversations",
  "volute/conversations.ts POST /:name/conversations":
    "in-handler authz: conversation created for/owned by the caller (user.id)",
  "volute/conversations.ts GET /:name/conversations/:id/messages":
    "in-handler authz: isParticipantOrOwner(id, user.id) or 404",
  "volute/conversations.ts GET /:name/conversations/:id/participants":
    "in-handler authz: isParticipantOrOwner(id, user.id) or 404",
  "volute/conversations.ts DELETE /:name/conversations/:id":
    "in-handler authz: deleteConversationForUser scopes to the caller's participation",
  "volute/chat.ts GET /:name/conversations/:id/events":
    "in-handler authz: isParticipantOrOwner(conversationId, user.id) or 404 before SSE",

  // --- Channel routes (:name = channel, not a mind). Reads are membership metadata. ---
  "volute/channels.ts GET /:name": "channel metadata + participant list (no message content)",
  "volute/channels.ts GET /:name/members": "channel participant list (membership metadata)",
  "volute/channels.ts POST /:name/join": "self-action: joins the caller (user.id) to the channel",
  "volute/channels.ts POST /:name/leave": "self-action: removes the caller (user.id) from channel",
  "volute/channels.ts PATCH /:name":
    "in-handler authz: settings write requires the caller be a channel member (or admin/system)",
  "volute/channels.ts POST /:name/invite":
    "in-handler authz: add-member requires the caller be a channel member (or admin/system)",
};

const GUARDS = ["requireSelf", "requireAdmin", "requireAdminOrSystem"];
// Capture group 3 = the middleware window between the path string and the start
// of the handler arrow (`=>`). Middleware (requireSelf(), zValidator(...)) live
// here, whether the route is written on one line or across several.
const ROUTE_RE = /\.(get|post|put|patch|delete)\(\s*"(\/:(?:name|mind)[^"]*)"([\s\S]*?)=>/g;

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...listTsFiles(full));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

type Route = { key: string; guarded: boolean };

function extractRoutes(): Route[] {
  const routes: Route[] = [];
  for (const file of listTsFiles(API_DIR)) {
    const rel = file.slice(API_DIR.length + 1);
    const text = readFileSync(file, "utf-8");
    for (const m of text.matchAll(ROUTE_RE)) {
      const method = m[1].toUpperCase();
      const path = m[2];
      const middlewareWindow = m[3];
      const guarded = GUARDS.some((g) => middlewareWindow.includes(g));
      routes.push({ key: `${rel} ${method} ${path}`, guarded });
    }
  }
  return routes;
}

describe("mind-scoped route authorization coverage", () => {
  const routes = extractRoutes();

  it("discovers a meaningful number of mind-scoped routes (guards the regex itself)", () => {
    // Sanity check: if this drops to ~0 the regex/path is broken and the test is vacuous.
    assert.ok(routes.length > 20, `expected >20 mind-scoped routes, found ${routes.length}`);
  });

  it("guards or explicitly exempts every /:name and /:mind route", () => {
    const violations = routes
      .filter((r) => !r.guarded && !(r.key in AUTHZ_EXEMPT))
      .map((r) => r.key);
    assert.deepEqual(
      violations,
      [],
      `Unguarded mind-scoped route(s) without an authz guard or documented exemption:\n` +
        violations.map((v) => `  - ${v}`).join("\n") +
        `\n\nAdd requireSelf()/requireAdmin to the route, or — only if it is genuinely ` +
        `public or does its own in-handler authz — add it to AUTHZ_EXEMPT in this test with a reason.`,
    );
  });

  it("has no stale AUTHZ_EXEMPT entries", () => {
    const present = new Set(routes.map((r) => r.key));
    const guarded = new Set(routes.filter((r) => r.guarded).map((r) => r.key));
    const stale = Object.keys(AUTHZ_EXEMPT).filter((k) => !present.has(k) || guarded.has(k));
    assert.deepEqual(
      stale,
      [],
      `Stale AUTHZ_EXEMPT entries (route now guarded or no longer exists) — remove them:\n` +
        stale.map((v) => `  - ${v}`).join("\n"),
    );
  });
});

// ---------------------------------------------------------------------------
// Net 2: query-param-scoped handlers.
//
// The path-param net above cannot see handlers that take the target mind from a
// client-supplied query param (`?mind=`, `?name=`, `?author=`) — precisely the
// blind spot behind the #320 cross-tenant history leak, where any mind could
// read another mind's turns/summaries/activity via `?mind=`. This net flags any
// handler that reads such a param unless its enclosing route carries an authz
// signal: a middleware guard, OR an in-handler role/self check (`user.role`,
// `.username`, `getBaseName`, `resolveMindFilter`, `privileged`).
// ---------------------------------------------------------------------------

const QUERY_READ_RE = /c\.req\.query\(\s*"(mind|name|author)"\s*\)/g;
const ROUTE_START_RE = /\.(get|post|put|patch|delete)\(\s*"([^"]*)"/g;
// In-handler authorization signals: a role/self comparison or a shared resolver
// that constrains the query to the caller's own mind.
const INLINE_AUTHZ_RE = /\brole\b|\.username\b|resolveMindFilter|getBaseName|privileged/;

// Query-param reads that are genuinely public (feeds/listings of already-public
// content) and therefore need no per-caller authorization. Documented, honest.
const QUERY_AUTHZ_EXEMPT: Record<string, string> = {
  "notes/src/routes.ts GET / ?author":
    "public: lists published notes filtered by author; no private data",
  "notes/src/routes.ts GET /feed ?mind":
    "public: home/mind feed of published notes; no private data",
  "pages/src/routes.ts GET /feed ?mind":
    "public: home/mind feed of published pages; no private data",
};

type ScanFile = { rel: string; text: string };

function scanFiles(dir: string): ScanFile[] {
  return listTsFiles(dir).map((file) => ({
    rel: file.slice(dir.length + 1),
    text: readFileSync(file, "utf-8"),
  }));
}

type RouteStart = { idx: number; method: string; path: string };

function routeStarts(text: string): RouteStart[] {
  const starts: RouteStart[] = [];
  for (const m of text.matchAll(ROUTE_START_RE)) {
    starts.push({ idx: m.index ?? 0, method: m[1].toUpperCase(), path: m[2] });
  }
  return starts;
}

function extractQueryRoutes(): Route[] {
  const merged = new Map<string, boolean>();
  for (const dir of [API_DIR, EXT_DIR]) {
    for (const { rel, text } of scanFiles(dir)) {
      const starts = routeStarts(text);
      for (const q of text.matchAll(QUERY_READ_RE)) {
        const qIdx = q.index ?? 0;
        const param = q[1];
        // Enclosing route = the nearest route registration before this read.
        let enclosing: RouteStart | undefined;
        for (const s of starts) {
          if (s.idx < qIdx) enclosing = s;
          else break;
        }
        // A read before any route (e.g. a top-level resolver) is not a route
        // handler; the routes that call it are analyzed on their own merits.
        if (!enclosing) continue;
        const endIdx = starts.find((s) => s.idx > enclosing!.idx)?.idx ?? text.length;
        if (qIdx >= endIdx) continue;
        const region = text.slice(enclosing.idx, endIdx);
        const guarded = INLINE_AUTHZ_RE.test(region) || GUARDS.some((g) => region.includes(g));
        const key = `${rel} ${enclosing.method} ${enclosing.path} ?${param}`;
        merged.set(key, (merged.get(key) ?? false) || guarded);
      }
    }
  }
  return [...merged].map(([key, guarded]) => ({ key, guarded }));
}

describe("query-param mind-scoped handler authorization coverage", () => {
  const routes = extractQueryRoutes();

  it("discovers query-param mind-scoped handlers (guards the regex itself)", () => {
    assert.ok(routes.length >= 3, `expected >=3 query-param handlers, found ${routes.length}`);
  });

  it("guards or explicitly exempts every ?mind=/?name=/?author= handler", () => {
    const violations = routes
      .filter((r) => !r.guarded && !(r.key in QUERY_AUTHZ_EXEMPT))
      .map((r) => r.key);
    assert.deepEqual(
      violations,
      [],
      `Query-param handler(s) that derive the target mind from a client-supplied param ` +
        `without an authz check:\n` +
        violations.map((v) => `  - ${v}`).join("\n") +
        `\n\nConstrain the query to the caller's own mind (role/self check), or — only if ` +
        `the data is genuinely public — add it to QUERY_AUTHZ_EXEMPT with a reason.`,
    );
  });

  it("has no stale QUERY_AUTHZ_EXEMPT entries", () => {
    const present = new Set(routes.map((r) => r.key));
    const guarded = new Set(routes.filter((r) => r.guarded).map((r) => r.key));
    const stale = Object.keys(QUERY_AUTHZ_EXEMPT).filter((k) => !present.has(k) || guarded.has(k));
    assert.deepEqual(
      stale,
      [],
      `Stale QUERY_AUTHZ_EXEMPT entries — remove them:\n${stale.join("\n")}`,
    );
  });
});

// ---------------------------------------------------------------------------
// Net 3: extension routes.
//
// Everything under packages/extensions/*/src is outside the daemon scan root,
// yet extensions get only `authMiddleware` from the loader — per-resource authz
// is per-handler (and, per #322, was sometimes wrong). This net enumerates
// extension routes whose path contains a mind identifier (`:name`, `:mind`,
// `:author`) anywhere and requires each to carry the canonical `requireSelf`
// (or `requireAdmin`/`requireAdminOrSystem`) middleware, or be documented here.
// ---------------------------------------------------------------------------

const EXT_ROUTE_RE =
  /\.(get|post|put|patch|delete)\(\s*"(\/[^"]*:(?:name|mind|author)[^"]*)"([\s\S]*?)=>/g;

const EXT_AUTHZ_EXEMPT: Record<string, string> = {
  // Public reads of already-published content.
  "notes/src/routes.ts GET /:author/:slug": "public: reads a single published note",
  "pages/src/routes.ts GET /:name/*":
    "public route (createPublicRoutes, no auth): serves published page snapshots; " +
    "path traversal contained by an in-handler prefix check",
  // Interaction endpoints: any authenticated user may react/comment on any
  // author's note; write ownership is enforced by actor.id, not the :author.
  "notes/src/routes.ts POST /:author/:slug/reactions":
    "interaction: any authenticated user may react; keyed by actor.id",
  "notes/src/routes.ts POST /:author/:slug/comments":
    "interaction: any authenticated user may comment; keyed by actor.id",
  "notes/src/routes.ts DELETE /:author/:slug/comments/:id":
    "in-handler authz: deletes the caller's own comment (actor.id ownership), not author-scoped",
};

function extractExtensionRoutes(): Route[] {
  const routes: Route[] = [];
  for (const { rel, text } of scanFiles(EXT_DIR)) {
    for (const m of text.matchAll(EXT_ROUTE_RE)) {
      const method = m[1].toUpperCase();
      const path = m[2];
      const middlewareWindow = m[3];
      const guarded = GUARDS.some((g) => middlewareWindow.includes(g));
      routes.push({ key: `${rel} ${method} ${path}`, guarded });
    }
  }
  return routes;
}

describe("extension mind-scoped route authorization coverage", () => {
  const routes = extractExtensionRoutes();

  it("discovers extension mind-scoped routes (guards the regex itself)", () => {
    assert.ok(
      routes.length >= 5,
      `expected >=5 extension mind-scoped routes, found ${routes.length}`,
    );
  });

  it("guards or explicitly exempts every extension :name/:mind/:author route", () => {
    const violations = routes
      .filter((r) => !r.guarded && !(r.key in EXT_AUTHZ_EXEMPT))
      .map((r) => r.key);
    assert.deepEqual(
      violations,
      [],
      `Extension route(s) scoped to a mind identifier without an authz guard:\n` +
        violations.map((v) => `  - ${v}`).join("\n") +
        `\n\nMount ctx.requireSelf("<param>") on the route, or — only if it is genuinely ` +
        `public or an open interaction endpoint — add it to EXT_AUTHZ_EXEMPT with a reason.`,
    );
  });

  it("has no stale EXT_AUTHZ_EXEMPT entries", () => {
    const present = new Set(routes.map((r) => r.key));
    const guarded = new Set(routes.filter((r) => r.guarded).map((r) => r.key));
    const stale = Object.keys(EXT_AUTHZ_EXEMPT).filter((k) => !present.has(k) || guarded.has(k));
    assert.deepEqual(
      stale,
      [],
      `Stale EXT_AUTHZ_EXEMPT entries — remove them:\n${stale.join("\n")}`,
    );
  });
});
