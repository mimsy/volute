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
  // NOTE: the two writes below are KNOWN integrity gaps deferred to a product
  // decision on the channel-membership model (see SECURITY follow-up). They are
  // exempted here only to scope this PR; they should be revisited.
  "volute/channels.ts PATCH /:name":
    "DEFERRED: no membership/owner check on channel settings write (product decision pending)",
  "volute/channels.ts POST /:name/invite":
    "DEFERRED: no membership/owner check on add-member (product decision pending)",
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
