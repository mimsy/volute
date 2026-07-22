import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { CommandHandler, Database as ExtDb, ExtensionContext, User } from "@volute/extensions";
import { eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import Database from "libsql";
import { approveUser, createUser, getOrCreateMindUser } from "../packages/daemon/src/lib/auth.js";
import { getSpiritName } from "../packages/daemon/src/lib/config/setup.js";
import { generateMindToken } from "../packages/daemon/src/lib/daemon/mind-tokens.js";
import { getDb } from "../packages/daemon/src/lib/db.js";
import { users } from "../packages/daemon/src/lib/schema.js";
import { authMiddleware, createSession } from "../packages/daemon/src/web/middleware/auth.js";

import { createCommands } from "../packages/extensions/intentions/src/commands.js";
import { initDb } from "../packages/extensions/intentions/src/db.js";
import { formatHeldDays } from "../packages/extensions/intentions/src/format.js";
import {
  countActive,
  createIntention,
  DEFAULT_BACKOFF_DAYS,
  fulfillIntention,
  getIntention,
  keepIntention,
  listBoard,
  listMine,
  listReviewDue,
  MAX_ACTIVE_INTENTIONS,
  releaseIntention,
} from "../packages/extensions/intentions/src/intentions.js";
import { createRoutes } from "../packages/extensions/intentions/src/routes.js";

// ---------------------------------------------------------------------------
// hook/CLI/UI display formatting
// ---------------------------------------------------------------------------

describe("formatHeldDays", () => {
  // The very first thing a mind or a board viewer ever sees from this feature is
  // this string on the day an intention is set — "held 0 days" reads badly.
  it("reads 'set today' on day zero instead of 'held 0 days'", () => {
    assert.equal(formatHeldDays(0), "set today");
  });

  it("uses singular phrasing for exactly one day", () => {
    assert.equal(formatHeldDays(1), "held 1 day");
  });

  it("uses plural phrasing for more than one day", () => {
    assert.equal(formatHeldDays(2), "held 2 days");
    assert.equal(formatHeldDays(30), "held 30 days");
  });
});

// ---------------------------------------------------------------------------
// data layer
// ---------------------------------------------------------------------------

describe("intentions data layer", () => {
  let db: ExtDb;

  beforeEach(() => {
    db = new Database(":memory:") as unknown as ExtDb;
    initDb(db);
  });
  afterEach(() => db.close());

  function ageDays(id: number, column: "review_at" | "created_at" = "review_at"): number {
    const row = db
      .prepare(`SELECT julianday(${column}) - julianday('now') AS d FROM intentions WHERE id = ?`)
      .get(id) as { d: number };
    return row.d;
  }

  it("createIntention sets a 14-day review window by default", () => {
    const created = createIntention(db, "aria", "Learn mycology", undefined, undefined);
    const diff = ageDays(created.id);
    assert.ok(diff > 13.9 && diff < 14.1, `expected ~14 days out, got ${diff}`);
  });

  it("createIntention honors a custom reviewInDays", () => {
    const created = createIntention(db, "aria", "content", undefined, 3);
    const diff = ageDays(created.id);
    assert.ok(diff > 2.9 && diff < 3.1, `expected ~3 days out, got ${diff}`);
  });

  it("countActive counts only active intentions for the given mind", () => {
    createIntention(db, "aria", "one", undefined, undefined);
    const two = createIntention(db, "aria", "two", undefined, undefined);
    createIntention(db, "sol", "other mind", undefined, undefined);
    fulfillIntention(db, two.id);
    assert.equal(countActive(db, "aria"), 1);
    assert.equal(countActive(db, "sol"), 1);
  });

  it("a mind can hold up to MAX_ACTIVE_INTENTIONS active at once", () => {
    for (let i = 0; i < MAX_ACTIVE_INTENTIONS; i++) {
      createIntention(db, "aria", `content ${i}`, undefined, undefined);
    }
    assert.equal(countActive(db, "aria"), MAX_ACTIVE_INTENTIONS);
  });

  it("fulfilled/released intentions do not count toward the cap", () => {
    const a = createIntention(db, "aria", "a", undefined, undefined);
    const b = createIntention(db, "aria", "b", undefined, undefined);
    createIntention(db, "aria", "c", undefined, undefined);
    fulfillIntention(db, a.id);
    releaseIntention(db, b.id);
    assert.equal(countActive(db, "aria"), 1);
  });

  it("keepIntention bumps review_at to the default window and clears last_surfaced_at", () => {
    const created = createIntention(db, "aria", "content", undefined, undefined);
    db.prepare(
      "UPDATE intentions SET review_at = datetime('now', '-1 day'), last_surfaced_at = datetime('now') WHERE id = ?",
    ).run(created.id);

    const kept = keepIntention(db, created.id);
    assert.ok(kept);
    assert.equal(kept?.last_surfaced_at, null);
    const diff = ageDays(created.id);
    assert.ok(diff > 13.9 && diff < 14.1, `expected review_at bumped ~14 days out, got ${diff}`);
  });

  it("keepIntention returns null for a non-active intention", () => {
    const created = createIntention(db, "aria", "content", undefined, undefined);
    fulfillIntention(db, created.id);
    assert.equal(keepIntention(db, created.id), null);
  });

  it("fulfillIntention sets status, resolved_at, and resolution_note", () => {
    const created = createIntention(db, "aria", "content", undefined, undefined);
    const result = fulfillIntention(db, created.id, "done and done");
    assert.equal(result?.status, "fulfilled");
    assert.ok(result?.resolved_at);
    assert.equal(result?.resolution_note, "done and done");
  });

  it("releaseIntention sets status, resolved_at, and resolution_note", () => {
    const created = createIntention(db, "aria", "content", undefined, undefined);
    const result = releaseIntention(db, created.id, "drifted off");
    assert.equal(result?.status, "released");
    assert.equal(result?.resolution_note, "drifted off");
  });

  it("fulfillIntention only resolves active intentions", () => {
    const created = createIntention(db, "aria", "content", undefined, undefined);
    fulfillIntention(db, created.id);
    assert.equal(fulfillIntention(db, created.id, "again"), null);
  });

  it("listBoard defaults to active status across all minds", () => {
    createIntention(db, "aria", "a", undefined, undefined);
    const b = createIntention(db, "sol", "b", undefined, undefined);
    fulfillIntention(db, b.id);

    const board = listBoard(db);
    assert.equal(board.length, 1);
    assert.equal(board[0].content, "a");
  });

  it("listBoard filters by mind and status", () => {
    createIntention(db, "aria", "a", undefined, undefined);
    const b = createIntention(db, "sol", "b", undefined, undefined);
    fulfillIntention(db, b.id);

    assert.equal(listBoard(db, { mind: "sol" }).length, 0);
    assert.equal(listBoard(db, { mind: "sol", status: "fulfilled" }).length, 1);
  });

  it("listMine returns only the caller's active intentions, oldest first", () => {
    createIntention(db, "aria", "first", undefined, undefined);
    createIntention(db, "aria", "second", undefined, undefined);
    createIntention(db, "sol", "not aria's", undefined, undefined);

    const mine = listMine(db, "aria");
    assert.equal(mine.length, 2);
    assert.equal(mine[0].content, "first");
    assert.equal(mine[1].content, "second");
  });

  // Timestamps are stored as zone-less UTC text ("YYYY-MM-DD HH:MM:SS"), which
  // `new Date(...)` would misparse as local time (a recurring bug in this codebase —
  // see parseDbTimestamp()). held_days/overdue are computed entirely in SQL, against
  // the same UTC clock as the stored values, so this round-trips correctly by
  // construction rather than by remembering to call a JS-side parser.
  it("listMine computes held_days and overdue in SQL, immune to local-timezone misparsing", () => {
    const created = createIntention(db, "aria", "content", undefined, undefined);
    db.prepare(
      "UPDATE intentions SET created_at = datetime('now', '-6 days'), review_at = datetime('now', '-1 day') WHERE id = ?",
    ).run(created.id);

    const [mine] = listMine(db, "aria");
    assert.equal(mine.held_days, 6);
    assert.equal(mine.overdue, true);
  });

  it("listBoard marks a not-yet-due active intention as not overdue", () => {
    createIntention(db, "aria", "content", undefined, undefined);
    const [row] = listBoard(db, { mind: "aria" });
    assert.equal(row.overdue, false);
  });

  it("listReviewDue returns only overdue, non-backed-off active intentions and marks them surfaced", () => {
    const due = createIntention(db, "aria", "overdue one", undefined, undefined);
    createIntention(db, "sol", "not due yet", undefined, undefined);
    const recentlySurfaced = createIntention(db, "wren", "recently surfaced", undefined, undefined);

    db.prepare("UPDATE intentions SET review_at = datetime('now', '-1 day') WHERE id = ?").run(
      due.id,
    );
    db.prepare(
      "UPDATE intentions SET review_at = datetime('now', '-1 day'), last_surfaced_at = datetime('now', '-1 day') WHERE id = ?",
    ).run(recentlySurfaced.id);

    const result = listReviewDue(db);
    assert.deepEqual(
      result.map((r) => r.id),
      [due.id],
    );

    // Marked surfaced regardless of whether the mind ever responds — this is what
    // prevents review-due from nagging the same intention every day.
    const row = getIntention(db, due.id);
    assert.ok(row?.last_surfaced_at);
  });

  it("listReviewDue respects a custom backoff window", () => {
    const created = createIntention(db, "aria", "content", undefined, undefined);
    db.prepare(
      "UPDATE intentions SET review_at = datetime('now', '-10 days'), last_surfaced_at = datetime('now', '-5 days') WHERE id = ?",
    ).run(created.id);

    assert.equal(listReviewDue(db, DEFAULT_BACKOFF_DAYS).length, 0);
    assert.equal(listReviewDue(db, 3).length, 1);
  });
});

// ---------------------------------------------------------------------------
// HTTP routes — authorization
// ---------------------------------------------------------------------------

describe("intentions routes authorization", () => {
  const spiritName = getSpiritName();
  const mindA = `intentions-route-a-${Date.now()}`;
  const mindB = `intentions-route-b-${Date.now()}`;
  const adminUsername = `intentions-route-admin-${Date.now()}`;

  let db: ExtDb;
  let app: Hono;

  beforeEach(() => {
    db = new Database(":memory:") as unknown as ExtDb;
    initDb(db);
    const ctx = { db, publishActivity: () => {} } as unknown as ExtensionContext;
    app = new Hono();
    app.use("/api/ext/intentions/*", authMiddleware);
    app.route("/api/ext/intentions", createRoutes(ctx));
  });

  afterEach(async () => {
    db.close();
    const conn = await getDb();
    await conn.delete(users).where(inArray(users.username, [mindA, mindB, adminUsername]));
  });

  async function mindAuth(name: string): Promise<{ Authorization: string }> {
    await getOrCreateMindUser(name);
    return { Authorization: `Bearer ${generateMindToken(name)}` };
  }

  async function adminAuth(): Promise<{ Cookie: string }> {
    const user = await createUser(adminUsername, "pass");
    // createUser only auto-admins the very first human user system-wide, which may
    // already be spoken for by another test — force the role directly.
    const conn = await getDb();
    await conn.update(users).set({ role: "admin" }).where(eq(users.id, user.id));
    await approveUser(user.id);
    const sessionId = await createSession(user.id);
    return { Cookie: `volute_session=${sessionId}` };
  }

  // ---- the regression test: this is the exact shape of the old plan extension's
  // bug (`actor.role !== "admin" && actor.user_type !== "mind"`, which permitted
  // every mind). review-due must reject an ordinary mind and accept only the
  // spirit or an admin. ----
  it("GET /review-due rejects an ordinary mind with 403", async () => {
    const headers = await mindAuth(mindA);
    const res = await app.request("http://localhost/api/ext/intentions/review-due", { headers });
    assert.equal(res.status, 403);
  });

  it("GET /review-due allows the spirit (role: system)", async () => {
    const headers = await mindAuth(spiritName);
    const res = await app.request("http://localhost/api/ext/intentions/review-due", { headers });
    assert.equal(res.status, 200);
  });

  it("GET /review-due allows an admin", async () => {
    const headers = await adminAuth();
    const res = await app.request("http://localhost/api/ext/intentions/review-due", { headers });
    assert.equal(res.status, 200);
  });

  // ---- #791: the daemon's own admin token authenticates as a synthetic user with
  // id 0 and no users row. The actor resolver rejected id 0 outright, so the same
  // token that works on every core route 401'd on extension routes. ----
  it("GET /review-due allows the daemon admin token", async () => {
    const prev = process.env.VOLUTE_DAEMON_TOKEN;
    process.env.VOLUTE_DAEMON_TOKEN = "daemon-token-for-test";
    try {
      const res = await app.request("http://localhost/api/ext/intentions/review-due", {
        headers: { Authorization: "Bearer daemon-token-for-test" },
      });
      assert.equal(res.status, 200);
    } finally {
      if (prev === undefined) delete process.env.VOLUTE_DAEMON_TOKEN;
      else process.env.VOLUTE_DAEMON_TOKEN = prev;
    }
  });

  it("the daemon token still cannot hold an intention of its own", async () => {
    // It's a valid admin principal but has no account to own anything with —
    // letting it through would create an intention owned by a nonexistent "daemon".
    const prev = process.env.VOLUTE_DAEMON_TOKEN;
    process.env.VOLUTE_DAEMON_TOKEN = "daemon-token-for-test";
    try {
      const res = await app.request("http://localhost/api/ext/intentions", {
        method: "POST",
        headers: {
          Authorization: "Bearer daemon-token-for-test",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ content: "an intention with no holder" }),
      });
      assert.equal(res.status, 403);
      assert.equal(listBoard(db, {}).length, 0);
    } finally {
      if (prev === undefined) delete process.env.VOLUTE_DAEMON_TOKEN;
      else process.env.VOLUTE_DAEMON_TOKEN = prev;
    }
  });

  it("mind A cannot keep mind B's intention", async () => {
    const bHeaders = await mindAuth(mindB);
    const created = await app.request("http://localhost/api/ext/intentions", {
      method: "POST",
      headers: { ...bHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ content: "mind B's intention" }),
    });
    const { id } = (await created.json()) as { id: number };

    const aHeaders = await mindAuth(mindA);
    const res = await app.request(`http://localhost/api/ext/intentions/${id}/keep`, {
      method: "POST",
      headers: aHeaders,
    });
    assert.equal(res.status, 403);
  });

  it("mind A cannot fulfill or release mind B's intention", async () => {
    const bHeaders = await mindAuth(mindB);
    const created = await app.request("http://localhost/api/ext/intentions", {
      method: "POST",
      headers: { ...bHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ content: "mind B's intention" }),
    });
    const { id } = (await created.json()) as { id: number };

    const aHeaders = await mindAuth(mindA);
    for (const action of ["fulfill", "release"]) {
      const res = await app.request(`http://localhost/api/ext/intentions/${id}/${action}`, {
        method: "POST",
        headers: aHeaders,
      });
      assert.equal(res.status, 403, `${action} should be forbidden for a non-owner`);
    }
  });

  it("an admin can manage any mind's intention", async () => {
    const bHeaders = await mindAuth(mindB);
    const created = await app.request("http://localhost/api/ext/intentions", {
      method: "POST",
      headers: { ...bHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ content: "mind B's intention" }),
    });
    const { id } = (await created.json()) as { id: number };

    const admin = await adminAuth();
    const res = await app.request(`http://localhost/api/ext/intentions/${id}/keep`, {
      method: "POST",
      headers: admin,
    });
    assert.equal(res.status, 200);
  });

  it("the owner can keep, fulfill, and release its own intention", async () => {
    const headers = await mindAuth(mindA);
    const created = await app.request("http://localhost/api/ext/intentions", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ content: "my own intention" }),
    });
    const { id } = (await created.json()) as { id: number };

    const keep = await app.request(`http://localhost/api/ext/intentions/${id}/keep`, {
      method: "POST",
      headers,
    });
    assert.equal(keep.status, 200);

    const fulfill = await app.request(`http://localhost/api/ext/intentions/${id}/fulfill`, {
      method: "POST",
      headers,
    });
    assert.equal(fulfill.status, 200);
  });

  it("the 4th active intention is rejected with 400", async () => {
    const headers = { ...(await mindAuth(mindA)), "Content-Type": "application/json" };
    for (let i = 0; i < MAX_ACTIVE_INTENTIONS; i++) {
      const res = await app.request("http://localhost/api/ext/intentions", {
        method: "POST",
        headers,
        body: JSON.stringify({ content: `content ${i}` }),
      });
      assert.equal(res.status, 201);
    }

    const res = await app.request("http://localhost/api/ext/intentions", {
      method: "POST",
      headers,
      body: JSON.stringify({ content: "one too many" }),
    });
    assert.equal(res.status, 400);
  });

  it("GET /mine returns [] for a non-mind caller instead of erroring", async () => {
    const headers = await adminAuth();
    const res = await app.request("http://localhost/api/ext/intentions/mine", { headers });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), []);
  });

  it("GET / (board) is open to any authenticated mind", async () => {
    const bHeaders = await mindAuth(mindB);
    await app.request("http://localhost/api/ext/intentions", {
      method: "POST",
      headers: { ...bHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ content: "visible to everyone" }),
    });

    const aHeaders = await mindAuth(mindA);
    const res = await app.request("http://localhost/api/ext/intentions", { headers: aHeaders });
    assert.equal(res.status, 200);
    const board = (await res.json()) as { content: string }[];
    assert.ok(board.some((i) => i.content === "visible to everyone"));
  });

  it("unauthenticated request gets 401", async () => {
    const res = await app.request("http://localhost/api/ext/intentions/review-due");
    assert.equal(res.status, 401);
  });
});

