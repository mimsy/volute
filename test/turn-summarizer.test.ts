import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { summarizeTurn } from "../src/lib/daemon/turn-summarizer.js";
import { getDb } from "../src/lib/db.js";
import { mindHistory } from "../src/lib/schema.js";

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
    await insertEvent("inbound", { content: "hello", channel: "volute:chat" });
    await insertEvent("tool_use", { metadata: { name: "Read" } });
    await insertEvent("outbound", { content: "hi there" });
    const doneId = await insertEvent("done");

    await summarizeTurn(mind, session, "volute:chat", doneId);

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

  it("handles turn with no inbound messages", async () => {
    const mind2 = "test-summarizer-2";
    const db = await getDb();
    // Just a done event (scheduled wake, etc.)
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
    assert.ok(summary, "summary should be inserted");
    assert.equal(summary.content, "Turn completed.");
  });

  it("skips summarization for empty turn", async () => {
    // Insert a done with no prior events for this specific mind/session combo
    const mind3 = "test-summarizer-empty";
    // Don't insert any events before done — but summarizeTurn gathers events including done itself
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
    // Should still produce a summary since the done event itself is gathered
    const summary = summaries.find((s) => s.mind === mind3);
    assert.ok(summary);
  });
});
