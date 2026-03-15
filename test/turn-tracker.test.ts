import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { eq } from "drizzle-orm";
import {
  assignSession,
  clearMind,
  completeTurn,
  createTurn,
  getActiveTurnId,
  getLastToolUseEventId,
  setSummaryEventId,
  trackToolUse,
} from "../src/lib/daemon/turn-tracker.js";
import { getDb } from "../src/lib/db.js";
import { turns } from "../src/lib/schema.js";

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

  it("sets summary_event_id", async () => {
    const turnId = await createTurn(mind);
    await setSummaryEventId(turnId, 123);

    const db = await getDb();
    const row = await db.select().from(turns).where(eq(turns.id, turnId)).get();
    assert.equal(row!.summary_event_id, 123);

    await clearMind(mind);
  });

  it("clearMind removes all entries for the mind", async () => {
    const turnId = await createTurn(mind);
    await assignSession(mind, turnId, "s1");

    // Create another turn for a different mind
    const otherMind = "test-turn-tracker-other";
    const otherId = await createTurn(otherMind);

    await clearMind(mind);
    assert.equal(getActiveTurnId(mind, "s1"), undefined);
    assert.equal(getActiveTurnId(otherMind), otherId, "other mind should be unaffected");

    await clearMind(otherMind);
  });
});
