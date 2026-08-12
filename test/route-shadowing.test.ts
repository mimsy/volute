import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { afterEach, beforeEach, describe, it } from "node:test";
import { eq, like } from "drizzle-orm";
import { createUser } from "../packages/daemon/src/lib/auth.js";
import { getDb } from "../packages/daemon/src/lib/db.js";
import {
  addMind,
  mindDir,
  removeMind,
  stateDir,
} from "../packages/daemon/src/lib/mind/registry.js";
import { users } from "../packages/daemon/src/lib/schema.js";
import app from "../packages/daemon/src/web/app.js";
import { createSession } from "../packages/daemon/src/web/middleware/auth.js";

// Hono exposes the composed route table in registration order. A route is
// "shadowed" when an EARLIER, strictly-more-general registrant swallows it —
// Hono dispatches to the first pattern that matches, so a wildcard/param
// segment mounted first eats a more-specific literal sibling mounted later.
// This is exactly the class of bug that made GET /minds/:name/files/pending
// 404 after #900 re-ordered its module below the file-browser wildcard.
type RouterRoute = { method: string; path: string };

// Only concrete HTTP verbs are terminal handlers. Every method === "ALL" entry
// in this app comes from app.use() cross-cutting middleware (there are no
// .all() route handlers), which is broad by design and never a shadow.
const CONCRETE_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

// Intentional overlaps, if any ever exist: "<EARLIER method path> >> <LATER method path>".
// A pair belongs here ONLY with a comment explaining why the earlier, more-general
// route is meant to win. Do NOT add entries just to make the test pass — that
// re-hides the bug this guards against. Currently there are none.
const INTENTIONAL_SHADOWS = new Set<string>([]);

/** Replace `:param`/`*` segments with fixed literals so a pattern becomes a concrete path. */
function literalize(path: string): string {
  return path
    .split("/")
    .map((seg) => (seg === "*" ? "_wild_" : seg.startsWith(":") ? "_param_" : seg))
    .join("/");
}

/** Compile a Hono path pattern to a regex: `:param` → one segment, `*` → any suffix. */
function toRegex(path: string): RegExp {
  const parts = path.split("/").map((seg) => {
    if (seg === "*") return "(?:.*)";
    if (seg.startsWith(":")) return "[^/]+";
    return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  });
  return new RegExp(`^${parts.join("/")}$`);
}

/**
 * Walk the composed route table and return each shadowing pair as a readable
 * string. E shadows R when both are the same concrete method, E was registered
 * first, E's pattern matches a concrete instance of R, and R's pattern does NOT
 * match a concrete instance of E — i.e. E is strictly the more general of the
 * two at the point where they overlap.
 */
function findShadows(routes: RouterRoute[]): string[] {
  // Collapse the per-handler duplicates Hono emits (one row per middleware in a
  // route's chain) to the first registration index of each (method, path).
  const seen = new Set<string>();
  const uniq: RouterRoute[] = [];
  for (const r of routes) {
    if (!CONCRETE_METHODS.has(r.method)) continue;
    const key = `${r.method} ${r.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    uniq.push({ method: r.method, path: r.path });
  }

  const shadows: string[] = [];
  for (let j = 0; j < uniq.length; j++) {
    const R = uniq[j];
    for (let i = 0; i < j; i++) {
      const E = uniq[i];
      if (E.method !== R.method || E.path === R.path) continue;
      const eCoversR = toRegex(E.path).test(literalize(R.path));
      const rCoversE = toRegex(R.path).test(literalize(E.path));
      if (eCoversR && !rCoversE) {
        const pair = `${E.method} ${E.path} >> ${R.method} ${R.path}`;
        if (!INTENTIONAL_SHADOWS.has(pair)) {
          shadows.push(`${E.method} ${E.path}  shadows  ${R.method} ${R.path}`);
        }
      }
    }
  }
  return shadows;
}

describe("route shadowing", () => {
  it("no earlier route shadows a more-specific sibling", () => {
    const routes = (app as unknown as { routes: RouterRoute[] }).routes;
    const shadows = findShadows(routes);
    assert.deepEqual(
      shadows,
      [],
      `Shadowed routes (earlier general route swallows a later specific one):\n  ${shadows.join(
        "\n  ",
      )}\nReorder the mounts so the specific route registers first, or (only if the ` +
        "overlap is intentional) add the pair to INTENTIONAL_SHADOWS with a reason.",
    );
  });
});

describe("route shadowing — file-sharing reachability", () => {
  const MIND = "rs-receiver";

  async function cleanup() {
    const db = await getDb();
    await db.delete(users).where(like(users.username, "rs-admin-%"));
    const dir = mindDir(MIND);
    if (existsSync(dir)) rmSync(dir, { recursive: true });
    const state = stateDir(MIND);
    if (existsSync(state)) rmSync(state, { recursive: true });
    try {
      removeMind(MIND);
    } catch {
      // ignore
    }
  }

  beforeEach(cleanup);
  afterEach(cleanup);

  it("GET /api/v1/minds/:name/files/pending reaches the file-sharing handler, not the file-browser wildcard", async () => {
    // Authenticate as an admin so requireSelf() on the file-sharing route passes.
    const user = await createUser(`rs-admin-${Date.now()}`, "pass");
    const db = await getDb();
    await db.update(users).set({ role: "admin" }).where(eq(users.id, user.id));
    const sessionId = await createSession(user.id);

    await addMind(MIND, 14200);
    mkdirSync(stateDir(MIND), { recursive: true });

    const res = await app.request(`/api/v1/minds/${MIND}/files/pending`, {
      headers: { Cookie: `volute_session=${sessionId}`, Origin: "http://localhost" },
    });

    // Before the fix this hit the wildcard GET /:name/files/* (file browser) and
    // 404'd. The file-sharing handler returns the (empty) pending list as JSON.
    assert.notEqual(res.status, 404, "pending listing was shadowed by the file-browser wildcard");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body), "expected an array of pending files");
  });
});
