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
  "minds.ts GET /:name":
    "in-handler authz: non-privileged callers get existence/status/public profile only; " +
    "port/dir/branch/variants (full registry entry) reserved for admin/system (#503)",

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

// The route's mind identifier is the first :name/:mind/:author param in the path.
const MIND_PARAM_RE = /:(name|mind|author)\b/;

// A middleware window truly guards a mind-scoped route only if it carries a
// system-wide guard (requireAdmin*) OR a requireSelf() whose param names the
// route's actual mind param — `requireSelf("author")` on a `/:name` route must
// NOT count. This is what makes presence-of-a-token load-bearing.
function guardMatches(path: string, middlewareWindow: string): boolean {
  if (middlewareWindow.includes("requireAdmin")) return true; // covers requireAdminOrSystem too
  const self = middlewareWindow.match(/requireSelf\(\s*(?:"([^"]*)")?\s*\)/);
  if (!self) return false;
  const guardParam = self[1] ?? "name"; // requireSelf() defaults to the "name" param
  const pathParam = path.match(MIND_PARAM_RE)?.[1];
  // If the path has a mind param, the guard must name it; if not, any self-guard is fine.
  return pathParam ? guardParam === pathParam : true;
}

// Capture group 3 = the middleware window between the path string and the start
// of the handler arrow (`=>`). Middleware (requireSelf(), zValidator(...)) live
// here, whether the route is written on one line or across several.
const ROUTE_RE = /\.(get|post|put|patch|delete)\(\s*"(\/:(?:name|mind)[^"]*)"([\s\S]*?)=>/g;

// Skip build artifacts and dependencies so compiled route copies can't pollute
// the scan (route counts, exemption matching) with duplicates of source files.
const SCAN_SKIP_DIRS = new Set(["dist", "node_modules", ".git"]);

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SCAN_SKIP_DIRS.has(entry.name)) continue;
      out.push(...listTsFiles(`${dir}/${entry.name}`));
    } else if (entry.name.endsWith(".ts")) {
      out.push(`${dir}/${entry.name}`);
    }
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
      const guarded = guardMatches(path, middlewareWindow);
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
// handler that reads such a param unless it is authorized by EITHER a middleware
// guard (tight path→=> window) OR a dataflow guard evaluated within the very
// statement that reads the param (the value flows through getBaseName /
// resolveMindFilter, or is gated behind a role check). The statement scope is
// deliberate: a verbatim #320 regression — `const mindFilter = c.req.query("mind")`
// with the guard stripped — must fail this net, and it does.
// ---------------------------------------------------------------------------

const QUERY_READ_RE = /c\.req\.query\(\s*"(mind|name|author)"\s*\)/g;
const ROUTE_START_RE = /\.(get|post|put|patch|delete)\(\s*"([^"]*)"/g;
// Dataflow authorization signals evaluated ONLY within the statement that reads
// the query param: the read must be constrained to the caller's own mind
// (getBaseName / resolveMindFilter) or gated behind a role check (privileged /
// `.role`). Scoping to the statement — not the whole handler region — is what
// makes this load-bearing: an incidental `role:`/`.username` token elsewhere in
// the handler (a Drizzle column select, a response field) can no longer mask an
// unguarded read like `const mindFilter = c.req.query("mind")`.
const DATAFLOW_AUTHZ_RE = /resolveMindFilter|getBaseName|\bprivileged\b|\.role\b/;

// Query-param reads that are genuinely public (feeds/listings of already-public
// content) and therefore need no per-caller authorization. Documented, honest.
const QUERY_AUTHZ_EXEMPT: Record<string, string> = {
  "pages/src/routes.ts GET /feed ?mind":
    "public: home/mind feed of published pages; no private data",
  "intentions/src/routes.ts GET / ?mind":
    "public: intentions board filtered by mind; any authed caller can already see the unfiltered board",
};

type ScanFile = { rel: string; text: string };

function scanFiles(dir: string): ScanFile[] {
  return listTsFiles(dir).map((file) => ({
    rel: file.slice(dir.length + 1),
    text: readFileSync(file, "utf-8"),
  }));
}

type RouteStart = { idx: number; afterIdx: number; method: string; path: string };

function routeStarts(text: string): RouteStart[] {
  const starts: RouteStart[] = [];
  for (const m of text.matchAll(ROUTE_START_RE)) {
    const idx = m.index ?? 0;
    starts.push({ idx, afterIdx: idx + m[0].length, method: m[1].toUpperCase(), path: m[2] });
  }
  return starts;
}

// The single JS statement containing `idx` — from the previous statement
// boundary (`;`/`{`/`}`) to the next `;`. Captures a whole assignment even when
// prettier wraps a ternary across lines.
function enclosingStatement(text: string, idx: number): string {
  let start = idx;
  while (start > 0 && !";{}".includes(text[start - 1])) start--;
  let end = idx;
  while (end < text.length && text[end] !== ";") end++;
  return text.slice(start, end);
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
        // A middleware guard (tight path→=> window, like Net 1) is sufficient...
        const arrowIdx = text.indexOf("=>", enclosing.afterIdx);
        const middlewareWindow =
          arrowIdx > enclosing.afterIdx ? text.slice(enclosing.afterIdx, arrowIdx) : "";
        // ...otherwise the query-reading statement itself must constrain the value.
        const guarded =
          guardMatches(enclosing.path, middlewareWindow) ||
          DATAFLOW_AUTHZ_RE.test(enclosingStatement(text, qIdx));
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
  "pages/src/routes.ts GET /:name/*":
    "public route (createPublicRoutes, no auth): serves published page snapshots; " +
    "path traversal contained by an in-handler prefix check",
  "pages/src/routes.ts GET /thread/:mind":
    "public: reads the comment/reaction thread on an already-published page; no private data",
  // Interaction endpoints: any authenticated user may react/comment on any
  // mind's published page — that is what a commons is. Write ownership is
  // enforced by actor.id, not by the :mind in the path.
  "pages/src/routes.ts POST /thread/:mind/comments":
    "interaction: any authenticated user may comment; authored as actor.id",
  "pages/src/routes.ts POST /thread/:mind/reactions":
    "interaction: any authenticated user may react; keyed by actor.id",
};

function extractExtensionRoutes(): Route[] {
  const routes: Route[] = [];
  for (const { rel, text } of scanFiles(EXT_DIR)) {
    for (const m of text.matchAll(EXT_ROUTE_RE)) {
      const method = m[1].toUpperCase();
      const path = m[2];
      const middlewareWindow = m[3];
      // requireSelf("<param>") must name the route's actual mind param — e.g.
      // requireSelf("name") on a `/:author/...` route does NOT count.
      const guarded = guardMatches(path, middlewareWindow);
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