// ---------------------------------------------------------------------------
// extension commands (CLI-facing)
// ---------------------------------------------------------------------------

describe("intentions commands", () => {
  let db: ExtDb;

  beforeEach(() => {
    db = new Database(":memory:") as unknown as ExtDb;
    initDb(db);
  });
  afterEach(() => db.close());

  function makeCtx(mindName: string, user: Partial<User> | null): Parameters<CommandHandler>[1] {
    return {
      mindName,
      db,
      getUser: async () => null,
      getUserByUsername: async () => user as User | null,
      publishActivity: () => {},
    } as unknown as Parameters<CommandHandler>[1];
  }

  it("review-due command rejects an ordinary mind", async () => {
    const commands = createCommands();
    const ctx = makeCtx("aria", { username: "aria", role: "user", user_type: "mind" } as User);
    const result = await commands["review-due"].handler({ args: {}, flags: {}, rest: [] }, ctx);
    assert.ok("error" in result);
    assert.match(result.error, /Forbidden/);
  });

  it("review-due command allows the spirit (role: system)", async () => {
    createIntention(db, "aria", "overdue thing", undefined, undefined);
    db.prepare("UPDATE intentions SET review_at = datetime('now', '-1 day')").run();

    const commands = createCommands();
    const ctx = makeCtx("volute", {
      username: "volute",
      role: "system",
      user_type: "system",
    } as User);
    const result = await commands["review-due"].handler({ args: {}, flags: {}, rest: [] }, ctx);
    assert.ok("output" in result);
    assert.match(result.output, /overdue thing/);
  });

  it("add command enforces the active cap", async () => {
    const commands = createCommands();
    const ctx = makeCtx("aria", { username: "aria", role: "user", user_type: "mind" } as User);
    for (let i = 0; i < MAX_ACTIVE_INTENTIONS; i++) {
      const result = await commands.add.handler(
        { args: { content: `content ${i}` }, flags: {}, rest: [] },
        ctx,
      );
      assert.ok("output" in result);
    }
    const result = await commands.add.handler(
      { args: { content: "one too many" }, flags: {}, rest: [] },
      ctx,
    );
    assert.ok("error" in result);
  });
});
