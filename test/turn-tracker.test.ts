import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { eq } from "drizzle-orm";
import {
  assignSession,
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
    const turnId = await createTurn(mind);
    assert.ok(turnId, "should return a turn ID");

    const db = await getDb();
    const row = await db.select().from(turns).where(eq(turns.id, turnId)).get();
    assert.ok(row, "turn should exist in DB");
    assert.equal(row!.mind, mind);
    assert.equal(row!.status, "active");
    assert.equal(row!.session, null);

    // Cleanup
    await clearMind(mind);
  });

  it("reuses existing active turn for same mind", async () => {
    const id1 = await createTurn(mind);
    const id2 = await createTurn(mind);
    assert.equal(id1, id2, "should reuse the same turn");

    await clearMind(mind);
  });

  it("getActiveTurnId returns the active turn", async () => {
    const turnId = await createTurn(mind);
    assert.equal(getActiveTurnId(mind), turnId);
    assert.equal(getActiveTurnId(mind, null), turnId, "should fall back to wildcard");

    await clearMind(mind);
  });

  it("assigns session and re-keys", async () => {
    const turnId = await createTurn(mind);
    assert.equal(getActiveTurnId(mind), turnId);

    await assignSession(mind, turnId, "sess-1");

    // Should now be keyed by session
    assert.equal(getActiveTurnId(mind, "sess-1"), turnId);
    // Wildcard should no longer resolve
    assert.equal(getActiveTurnId(mind), undefined);

    // DB should reflect session
    const db = await getDb();
    const row = await db.select().from(turns).where(eq(turns.id, turnId)).get();
    assert.equal(row!.session, "sess-1");

    await clearMind(mind);
  });

  it("tracks tool_use event IDs", async () => {
    await createTurn(mind);

    assert.equal(getLastToolUseEventId(mind), undefined);

    trackToolUse(mind, null, 42);
    assert.equal(getLastToolUseEventId(mind), 42);

    trackToolUse(mind, null, 99);
    assert.equal(getLastToolUseEventId(mind), 99);

    await clearMind(mind);
  });

  it("getToolUseEventId resolves the matching tool_use by SDK id", async () => {
    await createTurn(mind);

    // Two tool calls in one turn (e.g. parallel), tracked with their SDK ids.
    trackToolUse(mind, null, 10, "toolu_a");
    trackToolUse(mind, null, 11, "toolu_b");

    // A result must link to its OWN tool_use, not just the most recent one.
    assert.equal(getToolUseEventId(mind, null, "toolu_a"), 10);
    assert.equal(getToolUseEventId(mind, null, "toolu_b"), 11);

    await clearMind(mind);
  });

  it("getToolUseEventId falls back to the last tool_use when id is absent/unknown", async () => {
    await createTurn(mind);

    trackToolUse(mind, null, 10, "toolu_a");
    trackToolUse(mind, null, 11, "toolu_b");

    // No id (older template) → last tool_use.
    assert.equal(getToolUseEventId(mind, null), 11);
    // Unknown id → last tool_use.
    assert.equal(getToolUseEventId(mind, null, "toolu_missing"), 11);

    await clearMind(mind);
  });

  it("completes a turn", async () => {
    const turnId = await createTurn(mind);
    const completedId = await completeTurn(mind);

    assert.equal(completedId, turnId);
    assert.equal(getActiveTurnId(mind), undefined);

    const db = await getDb();
    const row = await db.select().from(turns).where(eq(turns.id, turnId)).get();
    assert.equal(row!.status, "complete");
  });

  it("completeTurn returns undefined when no active turn", async () => {
    const result = await completeTurn("nonexistent-mind");
    assert.equal(result, undefined);
  });

  it("clearMind removes all entries and returns orphaned turns", async () => {
    const turnId = await createTurn(mind);
    await assignSession(mind, turnId!, "s1");

    // Create another turn for a different mind
    const otherMind = "test-turn-tracker-other";
    const otherId = await createTurn(otherMind);

    const orphaned = await clearMind(mind);
    assert.equal(getActiveTurnId(mind, "s1"), undefined);
    assert.equal(getActiveTurnId(otherMind), otherId, "other mind should be unaffected");

    assert.equal(orphaned.length, 1);
    assert.equal(orphaned[0].turnId, turnId);
    assert.equal(orphaned[0].session, "s1");

    await clearMind(otherMind);
  });

  it("clearMind returns wildcard session as undefined", async () => {
    const turnId = await createTurn(mind);
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
    await db.insert(turns).values({ id: turn1, mind: "mind-a", session: "s1", status: "active" });
    await db.insert(turns).values({ id: turn2, mind: "mind-b", session: null, status: "active" });

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
    markErrored("errmind", "s1");
    assert.equal(takeErrored("errmind", "s1"), true);
    assert.equal(takeErrored("errmind", "s1"), false);
  });

  it("errored flag is per (mind, session)", () => {
    markErrored("errmind", "s1");
    assert.equal(takeErrored("errmind", "s2"), false, "different session unaffected");
    assert.equal(takeErrored("other", "s1"), false, "different mind unaffected");
    assert.equal(takeErrored("errmind", "s1"), true);
  });

  it("clearMind drops a pending errored flag for that mind only", async () => {
    markErrored("errmind", "s1");
    markErrored("keepmind", "s1");
    await clearMind("errmind");
    assert.equal(takeErrored("errmind", "s1"), false, "cleared on crash/stop");
    assert.equal(takeErrored("keepmind", "s1"), true, "other mind's flag intact");
  });

  describe("sweepWedgedTurns", () => {
    const idleMs = 10 * 60_000;

    // Create a real (in-memory + DB) turn for `sweep-mind`, assign it a session, and
    // attach mind_history events at the given ages. Returns the real turn id.
    async function seedTurn(
      sess: string,
      events: { type: string; msAgo: number }[],
    ): Promise<string> {
      const id = await createTurn("sweep-mind");
      assert.ok(id);
      await assignSession("sweep-mind", id!, sess);
      const db = await getDb();
      for (const e of events) {
        await db.insert(mindHistory).values({
          mind: "sweep-mind",
          type: e.type,
          session: sess,
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
      assert.equal(getActiveTurnId("sweep-mind", "ws1"), id, "turn is active in memory");

      const swept = await sweepWedgedTurns(idleMs);
      const mine = swept.find((t) => t.turnId === id);
      assert.ok(mine, "wedged turn should be swept");
      assert.equal(mine!.mind, "sweep-mind");
      assert.equal(mine!.session, "ws1");

      const db = await getDb();
      const row = await db.select().from(turns).where(eq(turns.id, id)).get();
      assert.equal(row!.status, "complete", "turn should be marked complete");
      assert.equal(getActiveTurnId("sweep-mind", "ws1"), undefined, "in-memory entry cleared");
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
      const id = await createTurn("sweep-nosess");
      assert.ok(id);
      const db = await getDb();
      for (const e of [
        { type: "text", msAgo: 30 * 60_000 },
        { type: "done", msAgo: 20 * 60_000 },
      ]) {
        await db.insert(mindHistory).values({
          mind: "sweep-nosess",
          type: e.type,
          session: null,
          turn_id: id,
          created_at: utcStamp(e.msAgo),
        });
      }

      const swept = await sweepWedgedTurns(idleMs);
      const mine = swept.find((t) => t.turnId === id);
      assert.ok(mine, "sessionless wedged turn should be swept");
      assert.equal(mine!.session, undefined, "null session maps to undefined");
      assert.equal(getActiveTurnId("sweep-nosess"), undefined, "in-memory wildcard entry cleared");
    });

    it("does NOT clobber the in-memory slot when a newer turn reused the session key", async () => {
      const oldId = await seedTurn("wsX", [
        { type: "text", msAgo: 30 * 60_000 },
        { type: "done", msAgo: 20 * 60_000 },
      ]);
      // A newer turn opens on the same session and reuses the mind:session slot.
      const newId = await createTurn("sweep-mind");
      assert.ok(newId);
      await assignSession("sweep-mind", newId!, "wsX");
      assert.equal(getActiveTurnId("sweep-mind", "wsX"), newId);

      const swept = await sweepWedgedTurns(idleMs);
      assert.ok(
        swept.find((t) => t.turnId === oldId),
        "old wedged turn swept",
      );

      const db = await getDb();
      const oldRow = await db.select().from(turns).where(eq(turns.id, oldId)).get();
      assert.equal(oldRow!.status, "complete");
      assert.equal(
        getActiveTurnId("sweep-mind", "wsX"),
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
