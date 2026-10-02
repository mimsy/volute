import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { eq } from "drizzle-orm";
import {
  clearMind,
  completeOrphanedTurns,
  completeTurn,
  createTurn,
  getActiveTurnId,
  getLastToolUseEventId,
  getToolUseEventId,
  markErrored,
  sweepWedgedTurns,
  takeErrored,
  trackToolUse,
} from "../packages/daemon/src/lib/daemon/turn-tracker.js";
import { getDb } from "../packages/daemon/src/lib/db.js";
import { mindHistory, turns } from "../packages/daemon/src/lib/schema.js";

/** UTC "YYYY-MM-DD HH:MM:SS" — matches the format SQLite's datetime('now') stores. */
function utcStamp(msAgo: number): string {
  return new Date(Date.now() - msAgo).toISOString().slice(0, 19).replace("T", " ");
}

describe("turn-tracker", () => {
  const mind = "test-turn-tracker";

  it("creates a turn and returns its ID", async () => {
    const turnId = await createTurn(mind, undefined, mind);
    assert.ok(turnId, "should return a turn ID");

    const db = await getDb();
    const row = await db.select().from(turns).where(eq(turns.id, turnId)).get();
    assert.ok(row, "turn should exist in DB");
    assert.equal(row!.mind, mind);
    assert.equal(row!.status, "active");
    assert.equal(row!.thread, null);

    // Cleanup
    await clearMind(mind);
  });

  it("reuses existing active turn for same mind", async () => {
    const id1 = await createTurn(mind, undefined, mind);
    const id2 = await createTurn(mind, undefined, mind);
    assert.equal(id1, id2, "should reuse the same turn");

    await clearMind(mind);
  });

  it("getActiveTurnId returns the active turn", async () => {
    const turnId = await createTurn(mind, undefined, mind);
    assert.equal(getActiveTurnId(mind, undefined, mind), turnId);
    assert.equal(getActiveTurnId(mind, null, mind), turnId, "should fall back to wildcard");

    await clearMind(mind);
  });

  it("keys a thread's turn by its thread from the start, with no fallback", async () => {
    const turnId = await createTurn(mind, "sess-1", mind);
    assert.ok(turnId);
    assert.equal(getActiveTurnId(mind, "sess-1", mind), turnId);
    // Neither the sessionless slot nor another thread resolves to it, and a thread with
    // no turn of its own never resolves to the sessionless one (#1173).
    assert.equal(getActiveTurnId(mind, undefined, mind), undefined);
    assert.equal(getActiveTurnId(mind, "sess-2", mind), undefined);
    const sessionless = await createTurn(mind, undefined, mind);
    assert.ok(sessionless && sessionless !== turnId);
    assert.equal(getActiveTurnId(mind, "sess-2", mind), undefined);
    assert.equal(getActiveTurnId(mind, undefined, mind), sessionless);

    const db = await getDb();
    const row = await db.select().from(turns).where(eq(turns.id, turnId)).get();
    assert.equal(row!.thread, "sess-1");

    await clearMind(mind);
  });

  it("tracks tool_use event IDs", async () => {
    await createTurn(mind, undefined, mind);

    assert.equal(getLastToolUseEventId(mind, undefined, mind), undefined);

    trackToolUse(mind, null, mind, 42);
    assert.equal(getLastToolUseEventId(mind, undefined, mind), 42);

    trackToolUse(mind, null, mind, 99);
    assert.equal(getLastToolUseEventId(mind, undefined, mind), 99);

    await clearMind(mind);
  });

  it("getToolUseEventId resolves the matching tool_use by SDK id", async () => {
    await createTurn(mind, undefined, mind);

    // Two tool calls in one turn (e.g. parallel), tracked with their SDK ids.
    trackToolUse(mind, null, mind, 10, "toolu_a");
    trackToolUse(mind, null, mind, 11, "toolu_b");

    // A result must link to its OWN tool_use, not just the most recent one.
    assert.equal(getToolUseEventId(mind, null, mind, "toolu_a"), 10);
    assert.equal(getToolUseEventId(mind, null, mind, "toolu_b"), 11);

    await clearMind(mind);
  });

  it("getToolUseEventId falls back to the last tool_use when id is absent/unknown", async () => {
    await createTurn(mind, undefined, mind);

    trackToolUse(mind, null, mind, 10, "toolu_a");
    trackToolUse(mind, null, mind, 11, "toolu_b");

    // No id (older template) → last tool_use.
    assert.equal(getToolUseEventId(mind, null, mind), 11);
    // Unknown id → last tool_use.
    assert.equal(getToolUseEventId(mind, null, mind, "toolu_missing"), 11);

    await clearMind(mind);
  });

  it("completes a turn", async () => {
    const turnId = await createTurn(mind, undefined, mind);
    const completedId = await completeTurn(mind, undefined, mind);

    assert.equal(completedId, turnId);
    assert.equal(getActiveTurnId(mind, undefined, mind), undefined);

    const db = await getDb();
    const row = await db.select().from(turns).where(eq(turns.id, turnId)).get();
    assert.equal(row!.status, "complete");
  });

  it("a done closes only its own thread's turn, never an unrelated sessionless one", async () => {
    const sessionless = await createTurn(mind, undefined, mind);
    assert.equal(await completeTurn(mind, "s1", mind), undefined, "s1 has no turn to close");
    assert.equal(
      getActiveTurnId(mind, undefined, mind),
      sessionless,
      "the sessionless turn is not s1's",
    );

    const own = await createTurn(mind, "s1", mind);
    assert.equal(await completeTurn(mind, "s1", mind), own);
    assert.equal(getActiveTurnId(mind, undefined, mind), sessionless);
    assert.equal(
      await completeTurn(mind, undefined, mind),
      sessionless,
      "a sessionless done closes it",
    );
    await clearMind(mind);
  });

  it("completeTurn returns undefined when no active turn", async () => {
    const result = await completeTurn("nonexistent-mind", undefined, "nonexistent-mind");
    assert.equal(result, undefined);
  });

  it("clearMind removes all entries and returns orphaned turns", async () => {
    const turnId = await createTurn(mind, "s1", mind);

    // Create another turn for a different mind
    const otherMind = "test-turn-tracker-other";
    const otherId = await createTurn(otherMind, undefined, otherMind);

    const orphaned = await clearMind(mind);
    assert.equal(getActiveTurnId(mind, "s1", mind), undefined);
    assert.equal(
      getActiveTurnId(otherMind, undefined, otherMind),
      otherId,
      "other mind should be unaffected",
    );

    assert.equal(orphaned.length, 1);
    assert.equal(orphaned[0].turnId, turnId);
    assert.equal(orphaned[0].session, "s1");

    await clearMind(otherMind);
  });

  it("clearMind returns wildcard session as undefined", async () => {
    const turnId = await createTurn(mind, undefined, mind);
    const orphaned = await clearMind(mind);

    assert.equal(orphaned.length, 1);
    assert.equal(orphaned[0].turnId, turnId);
    assert.equal(orphaned[0].session, undefined);
  });

  it("completeOrphanedTurns returns orphaned turns and marks them complete", async () => {
    // Insert active turns directly into DB to simulate a previous daemon session
    const db = await getDb();
    const turn1 = "orphan-test-1";
    const turn2 = "orphan-test-2";
    await db.insert(turns).values({ id: turn1, mind: "mind-a", thread: "s1", status: "active" });
    await db.insert(turns).values({ id: turn2, mind: "mind-b", thread: null, status: "active" });

    const result = await completeOrphanedTurns();

    assert.equal(result.length, 2);
    const byId = new Map(result.map((r) => [r.turnId, r]));
    assert.ok(byId.has(turn1));
    assert.equal(byId.get(turn1)!.mind, "mind-a");
    assert.equal(byId.get(turn1)!.session, "s1");
    assert.ok(byId.has(turn2));
    assert.equal(byId.get(turn2)!.mind, "mind-b");
    assert.equal(byId.get(turn2)!.session, undefined);

    // Verify they're marked complete in DB
    const row1 = await db.select().from(turns).where(eq(turns.id, turn1)).get();
    assert.equal(row1!.status, "complete");
    const row2 = await db.select().from(turns).where(eq(turns.id, turn2)).get();
    assert.equal(row2!.status, "complete");
  });

  it("completeOrphanedTurns returns empty array when no orphans exist", async () => {
    const result = await completeOrphanedTurns();
    assert.equal(result.length, 0);
  });

  it("takeErrored returns the flag once then clears it", () => {
    markErrored("errmind", "s1", "errmind");
    assert.equal(takeErrored("errmind", "s1", "errmind"), true);
    assert.equal(takeErrored("errmind", "s1", "errmind"), false);
  });

  it("errored flag is per (mind, session)", () => {
    markErrored("errmind", "s1", "errmind");
    assert.equal(takeErrored("errmind", "s2", "errmind"), false, "different session unaffected");
    assert.equal(takeErrored("other", "s1", "other"), false, "different mind unaffected");
    assert.equal(takeErrored("errmind", "s1", "errmind"), true);
  });

  it("clearMind drops a pending errored flag for that mind only", async () => {
    markErrored("errmind", "s1", "errmind");
    markErrored("keepmind", "s1", "keepmind");
    await clearMind("errmind");
    assert.equal(takeErrored("errmind", "s1", "errmind"), false, "cleared on crash/stop");
    assert.equal(takeErrored("keepmind", "s1", "keepmind"), true, "other mind's flag intact");
  });

  it("clearMind clears one process's turns and state: a variant's never its parent's, nor the reverse", async () => {
    const parent = "clear-parent";
    const variant = "clear-parent@v";
    const p1 = await createTurn(parent, "s1", parent);
    const v1 = await createTurn(parent, "s1", variant);
    markErrored(parent, "s1", parent, "pd");
    markErrored(parent, "s1", variant, "vd");

    // The variant crashes: only its turn and flags go, its turns reported under the base name.
    const orphaned = await clearMind(variant);
    assert.deepEqual(orphaned, [{ turnId: v1, mind: parent, session: "s1" }]);
    assert.equal(getActiveTurnId(parent, "s1", variant), undefined);
    assert.equal(getActiveTurnId(parent, "s1", parent), p1, "the parent's turn runs on");
    assert.equal(takeErrored(parent, "s1", variant, ["vd"]), false);
    assert.equal(takeErrored(parent, "s1", parent, ["pd"]), true);

    // The parent crashes: the variant's new turn and flags are left alone.
    const v2 = await createTurn(parent, "s1", variant);
    markErrored(parent, "s1", variant, "vd2");
    assert.deepEqual(await clearMind(parent), [{ turnId: p1, mind: parent, session: "s1" }]);
    assert.equal(getActiveTurnId(parent, "s1", variant), v2);
    assert.equal(takeErrored(parent, "s1", variant, ["vd2"]), true);
    await clearMind(variant);
  });

  describe("sweepWedgedTurns", () => {
    const idleMs = 10 * 60_000;

    it("sweeps a turn whose process isn't running, done or not", async () => {
      const id = await seedTurn("ws-dead", [{ type: "tool_use", msAgo: 1000 }]);
      const live = await createTurn("sweep-mind", "ws-dead", "sweep-mind@v");
      const swept = await sweepWedgedTurns(idleMs, (process) => process !== "sweep-mind");
      assert.ok(swept.some((t) => t.turnId === id));
      assert.ok(!swept.some((t) => t.turnId === live), "a running process's turn stays");
      assert.equal(getActiveTurnId("sweep-mind", "ws-dead", "sweep-mind"), undefined);
      assert.equal(getActiveTurnId("sweep-mind", "ws-dead", "sweep-mind@v"), live);
      await clearMind("sweep-mind@v");
    });

    // Create a real (in-memory + DB) turn for `sweep-mind`, assign it a session, and
    // attach mind_history events at the given ages. Returns the real turn id.
    async function seedTurn(
      sess: string,
      events: { type: string; msAgo: number }[],
    ): Promise<string> {
      const id = await createTurn("sweep-mind", sess, "sweep-mind");
      assert.ok(id);
      const db = await getDb();
      for (const e of events) {
        await db.insert(mindHistory).values({
          mind: "sweep-mind",
          type: e.type,
          thread: sess,
          turn_id: id,
          created_at: utcStamp(e.msAgo),
        });
      }
      return id!;
    }

    it("completes a turn that has a done event and is idle past the threshold", async () => {
      const id = await seedTurn("ws1", [
        { type: "text", msAgo: 30 * 60_000 },
        { type: "done", msAgo: 20 * 60_000 },
      ]);
      assert.equal(
        getActiveTurnId("sweep-mind", "ws1", "sweep-mind"),
        id,
        "turn is active in memory",
      );

      const swept = await sweepWedgedTurns(idleMs);
      const mine = swept.find((t) => t.turnId === id);
      assert.ok(mine, "wedged turn should be swept");
      assert.equal(mine!.mind, "sweep-mind");
      assert.equal(mine!.session, "ws1");

      const db = await getDb();
      const row = await db.select().from(turns).where(eq(turns.id, id)).get();
      assert.equal(row!.status, "complete", "turn should be marked complete");
      assert.equal(
        getActiveTurnId("sweep-mind", "ws1", "sweep-mind"),
        undefined,
        "in-memory entry cleared",
      );
    });

    it("does NOT sweep an active turn that never received a done", async () => {
      const id = await seedTurn("ws2", [{ type: "tool_use", msAgo: 30 * 60_000 }]);

      const swept = await sweepWedgedTurns(idleMs);
      assert.equal(
        swept.find((t) => t.turnId === id),
        undefined,
        "no done → not wedged",
      );

      const db = await getDb();
      const row = await db.select().from(turns).where(eq(turns.id, id)).get();
      assert.equal(row!.status, "active");
      await clearMind("sweep-mind");
    });

    it("does NOT sweep a turn whose last event is within the threshold", async () => {
      const id = await seedTurn("ws3", [
        { type: "done", msAgo: 12 * 60_000 },
        { type: "text", msAgo: 1 * 60_000 },
      ]);

      const swept = await sweepWedgedTurns(idleMs);
      assert.equal(
        swept.find((t) => t.turnId === id),
        undefined,
        "recent activity → not wedged",
      );

      const db = await getDb();
      const row = await db.select().from(turns).where(eq(turns.id, id)).get();
      assert.equal(row!.status, "active");
      await clearMind("sweep-mind");
    });

    it("sweeps a sessionless wedged turn (null session)", async () => {
      const id = await createTurn("sweep-nosess", undefined, "sweep-nosess");
      assert.ok(id);
      const db = await getDb();
      for (const e of [
        { type: "text", msAgo: 30 * 60_000 },
        { type: "done", msAgo: 20 * 60_000 },
      ]) {
        await db.insert(mindHistory).values({
          mind: "sweep-nosess",
          type: e.type,
          thread: null,
          turn_id: id,
          created_at: utcStamp(e.msAgo),
        });
      }

      const swept = await sweepWedgedTurns(idleMs);
      const mine = swept.find((t) => t.turnId === id);
      assert.ok(mine, "sessionless wedged turn should be swept");
      assert.equal(mine!.session, undefined, "null session maps to undefined");
      assert.equal(
        getActiveTurnId("sweep-nosess", undefined, "sweep-nosess"),
        undefined,
        "in-memory wildcard entry cleared",
      );
    });

    it("sweeps a quiet sessionless turn with no done, but not a quiet thread's", async () => {
      // Only a sessionless done closes a sessionless turn, and a template that tags only
      // its done never sends one: idleness is the only other end it can have.
      const bare = await createTurn("sweep-bare", undefined, "sweep-bare");
      const threaded = await createTurn("sweep-bare", "t1", "sweep-bare");
      const db = await getDb();
      for (const [id, thread] of [
        [bare, null],
        [threaded, "t1"],
      ] as const) {
        await db.insert(mindHistory).values({
          mind: "sweep-bare",
          type: "text",
          thread,
          turn_id: id,
          created_at: utcStamp(30 * 60_000),
        });
      }
      const swept = await sweepWedgedTurns(idleMs);
      assert.ok(
        swept.find((t) => t.turnId === bare),
        "quiet sessionless turn swept",
      );
      assert.equal(getActiveTurnId("sweep-bare", undefined, "sweep-bare"), undefined);
      assert.ok(!swept.find((t) => t.turnId === threaded), "a thread's turn waits for its done");
      assert.equal(getActiveTurnId("sweep-bare", "t1", "sweep-bare"), threaded);
      await clearMind("sweep-bare");
    });

    it("does NOT clobber the in-memory slot when a newer turn reused the session key", async () => {
      // The old turn is still `active` in the DB but no longer holds the in-memory slot;
      // a newer turn on the same session does.
      const oldId = "sweep-old-wsX";
      const db0 = await getDb();
      await db0
        .insert(turns)
        .values({ id: oldId, mind: "sweep-mind", thread: "wsX", status: "active" });
      for (const e of [
        { type: "text", msAgo: 30 * 60_000 },
        { type: "done", msAgo: 20 * 60_000 },
      ]) {
        await db0.insert(mindHistory).values({
          mind: "sweep-mind",
          type: e.type,
          thread: "wsX",
          turn_id: oldId,
          created_at: utcStamp(e.msAgo),
        });
      }
      const newId = await createTurn("sweep-mind", "wsX", "sweep-mind");
      assert.ok(newId);
      assert.equal(getActiveTurnId("sweep-mind", "wsX", "sweep-mind"), newId);

      const swept = await sweepWedgedTurns(idleMs);
      assert.ok(
        swept.find((t) => t.turnId === oldId),
        "old wedged turn swept",
      );

      const db = await getDb();
      const oldRow = await db.select().from(turns).where(eq(turns.id, oldId)).get();
      assert.equal(oldRow!.status, "complete");
      assert.equal(
        getActiveTurnId("sweep-mind", "wsX", "sweep-mind"),
        newId,
        "newer turn's in-memory entry must survive",
      );
      await clearMind("sweep-mind");
    });

    it("sweeps multiple wedged turns in one pass", async () => {
      const id1 = await seedTurn("wsm1", [
        { type: "text", msAgo: 40 * 60_000 },
        { type: "done", msAgo: 30 * 60_000 },
      ]);
      const id2 = await seedTurn("wsm2", [
        { type: "text", msAgo: 40 * 60_000 },
        { type: "done", msAgo: 30 * 60_000 },
      ]);

      const swept = await sweepWedgedTurns(idleMs);
      assert.ok(
        swept.find((t) => t.turnId === id1),
        "first turn swept",
      );
      assert.ok(
        swept.find((t) => t.turnId === id2),
        "second turn swept",
      );

      const db = await getDb();
      for (const id of [id1, id2]) {
        const row = await db.select().from(turns).where(eq(turns.id, id)).get();
        assert.equal(row!.status, "complete");
      }
    });
  });
});
