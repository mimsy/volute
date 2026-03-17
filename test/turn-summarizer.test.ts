import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { and, eq } from "drizzle-orm";
import { summarizeTurn } from "../src/lib/daemon/turn-summarizer.js";
import { clearMind } from "../src/lib/daemon/turn-tracker.js";
import { getDb } from "../src/lib/db.js";
import { mindHistory, turns } from "../src/lib/schema.js";

describe("turn-summarizer", () => {
  const mind = "test-summarizer";
  const session = "test-session";

  async function insertEvent(
    type: string,
    opts?: { content?: string; channel?: string; metadata?: Record<string, unknown> },
  ) {
    const db = await getDb();
    const result = await db
      .insert(mindHistory)
      .values({
        mind,
        type,
        session,
        channel: opts?.channel ?? null,
        content: opts?.content ?? null,
        metadata: opts?.metadata ? JSON.stringify(opts.metadata) : null,
      })
      .returning({ id: mindHistory.id });
    return result[0].id;
  }

  it("generates deterministic summary for a basic turn", async () => {
    // Simulate a simple turn: inbound → tool_use → outbound → done
    await insertEvent("inbound", { content: "hello", channel: "@chat" });
    await insertEvent("tool_use", { metadata: { name: "Read" } });
    await insertEvent("outbound", { content: "hi there" });
    const doneId = await insertEvent("done");

    await summarizeTurn(mind, session, "@chat", doneId);

    // Check that a summary was inserted
    const db = await getDb();
    const summaries = await db.select().from(mindHistory).where(eq(mindHistory.type, "summary"));
    const summary = summaries.find((s) => s.mind === mind);
    assert.ok(summary, "summary should be inserted");
    assert.ok(summary.content, "summary should have content");
    assert.ok(summary.content!.includes("Received message"), "should mention received message");
    assert.ok(summary.content!.includes("Read"), "should mention tool name");
    assert.ok(summary.content!.includes("Sent response"), "should mention sent response");

    // Check metadata
    const meta = JSON.parse(summary.metadata!);
    assert.equal(meta.deterministic, true);
    assert.equal(meta.tool_count, 1);
    assert.deepEqual(meta.tools, ["Read"]);
    assert.ok(meta.from_id);
    assert.ok(meta.to_id);
    assert.ok(meta.from_time);
    assert.ok(meta.to_time);
  });

  it("skips summary for turn with no substantive output", async () => {
    const mind2 = "test-summarizer-2";
    const db = await getDb();
    // Just a done event (scheduled wake, interrupted turn, etc.)
    const result = await db
      .insert(mindHistory)
      .values({
        mind: mind2,
        type: "done",
        session: "s2",
        channel: null,
        content: null,
        metadata: null,
      })
      .returning({ id: mindHistory.id });

    await summarizeTurn(mind2, "s2", undefined, result[0].id);

    const summaries = await db.select().from(mindHistory).where(eq(mindHistory.type, "summary"));
    const summary = summaries.find((s) => s.mind === mind2);
    assert.equal(summary, undefined, "no summary should be inserted for empty turn");
  });

  it("uses turn_id-based query when turnId is provided", async () => {
    const mind4 = "test-summarizer-turnid";
    const session4 = "s4";
    const turnId = `test-turn-${Date.now()}`;
    const db = await getDb();

    // Create a turn row
    await db.insert(turns).values({ id: turnId, mind: mind4, session: session4, status: "active" });

    // Insert events tagged with the turn_id
    await db.insert(mindHistory).values({
      mind: mind4,
      type: "inbound",
      session: session4,
      channel: "@test",
      content: "hello from turn",
      turn_id: turnId,
    });
    await db.insert(mindHistory).values({
      mind: mind4,
      type: "tool_use",
      session: session4,
      metadata: JSON.stringify({ name: "Write" }),
      turn_id: turnId,
    });
    const doneResult = await db
      .insert(mindHistory)
      .values({
        mind: mind4,
        type: "done",
        session: session4,
        turn_id: turnId,
      })
      .returning({ id: mindHistory.id });

    await summarizeTurn(mind4, session4, "@test", doneResult[0].id, turnId);

    const summaries = await db
      .select()
      .from(mindHistory)
      .where(and(eq(mindHistory.type, "summary"), eq(mindHistory.mind, mind4)));
    assert.equal(summaries.length, 1);
    const summary = summaries[0];
    assert.ok(summary.content!.includes("Received message"), "should mention received message");
    assert.ok(summary.content!.includes("Write"), "should mention tool name");

    // Summary should be tagged with turn_id
    assert.equal(summary.turn_id, turnId);

    // Turn should have summary_event_id set (async, give it a moment)
    await new Promise((r) => setTimeout(r, 50));
    const turnRow = await db.select().from(turns).where(eq(turns.id, turnId)).get();
    assert.equal(turnRow!.summary_event_id, summary.id);

    await clearMind(mind4);
  });

  it("skips summarization for empty turn", async () => {
    // Insert a done with no prior events for this specific mind/session combo
    const mind3 = "test-summarizer-empty";
    const db = await getDb();
    const result = await db
      .insert(mindHistory)
      .values({
        mind: mind3,
        type: "done",
        session: "empty",
        channel: null,
        content: null,
        metadata: null,
      })
      .returning({ id: mindHistory.id });

    await summarizeTurn(mind3, "empty", undefined, result[0].id);

    const summaries = await db.select().from(mindHistory).where(eq(mindHistory.type, "summary"));
    const summary = summaries.find((s) => s.mind === mind3);
    assert.equal(summary, undefined, "no summary should be inserted for empty turn");
  });
});
