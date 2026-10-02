import assert from "node:assert/strict";
import { afterEach, before, describe, it } from "node:test";
import { and, eq, sql } from "drizzle-orm";
import { drainEvents } from "../packages/daemon/src/lib/chat/system-events.js";
import { getTypingMap } from "../packages/daemon/src/lib/chat/typing.js";
import { getSpendBudget, initSpendBudget } from "../packages/daemon/src/lib/daemon/spend-budget.js";
import {
  reconcileWedgedTurns,
  summarizeTurn,
} from "../packages/daemon/src/lib/daemon/summarizer.js";
import { handleMindEvent } from "../packages/daemon/src/lib/daemon/turn-lifecycle.js";
import { releaseTurnSlot } from "../packages/daemon/src/lib/daemon/turn-slots.js";
import {
  adoptInterrupted,
  clearMind,
  closedTurnFor,
  completeTurn,
  getActiveTurnId,
  holdInterrupted,
  linkRowsToTurn,
  markClosing,
  markInterrupted,
  openDeliveredTurn,
  runningTurnOf,
  unlinkRefused,
  unmarkInterrupted,
  wasInterrupted,
} from "../packages/daemon/src/lib/daemon/turn-tracker.js";
import { getDb } from "../packages/daemon/src/lib/db.js";
import {
  recordInbound,
  recordOutbound,
  turnStamp,
} from "../packages/daemon/src/lib/delivery/message-delivery.js";
import { subscribe as subscribeActivity } from "../packages/daemon/src/lib/events/activity-events.js";
import {
  type ConversationEvent,
  subscribe,
} from "../packages/daemon/src/lib/events/conversation-events.js";
import { mindHistory, summaries, systemEvents, turns } from "../packages/daemon/src/lib/schema.js";

/** What a delivery that found the slot taken does before its POST (`enterTurn`). */
async function fold(
  mind: string,
  session: string,
  process: string,
  rows: (number | undefined)[],
): Promise<void> {
  const running = runningTurnOf(mind, session, process);
  if (running) await linkRowsToTurn(running, rows, { trigger: false });
}

async function waitFor<T>(read: () => T | Promise<T>): Promise<T> {
  const deadline = Date.now() + 3000;
  for (;;) {
    const v = await read();
    if (v || Date.now() > deadline) return v;
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function cleanup(mind: string): Promise<void> {
  releaseTurnSlot(mind);
  await clearMind(mind);
  const db = await getDb();
  await db.delete(mindHistory).where(eq(mindHistory.mind, mind));
  await db.delete(turns).where(eq(turns.mind, mind));
  await db.delete(systemEvents).where(eq(systemEvents.mind, mind));
}

describe("turn-lifecycle: handleMindEvent", () => {
  before(() => {
    // usage events accrue against the spend budget singleton.
    try {
      initSpendBudget();
    } catch {
      // already initialized by another test in this process
    }
  });

  it("session_start never adopts a sessionless turn into a thread (#1173)", async () => {
    const mind = "tl-session-start";
    // A sessionless turn opens on the first substantive event without a session.
    await handleMindEvent(mind, { type: "tool_use", content: "x" });
    const sessionless = getActiveTurnId(mind);
    assert.ok(sessionless, "sessionless turn should exist");

    // A thread starting is not evidence the sessionless events were its own.
    await handleMindEvent(mind, { type: "session_start", session: "s1" });
    assert.equal(getActiveTurnId(mind, "s1"), undefined);
    assert.equal(getActiveTurnId(mind), sessionless);

    // The thread's own first substantive event opens its own turn, recorded with it.
    const { turnId } = await handleMindEvent(mind, { type: "text", session: "s1", content: "y" });
    assert.ok(turnId && turnId !== sessionless);
    const db = await getDb();
    const row = await db.select().from(turns).where(eq(turns.id, turnId!)).get();
    assert.equal(row!.thread, "s1");
    await cleanup(mind);
  });

  it("tool_use creates a turn and persists the event tagged with it", async () => {
    const mind = "tl-tool-use";
    const { turnId, insertedId } = await handleMindEvent(mind, {
      type: "tool_use",
      session: "s1",
      content: "bash ls",
    });
    assert.ok(turnId, "tool_use should create a turn");
    assert.equal(getActiveTurnId(mind, "s1"), turnId);

    const db = await getDb();
    const row = await db.select().from(mindHistory).where(eq(mindHistory.id, insertedId!)).get();
    assert.equal(row!.type, "tool_use");
    assert.equal(row!.turn_id, turnId);
    assert.equal(row!.thread, "s1");
    await cleanup(mind);
  });

  it("text creates a turn and links the pending inbound as the trigger", async () => {
    const mind = "tl-text-trigger";
    // Inbound arrives first (no turn yet), then the mind starts a turn on the same channel.
    const inboundId = await recordInbound(mind, "@alice", "alice", null, "hello");
    const { turnId } = await handleMindEvent(mind, {
      type: "text",
      session: "s1",
      channel: "@alice",
      content: "hi back",
    });
    assert.ok(turnId);

    const db = await getDb();
    const inbound = await db.select().from(mindHistory).where(eq(mindHistory.id, inboundId!)).get();
    assert.equal(inbound!.turn_id, turnId, "inbound should be tagged with the new turn");
    const turn = await db.select().from(turns).where(eq(turns.id, turnId!)).get();
    assert.equal(turn!.trigger_event_id, inboundId, "turn trigger should point at the inbound");
    await cleanup(mind);
  });

  it("done completes the active turn", async () => {
    const mind = "tl-done";
    const { turnId } = await handleMindEvent(mind, {
      type: "tool_use",
      session: "s1",
      content: "x",
    });
    assert.ok(getActiveTurnId(mind, "s1"));

    await handleMindEvent(mind, { type: "done", session: "s1" });
    assert.equal(getActiveTurnId(mind, "s1"), undefined, "turn should be cleared after done");

    const db = await getDb();
    const row = await db.select().from(turns).where(eq(turns.id, turnId!)).get();
    assert.equal(row!.status, "complete");
    await cleanup(mind);
  });

  it("error records a turn_error notice for the session", async () => {
    const mind = "tl-error";
    await handleMindEvent(mind, { type: "tool_use", session: "s1", content: "x" });
    await handleMindEvent(mind, {
      type: "error",
      session: "s1",
      content: "boom: something failed",
    });

    const notices = await drainEvents(mind, "s1");
    assert.ok(
      notices.some((n) => JSON.parse(n.meta ?? "{}").subtype === "turn_error"),
      "a turn_error notice should be recorded",
    );
    await cleanup(mind);
  });

  it("events drained mid-outage survive an errored turn and clear only on a clean one", async () => {
    // The exactly-once machinery: the pre-prompt hook drains (recording what it drained);
    // a clean `done` marks the drained events delivered, but an errored turn must NOT —
    // failures accumulate until the mind demonstrably completes a turn.
    const { drainNotices } = await import("../packages/daemon/src/lib/daemon/turn-lifecycle.js");
    const { recordNotice } = await import("../packages/daemon/src/lib/chat/system-events.js");
    const mind = "tl-errored-redelivery";

    await recordNotice({
      mind,
      thread: "s1",
      kind: "turn_error",
      reason: "network",
      detail: "flaky",
    });

    // Turn 1: drains the notice, then errors — the notice must survive.
    let drained = await drainNotices(mind, "s1", mind);
    assert.equal(drained.length, 1);
    await handleMindEvent(mind, { type: "text", session: "s1", content: "trying…" });
    await handleMindEvent(mind, { type: "error", session: "s1", content: "boom again" });
    await handleMindEvent(mind, { type: "done", session: "s1" });

    drained = await drainNotices(mind, "s1", mind);
    assert.ok(
      drained.some((n) => n.body === "flaky"),
      "the drained notice must be redelivered after an errored turn",
    );

    // Turn 2: that drain was its own, and it completes cleanly — everything drained clears.
    await handleMindEvent(mind, { type: "text", session: "s1", content: "recovered" });
    await handleMindEvent(mind, { type: "done", session: "s1" });
    // The clear runs fire-and-forget on done; poll briefly.
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && (await drainEvents(mind, "s1")).length > 0) {
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.deepEqual(await drainEvents(mind, "s1"), [], "clean turn clears the drained events");
    await cleanup(mind);
  });

  it("error broadcasts a mind_error activity event", async () => {
    const mind = "tl-error-broadcast";
    const received: { type: string; mind: string }[] = [];
    const unsubscribe = subscribeActivity((e) => {
      received.push({ type: e.type, mind: e.mind });
    });
    try {
      await handleMindEvent(mind, {
        type: "error",
        session: "s1",
        content: "boom: something failed",
      });
    } finally {
      unsubscribe();
    }
    assert.ok(
      received.some((e) => e.type === "mind_error" && e.mind === mind),
      "a mind_error event should be broadcast so web chat can refresh status",
    );
    await cleanup(mind);
  });

  it("usage accrues against the spend budget", async () => {
    const mind = "tl-usage";
    await handleMindEvent(mind, {
      type: "usage",
      session: "s1",
      metadata: { input_tokens: 100, output_tokens: 50 },
    });
    // No throw is the primary assertion; the budget singleton recorded the usage.
    await cleanup(mind);
  });

  /** The metadata JSON persisted for a mind's single usage row. */
  async function readUsageMetadata(mind: string): Promise<Record<string, unknown>> {
    const db = await getDb();
    const row = await db
      .select({ metadata: mindHistory.metadata })
      .from(mindHistory)
      .where(and(eq(mindHistory.mind, mind), eq(mindHistory.type, "usage")))
      .get();
    assert.ok(row?.metadata, "usage row should have been persisted with metadata");
    return JSON.parse(row.metadata);
  }

  it("prices a usage event into the persisted metadata", async () => {
    const mind = "tl-usage-priced";
    await handleMindEvent(mind, {
      type: "usage",
      session: "s1",
      metadata: {
        input_tokens: 2_000,
        output_tokens: 500,
        cache_read_input_tokens: 30_000,
        cache_creation_input_tokens: 4_000,
        model: "anthropic:claude-haiku-4-5",
      },
    });

    const meta = await readUsageMetadata(mind);
    assert.equal(meta.model, "anthropic:claude-haiku-4-5");
    assert.equal(meta.partial, undefined);
    assert.equal(meta.cost_usd, (2000 * 1 + 500 * 5 + 30000 * 0.1 + 4000 * 1.25) / 1e6);
    // The token counts survive untouched alongside the cost.
    assert.equal(meta.input_tokens, 2_000);
    assert.equal(meta.cache_read_input_tokens, 30_000);
    await cleanup(mind);
  });

  it("marks an un-upgraded mind's two-field usage partial and unpriced", async () => {
    // Minds run their own copy of src/ until `volute mind upgrade`, so the old shape
    // keeps arriving. It must never be persisted as a fabricated cost.
    const mind = "tl-usage-partial";
    await handleMindEvent(mind, {
      type: "usage",
      session: "s1",
      metadata: { input_tokens: 913, output_tokens: 112_916, model: "anthropic:claude-haiku-4-5" },
    });

    const meta = await readUsageMetadata(mind);
    assert.equal(meta.partial, true);
    assert.equal(meta.cost_usd, null);
    await cleanup(mind);
  });

  it("records cost_usd null when no model can be resolved", async () => {
    // No model on the event, no registry row, no config.json — nothing to price against.
    const mind = "tl-usage-unpriced";
    await handleMindEvent(mind, {
      type: "usage",
      session: "s1",
      metadata: {
        input_tokens: 10,
        output_tokens: 2,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    });

    const meta = await readUsageMetadata(mind);
    assert.equal(meta.cost_usd, null);
    assert.equal(meta.model, undefined);
    await cleanup(mind);
  });

  it("leaves non-usage events' metadata alone", async () => {
    const mind = "tl-usage-untouched";
    await handleMindEvent(mind, {
      type: "tool_use",
      session: "s1",
      content: "{}",
      metadata: { name: "Bash", id: "tu1" },
    });
    const db = await getDb();
    const row = await db
      .select({ metadata: mindHistory.metadata })
      .from(mindHistory)
      .where(and(eq(mindHistory.mind, mind), eq(mindHistory.type, "tool_use")))
      .get();
    assert.deepEqual(JSON.parse(row?.metadata ?? "{}"), { name: "Bash", id: "tu1" });
    await cleanup(mind);
  });

  it("typing persists through mid-turn text/outbound and clears on done", async () => {
    const mind = "tl-typing-persist";
    const convId = "11111111-2222-3333-4444-555555555555";
    const map = getTypingMap();
    // Delivery marks the mind typing in the triggering conversation (slug + conv-id keys).
    map.set("@creator", mind, { persistent: true });
    map.set(convId, mind, { persistent: true });

    // Mid-turn output — even on a different channel — must not clear typing.
    await handleMindEvent(mind, {
      type: "text",
      session: "s1",
      channel: "#elsewhere",
      content: "thinking out loud",
    });
    assert.deepEqual(map.get("@creator"), [mind], "typing should survive mid-turn text");

    await handleMindEvent(mind, {
      type: "outbound",
      session: "s1",
      channel: "#elsewhere",
      content: "sent something",
    });
    assert.deepEqual(map.get("@creator"), [mind], "typing should survive mid-turn outbound");

    // Turn end clears typing everywhere AND publishes the update to the conversation —
    // the client relies on this event to drop the indicator (it no longer self-expires
    // mind typing), so the publish is load-bearing, not just the map clear.
    const received: ConversationEvent[] = [];
    const unsub = subscribe(convId, (e) => received.push(e));
    await handleMindEvent(mind, { type: "done", session: "s1" });
    unsub();
    assert.deepEqual(map.get("@creator"), [], "typing should clear on done");
    assert.deepEqual(map.get(convId), []);
    const typingEvents = received.filter((e) => e.type === "typing");
    assert.ok(typingEvents.length > 0, "done should publish a typing update to the conversation");
    assert.ok(
      typingEvents.every((e) => !e.senders.includes(mind)),
      "published senders must not include the mind after done",
    );
    await cleanup(mind);
  });

  it("tool_result marker links an outbound when no session attribution happened (fallback)", async () => {
    const mind = "tl-marker-fallback";
    // Outbound recorded from thread s1 before s1 had an active turn: no turn_id yet.
    const outboundId = await recordOutbound(mind, "@bob", "sent via CLI", { thread: "s1" });
    // The turn opens on its thread, then the tool_result carries the correlation marker.
    await handleMindEvent(mind, { type: "tool_use", session: "s1", content: "volute chat send" });
    const turnId = getActiveTurnId(mind, "s1");
    await handleMindEvent(mind, {
      type: "tool_result",
      session: "s1",
      content: `Message sent.\n[volute:outbound:${outboundId}]`,
    });

    const db = await getDb();
    const row = await db.select().from(mindHistory).where(eq(mindHistory.id, outboundId!)).get();
    assert.equal(row!.turn_id, turnId, "marker fallback should attribute the outbound to the turn");
    assert.equal(row!.thread, "s1");
    await cleanup(mind);
  });
});

describe("turn-lifecycle: a delivery's rows link to its turn", () => {
  it("tags an inbound folded in mid-turn to the in-progress turn, without touching the trigger", async () => {
    const mind = "tl-midturn";
    // A turn is already active for (mind, s1, @alice), triggered by an earlier inbound.
    const triggerId = await recordInbound(mind, "@alice", "alice", null, "first");
    const { turnId } = await handleMindEvent(mind, {
      type: "text",
      session: "s1",
      channel: "@alice",
      content: "on it",
    });
    assert.ok(turnId);

    // A new message is delivered on the same thread WHILE the turn is still active.
    const interruptId = await recordInbound(mind, "@alice", "alice", null, "actually, wait");
    await fold(mind, "s1", mind, [interruptId]);

    const db = await getDb();
    const after = await db.select().from(mindHistory).where(eq(mindHistory.id, interruptId!)).get();
    assert.equal(after!.turn_id, turnId, "mid-turn inbound must be tagged to the active turn");
    assert.equal(getActiveTurnId(mind, "s1"), turnId, "no second turn is opened");

    // The turn's trigger stays the original triggering inbound — a mid-turn message is not a trigger.
    const turn = await db.select().from(turns).where(eq(turns.id, turnId!)).get();
    assert.equal(turn!.trigger_event_id, triggerId, "trigger_event_id must not be overwritten");
    await cleanup(mind);
  });

  it("tags every message of a batch folded in mid-turn", async () => {
    const mind = "tl-midturn-backlog";
    const { turnId } = await handleMindEvent(mind, {
      type: "text",
      session: "s1",
      channel: "@alice",
      content: "working",
    });
    assert.ok(turnId);

    const ids: number[] = [];
    for (let i = 0; i < 7; i++) {
      const id = await recordInbound(mind, "@alice", "alice", null, `msg ${i}`);
      ids.push(id!);
    }
    await fold(mind, "s1", mind, ids);

    const db = await getDb();
    for (const id of ids) {
      const row = await db.select().from(mindHistory).where(eq(mindHistory.id, id)).get();
      assert.equal(row!.turn_id, turnId, `inbound ${id} must be tagged (not left NULL)`);
    }
    await cleanup(mind);
  });

  it("a folded delivery opens nothing when no turn of its process is running", async () => {
    const mind = "tl-folded-noturn";
    const inboundId = await recordInbound(mind, "@alice", "alice", null, "hello");
    await fold(mind, "s1", mind, [inboundId]);
    assert.equal(getActiveTurnId(mind, "s1"), undefined);
    await cleanup(mind);
  });

  it("a delivery that takes the slot opens its turn, with its row as the trigger", async () => {
    const mind = "tl-delivery-opens";
    const inboundId = await recordInbound(mind, "@alice", "alice", null, "hello");
    const opened = await openDeliveredTurn(mind, "s1", mind);
    assert.ok(opened?.created);
    await linkRowsToTurn(opened!.turnId, [inboundId]);

    assert.equal(getActiveTurnId(mind, "s1"), opened!.turnId);
    const db = await getDb();
    const row = await db.select().from(mindHistory).where(eq(mindHistory.id, inboundId!)).get();
    assert.equal(row!.turn_id, opened!.turnId);
    const turn = await db.select().from(turns).where(eq(turns.id, opened!.turnId)).get();
    assert.equal(turn!.trigger_event_id, inboundId);
    assert.equal(turn!.thread, "s1");

    // The mind's first event joins it rather than opening a second.
    const { turnId: eventTurn } = await handleMindEvent(mind, {
      type: "text",
      session: "s1",
      channel: "@alice",
      content: "hi",
    });
    assert.equal(eventTurn, opened!.turnId);
    assert.equal((await db.select().from(turns).where(eq(turns.mind, mind)).all()).length, 1);
    await cleanup(mind);
  });

  it("links only the delivery's own rows — never the channel's older untagged history", async () => {
    const mind = "tl-delivery-exact";
    const db = await getDb();
    // Months of untagged history on the same channel, and a row on another channel.
    const [old] = await db
      .insert(mindHistory)
      .values({
        mind,
        type: "inbound",
        channel: "@alice",
        content: "from long ago",
        created_at: "2026-01-01 00:00:00",
      })
      .returning({ id: mindHistory.id });
    const otherId = await recordInbound(mind, "@bob", "bob", null, "unrelated");
    const strayId = await recordInbound(mind, "@alice", "alice", null, "never delivered");
    const deliveredId = await recordInbound(mind, "@alice", "alice", null, "hello");

    const opened = await openDeliveredTurn(mind, "@alice", mind);
    await linkRowsToTurn(opened!.turnId, [deliveredId]);

    const turnOf = async (id: number) =>
      (await db.select().from(mindHistory).where(eq(mindHistory.id, id)).get())!.turn_id;
    assert.equal(await turnOf(deliveredId!), opened!.turnId);
    assert.equal(await turnOf(old.id), null, "old history is not swept into the turn");
    assert.equal(await turnOf(strayId!), null, "an undelivered row is not swept either");
    assert.equal(await turnOf(otherId!), null, "another channel's row stays untagged");
    await cleanup(mind);
  });

  it("a variant's delivery on its parent's thread neither joins nor takes the parent's turn", async () => {
    const mind = "tl-delivery-variant";
    const { turnId } = await handleMindEvent(mind, {
      type: "text",
      session: "s1",
      channel: "@alice",
      content: "parent working",
    });
    assert.ok(turnId);
    const inboundId = await recordInbound(mind, "@alice", "alice", null, "for the variant");
    assert.equal(await openDeliveredTurn(mind, "s1", `${mind}-v`), undefined);
    await fold(mind, "s1", `${mind}-v`, [inboundId]);

    assert.equal(getActiveTurnId(mind, "s1"), turnId, "the parent's turn is untouched");
    const db = await getDb();
    const row = await db.select().from(mindHistory).where(eq(mindHistory.id, inboundId!)).get();
    assert.equal(row!.turn_id, null, "the variant's message is not linked into the parent's turn");
    await cleanup(mind);
  });

  it("the trigger is the first row in the order given, never one another turn holds", async () => {
    const mind = "tl-delivery-trigger";
    const db = await getDb();
    const heldId = await recordInbound(mind, "@alice", "alice", null, "an earlier turn's");
    await db.update(mindHistory).set({ turn_id: "earlier" }).where(eq(mindHistory.id, heldId!));
    const laterId = await recordInbound(mind, "@alice", "alice", null, "recorded second");
    const riderId = await recordInbound(mind, "@alice", "alice", null, "recorded last, sent first");
    const opened = await openDeliveredTurn(mind, "s1", mind);
    await linkRowsToTurn(opened!.turnId, [heldId, riderId, laterId]);
    const turn = await db.select().from(turns).where(eq(turns.id, opened!.turnId)).get();
    assert.equal(turn!.trigger_event_id, riderId);
    await cleanup(mind);
  });

  it("a turn opened for a delivery the mind never took is taken back whole", async () => {
    const mind = "tl-delivery-discard";
    const inboundId = await recordInbound(mind, "@alice", "alice", null, "hello");
    const opened = await openDeliveredTurn(mind, "s1", mind);
    await linkRowsToTurn(opened!.turnId, [inboundId]);
    await unlinkRefused(mind, "s1", opened!.turnId, [inboundId], true);

    assert.equal(getActiveTurnId(mind, "s1"), undefined);
    const db = await getDb();
    assert.equal((await db.select().from(turns).where(eq(turns.mind, mind)).all()).length, 0);
    const row = await db.select().from(mindHistory).where(eq(mindHistory.id, inboundId!)).get();
    assert.equal(row!.turn_id, null, "the row waits for the delivery that reaches the mind");
    await cleanup(mind);
  });

  it("a refused delivery's turn is gone before the next delivery can join it", async () => {
    const mind = "tl-delivery-refused-next";
    const refused = await openDeliveredTurn(mind, "s1", mind);
    const taking = unlinkRefused(mind, "s1", refused!.turnId, [], true);
    // The refusal freed the slot; the next delivery takes it at once.
    const next = await openDeliveredTurn(mind, "s1", mind);
    await taking;
    assert.ok(next?.created && next.turnId !== refused!.turnId);
    const db = await getDb();
    assert.ok(await db.select().from(turns).where(eq(turns.id, next!.turnId)).get());
    assert.equal(
      await db.select().from(turns).where(eq(turns.id, refused!.turnId)).get(),
      undefined,
    );
    await cleanup(mind);
  });

  it("a refused delivery leaves a turn the mind is already working in, and its rows", async () => {
    const mind = "tl-delivery-refused-busy";
    const triggerId = await recordInbound(mind, "@alice", "alice", null, "first");
    const opened = await openDeliveredTurn(mind, "s1", mind);
    await linkRowsToTurn(opened!.turnId, [triggerId]);
    const { insertedId: textId } = await handleMindEvent(mind, {
      type: "text",
      session: "s1",
      content: "working on it",
    });
    const foldedId = await recordInbound(mind, "@bob", "bob", null, "refused");
    await fold(mind, "s1", mind, [foldedId]);
    await unlinkRefused(mind, "s1", opened!.turnId, [foldedId], false);

    const db = await getDb();
    const turnOf = async (id: number) =>
      (await db.select().from(mindHistory).where(eq(mindHistory.id, id)).get())!.turn_id;
    assert.equal(await turnOf(foldedId!), null, "only the refused delivery's row leaves");
    assert.equal(await turnOf(triggerId!), opened!.turnId);
    assert.equal(await turnOf(textId!), opened!.turnId, "the mind's own rows are never touched");
    assert.equal(getActiveTurnId(mind, "s1"), opened!.turnId);
    await cleanup(mind);
  });

  it("a delivery while the last turn's completion is being recorded opens its own turn", async () => {
    const mind = "tl-delivery-closing";
    const first = await openDeliveredTurn(mind, "s1", mind);
    // Its done has arrived: the slot went to the next delivery before the turn completed.
    markClosing(mind, "s1", first!.turnId, ["d1"]);
    const next = await openDeliveredTurn(mind, "s1", mind);
    assert.ok(next?.created && next.turnId !== first!.turnId, "not joined to the closing turn");
    assert.equal(await completeTurn(mind, "s1", { turnId: first!.turnId }), first!.turnId);
    assert.equal(getActiveTurnId(mind, "s1"), next!.turnId, "the next turn runs on");
    await cleanup(mind);
  });

  it("an event turn's usage after its done lands on it by the id the done named", async () => {
    const mind = "tl-event-usage";
    // An event's turn: no daemon delivery id, only the mind's own.
    const { turnId } = await handleMindEvent(mind, {
      type: "text",
      session: "s1",
      channel: "event:schedule:1",
      messageId: "m-1",
      content: "x",
    });
    await handleMindEvent(mind, { type: "done", session: "s1", messageId: "m-1" });
    const usage = await handleMindEvent(mind, {
      type: "usage",
      session: "s1",
      messageId: "m-1",
      metadata: {},
    });
    assert.equal(usage.turnId, turnId);
    await cleanup(mind);
  });

  it("a usage naming a closing turn's delivery lands on it, not on the next turn", async () => {
    const mind = "tl-usage-closing";
    const first = await openDeliveredTurn(mind, "s1", mind);
    markClosing(mind, "s1", first!.turnId, ["d1"]);
    const next = await openDeliveredTurn(mind, "s1", mind);
    const usage = await handleMindEvent(mind, {
      type: "usage",
      session: "s1",
      messageId: "d1",
      metadata: {},
    });
    assert.equal(usage.turnId, first!.turnId);
    assert.notEqual(usage.turnId, next!.turnId);
    await cleanup(mind);
  });

  it("one mind's reports can't crowd another's out of the closed-turn map", async () => {
    const quiet = "tl-closed-quiet";
    const noisy = "tl-closed-noisy";
    const own = await openDeliveredTurn(quiet, "s1", quiet);
    markClosing(quiet, "s1", own!.turnId, ["q1"]);
    for (let i = 0; i < 500; i++) markClosing(noisy, "s1", `t${i}`, [`n${i}`]);
    assert.equal(closedTurnFor(quiet, "s1", "q1"), own!.turnId);
    await cleanup(quiet);
    await cleanup(noisy);
  });

  it("an event the mind sent before its done, handled after it, lands on that turn", async () => {
    const mind = "tl-late-event";
    const { turnId } = await handleMindEvent(mind, {
      type: "text",
      session: "s1",
      messageId: "m1",
      content: "a",
    });
    const closing = handleMindEvent(mind, { type: "done", session: "s1", messageId: "m1" });
    const late = await handleMindEvent(mind, {
      type: "tool_result",
      session: "s1",
      messageId: "m1",
      content: "late",
    });
    await closing;
    assert.equal(late.turnId, turnId, "no phantom turn opens for it");
    assert.equal(getActiveTurnId(mind, "s1"), undefined);
    // The next turn's own first event still opens its own.
    const next = await handleMindEvent(mind, {
      type: "text",
      session: "s1",
      messageId: "m2",
      content: "b",
    });
    assert.ok(next.turnId && next.turnId !== turnId);
    await cleanup(mind);
  });

  it("a turn interrupted before any output hands its message to the next turn on the thread", async () => {
    const mind = "tl-interrupted-handoff";
    const db = await getDb();
    const inboundId = await recordInbound(mind, "@alice", "alice", null, "first");
    const first = await openDeliveredTurn(mind, "s1", mind);
    await linkRowsToTurn(first!.turnId, [inboundId]);
    // The model was cut off before producing anything.
    await handleMindEvent(mind, { type: "usage", session: "s1", metadata: { output_tokens: 0 } });
    await handleMindEvent(mind, { type: "done", session: "s1", content: "" });
    // The summarizer finds nothing and takes the turn back.
    assert.ok(
      await waitFor(
        async () => !(await db.select().from(turns).where(eq(turns.id, first!.turnId)).get()),
      ),
    );
    // The next message on the thread starts the turn that answers it.
    const nextId = await recordInbound(mind, "@alice", "alice", null, "hello?");
    const next = (await openDeliveredTurn(mind, "s1", mind))!.turnId;
    await linkRowsToTurn(next, [nextId]);
    await adoptInterrupted(mind, "s1", next);
    const row = await db.select().from(mindHistory).where(eq(mindHistory.id, inboundId!)).get();
    assert.equal(row!.turn_id, next);
    assert.equal(
      (await db.select().from(turns).where(eq(turns.id, next)).get())!.trigger_event_id,
      nextId,
      "its own message stays the trigger",
    );
    await cleanup(mind);
  });

  it("a turn a delivery interrupted is taken back, though its model produced output", async () => {
    const mind = "tl-interrupted-output";
    const db = await getDb();
    const inboundId = await recordInbound(mind, "@alice", "alice", null, "first");
    const first = await openDeliveredTurn(mind, "s1", mind);
    await linkRowsToTurn(first!.turnId, [inboundId]);
    markInterrupted(first!.turnId, "d-interrupting");
    // It thought (hidden from observers), was cut off, and reported its usage and done.
    await handleMindEvent(mind, {
      type: "usage",
      session: "s1",
      metadata: { input_tokens: 50, output_tokens: 30 },
    });
    await handleMindEvent(mind, { type: "done", session: "s1" });
    assert.ok(
      await waitFor(
        async () => !(await db.select().from(turns).where(eq(turns.id, first!.turnId)).get()),
      ),
      "not kept as a quiet turn",
    );
    const nextId = await recordInbound(mind, "@alice", "alice", null, "next");
    const next = (await openDeliveredTurn(mind, "s1", mind))!.turnId;
    await linkRowsToTurn(next, [nextId]);
    await adoptInterrupted(mind, "s1", next);
    const row = await db.select().from(mindHistory).where(eq(mindHistory.id, inboundId!)).get();
    assert.equal(row!.turn_id, next, "the turn that answers it has it");
    await cleanup(mind);
  });

  it("a failed turn isn't held for a usage it will never send", async () => {
    const mind = "tl-errored-no-hold";
    const db = await getDb();
    const { turnId } = await handleMindEvent(mind, { type: "error", session: "s1", content: "x" });
    void turnId;
    const opened = await openDeliveredTurn(mind, "s2", mind);
    await db.insert(mindHistory).values([
      { mind, type: "error", thread: "s2", content: "boom", turn_id: opened!.turnId },
      { mind, type: "done", thread: "s2", turn_id: opened!.turnId },
    ]);
    await summarizeTurn(mind, "s2", undefined, 0, opened!.turnId, undefined, { onDone: true });
    assert.equal(
      await db.select().from(turns).where(eq(turns.id, opened!.turnId)).get(),
      undefined,
      "taken back at once",
    );
    await cleanup(mind);
  });

  it("an interrupted turn's message joins a turn already running on the thread, not as its trigger", async () => {
    const mind = "tl-interrupted-running";
    const db = await getDb();
    const oldId = await recordInbound(mind, "@alice", "alice", null, "interrupted");
    const newId = await recordInbound(mind, "@alice", "alice", null, "interrupting");
    const running = await openDeliveredTurn(mind, "s1", mind);
    await linkRowsToTurn(running!.turnId, [newId]);
    await holdInterrupted(mind, "s1", [oldId!]);
    const row = await db.select().from(mindHistory).where(eq(mindHistory.id, oldId!)).get();
    assert.equal(row!.turn_id, running!.turnId);
    assert.equal(
      (await db.select().from(turns).where(eq(turns.id, running!.turnId)).get())!.trigger_event_id,
      newId,
    );
    // Held only for this thread: another thread's next turn takes nothing.
    const otherId = await recordInbound(mind, "@bob", "bob", null, "elsewhere");
    await holdInterrupted(mind, "s2", [otherId!]);
    const { turnId: s3 } = await handleMindEvent(mind, {
      type: "text",
      session: "s3",
      content: "x",
    });
    const other = await db.select().from(mindHistory).where(eq(mindHistory.id, otherId!)).get();
    assert.notEqual(other!.turn_id, s3);
    await cleanup(mind);
  });

  it("after a restart, a turn left complete without a summary is settled by the tick", async () => {
    const mind = "tl-restart-settle";
    const db = await getDb();
    const old = "2026-01-01 00:00:00";
    const now = new Date().toISOString().slice(0, 19).replace("T", " ");
    // Two turns whose holds died with the daemon: one got its usage in the end, one never.
    const make = async (id: string, withUsage: boolean) => {
      await db
        .insert(turns)
        .values({ id, mind, thread: "s1", status: "complete", created_at: now });
      const rows = [
        { mind, type: "inbound", channel: "@alice", sender: "alice", content: "hi", turn_id: id },
        ...(withUsage
          ? [{ mind, type: "usage", metadata: JSON.stringify({ output_tokens: 9 }), turn_id: id }]
          : []),
        { mind, type: "done", turn_id: id },
      ];
      await db
        .insert(mindHistory)
        .values(rows.map((r) => ({ ...r, thread: "s1", created_at: old })));
    };
    await make(`${mind}-quiet`, true);
    await make(`${mind}-cut`, false);
    await reconcileWedgedTurns(60_000);
    const summary = await waitFor(() =>
      db
        .select()
        .from(summaries)
        .where(eq(summaries.period_key, `${mind}-quiet`))
        .get(),
    );
    assert.match(summary!.content, /no visible output/, "the quiet one is summarized");
    assert.equal(
      await db
        .select()
        .from(turns)
        .where(eq(turns.id, `${mind}-cut`))
        .get(),
      undefined,
      "the one whose usage never came is taken back",
    );
    await db.delete(summaries).where(eq(summaries.mind, mind));
    await cleanup(mind);
  });

  it("an empty turn — opened for a delivery that never arrived — leaves no row once settled", async () => {
    const mind = "tl-empty-turn";
    const db = await getDb();
    const opened = await openDeliveredTurn(mind, "s1", mind);
    // The mind stops before anything reached it; its turns are completed and summarized.
    await clearMind(mind);
    await summarizeTurn(mind, "s1", undefined, 0, opened!.turnId);
    assert.equal(
      await db.select().from(turns).where(eq(turns.id, opened!.turnId)).get(),
      undefined,
    );
    await cleanup(mind);
  });

  it("a turn settled long after it ended doesn't hand its messages to whatever runs next", async () => {
    const mind = "tl-settled-no-handoff";
    const db = await getDb();
    const inboundId = await recordInbound(mind, "@alice", "alice", null, "long ago");
    const first = await openDeliveredTurn(mind, "s1", mind);
    await linkRowsToTurn(first!.turnId, [inboundId]);
    await completeTurn(mind, "s1", { turnId: first!.turnId });
    await db
      .insert(mindHistory)
      .values({ mind, type: "done", thread: "s1", turn_id: first!.turnId });
    // The sweep settles it: no usage ever came.
    await summarizeTurn(mind, "s1", undefined, 0, first!.turnId);
    const { turnId: next } = await handleMindEvent(mind, {
      type: "text",
      session: "s1",
      content: "x",
    });
    const row = await db.select().from(mindHistory).where(eq(mindHistory.id, inboundId!)).get();
    assert.notEqual(row!.turn_id, next);
    await cleanup(mind);
  });

  it("an interrupted turn's message waits only briefly for the turn that answers it", async () => {
    const mind = "tl-interrupted-expiry";
    const db = await getDb();
    const oldId = await recordInbound(mind, "@alice", "alice", null, "cut off");
    await holdInterrupted(mind, "s1", [oldId!]);
    const realNow = Date.now;
    Date.now = () => realNow() + 3 * 60_000;
    try {
      const nextId = await recordInbound(mind, "@alice", "alice", null, "much later");
      const next = (await openDeliveredTurn(mind, "s1", mind))!.turnId;
      await linkRowsToTurn(next, [nextId]);
      await adoptInterrupted(mind, "s1", next);
    } finally {
      Date.now = realNow;
    }
    const row = await db.select().from(mindHistory).where(eq(mindHistory.id, oldId!)).get();
    assert.equal(row!.turn_id, null, "left unlinked, as on main");
    await cleanup(mind);
  });

  it("a turn the mind opens for the message that interrupted another takes that one's message", async () => {
    const mind = "tl-interrupted-mind-open";
    const db = await getDb();
    const oldId = await recordInbound(mind, "@bob", "bob", null, "cut off");
    await holdInterrupted(mind, "s1", [oldId!]);
    await recordInbound(mind, "@alice", "alice", null, "interrupting");
    // The mind runs the interrupting message; its first event opens the turn.
    const { turnId } = await handleMindEvent(mind, {
      type: "text",
      session: "s1",
      channel: "@alice",
      content: "on it",
    });
    const row = await db.select().from(mindHistory).where(eq(mindHistory.id, oldId!)).get();
    assert.equal(row!.turn_id, turnId);
    await cleanup(mind);
  });

  it("one interrupting delivery that never arrived doesn't undo another's interrupt", async () => {
    const mind = "tl-interrupt-count";
    const opened = await openDeliveredTurn(mind, "s1", mind);
    markInterrupted(opened!.turnId, "B"); // arrived, and interrupts it
    markInterrupted(opened!.turnId, "C"); // refused
    unmarkInterrupted(opened!.turnId, "C");
    assert.equal(wasInterrupted(opened!.turnId), true);
    unmarkInterrupted(opened!.turnId, "B");
    assert.equal(wasInterrupted(opened!.turnId), false);
    await cleanup(mind);
  });

  it("a delivery with no thread opens nothing", async () => {
    const mind = "tl-delivery-nothread";
    assert.equal(await openDeliveredTurn(mind, "", mind), undefined);
    assert.equal(getActiveTurnId(mind), undefined);
    await cleanup(mind);
  });
});

describe("turn-lifecycle: trigger linking (#403)", () => {
  it("links the trigger when the turn-creating event carries no channel (session fallback)", async () => {
    const mind = "tl-channelless-trigger";
    // Inbound arrives on the @alice DM (session is channel-shaped: session === channel).
    const inboundId = await recordInbound(mind, "@alice", "alice", null, "hello~");
    // The turn is created by a channel-less `thinking` event — the template's
    // message→channel mapping hasn't been established yet (the race in #403).
    const { turnId } = await handleMindEvent(mind, {
      type: "thinking",
      session: "@alice",
      content: "let me look",
    });
    assert.ok(turnId);

    const db = await getDb();
    const inbound = await db.select().from(mindHistory).where(eq(mindHistory.id, inboundId!)).get();
    assert.equal(inbound!.turn_id, turnId, "inbound should be tagged despite the missing channel");
    const turn = await db.select().from(turns).where(eq(turns.id, turnId!)).get();
    assert.equal(turn!.trigger_event_id, inboundId, "trigger should resolve via the session");
    await cleanup(mind);
  });

  it("does not claim inbounds that predate the previous turn on the session (bounded sweep)", async () => {
    const mind = "tl-bounded-sweep";
    const db = await getDb();
    // A prior turn on the @alice session, created at 01:00.
    const priorTurn = "00000000-0000-0000-0000-000000000001";
    await db.insert(turns).values({
      id: priorTurn,
      mind,
      thread: "@alice",
      status: "complete",
      created_at: "2020-01-01 01:00:00",
    });
    // A stale inbound that arrived BEFORE the prior turn and was never claimed — it must
    // stay untagged rather than be hoovered by the next turn.
    const stale = await db
      .insert(mindHistory)
      .values({
        mind,
        type: "inbound",
        channel: "@alice",
        sender: "alice",
        content: "old ping",
        created_at: "2020-01-01 00:30:00",
      })
      .returning({ id: mindHistory.id });
    // A fresh inbound that arrived after the prior turn — this one belongs to the new turn.
    const fresh = await db
      .insert(mindHistory)
      .values({
        mind,
        type: "inbound",
        channel: "@alice",
        sender: "alice",
        content: "new ping",
        created_at: "2020-01-01 02:00:00",
      })
      .returning({ id: mindHistory.id });

    // The new turn is created channel-less (session fallback) on @alice.
    const { turnId } = await handleMindEvent(mind, {
      type: "thinking",
      session: "@alice",
      content: "on it",
    });
    assert.ok(turnId);

    const staleRow = await db
      .select()
      .from(mindHistory)
      .where(eq(mindHistory.id, stale[0].id))
      .get();
    const freshRow = await db
      .select()
      .from(mindHistory)
      .where(eq(mindHistory.id, fresh[0].id))
      .get();
    assert.equal(staleRow!.turn_id, null, "stale pre-prior-turn inbound must stay untagged");
    assert.equal(freshRow!.turn_id, turnId, "fresh inbound must be tagged to the new turn");
    const turn = await db.select().from(turns).where(eq(turns.id, turnId!)).get();
    assert.equal(
      turn!.trigger_event_id,
      fresh[0].id,
      "trigger is the fresh inbound, not the stale",
    );
    await cleanup(mind);
  });

  it("a channel-less turn on a non-channel-shaped session claims nothing (no cross-channel over-reach)", async () => {
    const mind = "tl-nonchannel-session";
    // Session is a plain name (e.g. the `main` default), NOT a channel slug. An untagged
    // inbound sits on an unrelated channel. The session→channel fallback scopes the sweep
    // to channel === "main", which matches no inbound — the safety property the removed
    // `if (!channel) return` guard used to provide now rests on channel-equality.
    const orphan = await recordInbound(mind, "@bob", "bob", null, "unrelated ping");
    const { turnId } = await handleMindEvent(mind, {
      type: "thinking",
      session: "main",
      content: "thinking to myself",
    });
    assert.ok(turnId);

    const db = await getDb();
    const row = await db.select().from(mindHistory).where(eq(mindHistory.id, orphan!)).get();
    assert.equal(row!.turn_id, null, "inbound on a different channel must stay untagged");
    const turn = await db.select().from(turns).where(eq(turns.id, turnId!)).get();
    assert.equal(turn!.trigger_event_id, null, "trigger must stay null — nothing was claimed");
    await cleanup(mind);
  });

  it("each turn owns exactly its own inbounds across two turns (pip scenario)", async () => {
    const mind = "tl-pip-scenario";
    // Turn A: three inbounds arrive, then a channel-less first event opens the turn.
    const a1 = await recordInbound(mind, "@pip", "pip", null, "hello~ seeing skills?");
    const a2 = await recordInbound(mind, "@pip", "pip", null, "hello again");
    const a3 = await recordInbound(mind, "@pip", "pip", null, "ping");
    const { turnId: turnA } = await handleMindEvent(mind, {
      type: "thinking",
      session: "@pip",
      content: "checking",
    });
    assert.ok(turnA);
    await handleMindEvent(mind, {
      type: "text",
      session: "@pip",
      channel: "@pip",
      content: "fixed — all nine skills",
    });
    await handleMindEvent(mind, { type: "done", session: "@pip" });

    // Turn B: a later inbound + turn. It must not re-claim turn A's inbounds.
    const b1 = await recordInbound(mind, "@pip", "pip", null, "thanks!");
    const { turnId: turnB } = await handleMindEvent(mind, {
      type: "thinking",
      session: "@pip",
      content: "you're welcome",
    });
    assert.ok(turnB);
    assert.notEqual(turnA, turnB);

    const db = await getDb();
    for (const id of [a1, a2, a3]) {
      const row = await db.select().from(mindHistory).where(eq(mindHistory.id, id!)).get();
      assert.equal(row!.turn_id, turnA, `inbound ${id} should belong to turn A`);
    }
    const bRow = await db.select().from(mindHistory).where(eq(mindHistory.id, b1!)).get();
    assert.equal(bRow!.turn_id, turnB, "the later inbound should belong to turn B");
    const tA = await db.select().from(turns).where(eq(turns.id, turnA!)).get();
    const tB = await db.select().from(turns).where(eq(turns.id, turnB!)).get();
    assert.equal(tA!.trigger_event_id, a1, "turn A trigger is its first inbound");
    assert.equal(tB!.trigger_event_id, b1, "turn B trigger is its own inbound");
    await cleanup(mind);
  });
});

describe("turn-lifecycle: concurrent sessions", () => {
  const mind = "tl-concurrent";
  afterEach(() => cleanup(mind));

  it("attributes outbound records to the correct turn per session via the header path", async () => {
    // Two sessions for one mind, interleaved — this used to race under the process-global
    // VOLUTE_SESSION. Each substantive event carries its own session, so turns stay distinct.
    await handleMindEvent(mind, { type: "tool_use", session: "sA", channel: "@a", content: "a1" });
    await handleMindEvent(mind, { type: "tool_use", session: "sB", channel: "@b", content: "b1" });

    const turnA = getActiveTurnId(mind, "sA");
    const turnB = getActiveTurnId(mind, "sB");
    assert.ok(turnA && turnB, "both sessions should have active turns");
    assert.notEqual(turnA, turnB, "each session must have its own distinct turn");

    // Simulate the direct attribution path (volute/chat.ts): the send resolves the sending
    // mind's active turn from its session header and records the outbound tagged with it.
    const outA = await recordOutbound(mind, "@a", "from A", turnStamp(mind, "sA"));
    const outB = await recordOutbound(mind, "@b", "from B", turnStamp(mind, "sB"));

    const db = await getDb();
    const rowA = await db.select().from(mindHistory).where(eq(mindHistory.id, outA!)).get();
    const rowB = await db.select().from(mindHistory).where(eq(mindHistory.id, outB!)).get();
    assert.equal(rowA!.turn_id, turnA, "session A outbound should be tagged with turn A");
    assert.equal(rowB!.turn_id, turnB, "session B outbound should be tagged with turn B");

    // Completing one session's turn must not disturb the other.
    await handleMindEvent(mind, { type: "done", session: "sA" });
    assert.equal(getActiveTurnId(mind, "sA"), undefined);
    assert.equal(getActiveTurnId(mind, "sB"), turnB, "session B turn must remain active");

    const stillActive = await db
      .select()
      .from(turns)
      .where(and(eq(turns.id, turnB!), eq(turns.status, "active")))
      .get();
    assert.ok(stillActive, "turn B should still be active in the DB");
  });
});

describe("turn-lifecycle: spend cap notices", () => {
  before(() => {
    try {
      initSpendBudget();
    } catch {
      // already initialized by another test in this process
    }
  });

  /** One priced usage turn costing roughly `usd`, using haiku's known output price. */
  async function spend(mind: string, usd: number, session = "s1"): Promise<void> {
    await handleMindEvent(mind, {
      type: "usage",
      session,
      metadata: {
        input_tokens: 0,
        output_tokens: Math.round((usd * 1e6) / 5), // haiku output: $5/M
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        model: "anthropic:claude-haiku-4-5",
      },
    });
  }

  /** Every budget notice recorded for a mind, oldest first. */
  async function budgetNotices(
    mind: string,
  ): Promise<{ body: string; meta: string | null; delivery: string }[]> {
    const db = await getDb();
    const rows = await db
      .select({
        body: systemEvents.body,
        meta: systemEvents.meta,
        delivery: systemEvents.delivery,
        id: systemEvents.id,
      })
      .from(systemEvents)
      .where(and(eq(systemEvents.mind, mind), eq(systemEvents.type, "budget")))
      .all();
    return rows
      .sort((a, b) => a.id - b.id)
      .map(({ body, meta, delivery }) => ({ body, meta, delivery }));
  }

  it("the 80% warning is delivered, names the cap, spend, and reset time", async () => {
    const mind = "tl-spend-warn";
    const sb = getSpendBudget();
    sb.setBudget(mind, 1, 60);
    try {
      await spend(mind, 0.85);

      const notices = await budgetNotices(mind);
      assert.equal(notices.length, 1, "the warning fires");
      const { body } = notices[0];
      assert.match(body, /\$0\.85/, "names the spend so far");
      assert.match(body, /\$1\.00/, "names the cap");
      assert.match(body, /resets in about 1 hour/, "says when the period resets");
      // A heads-up that doesn't say what it is warning about isn't one.
      assert.match(body, /At 100%.*held/is, "names the consequence of reaching the cap");
      assert.match(body, /schedules/i, "including that schedules are held too");
      assert.doesNotMatch(body, /couldn't be priced/, "nothing was unpriced");
    } finally {
      await sb.removeBudget(mind);
      await cleanup(mind);
    }
  });

  it("the 80% warning reaches a turn in a different thread from the one that crossed it", async () => {
    const mind = "tl-spend-warn-thread";
    const sb = getSpendBudget();
    sb.setBudget(mind, 1, 60);
    try {
      // The spend crosses 80% mid-conversation with @tester; the mind's next turn is in
      // its @lyra thread. Pinned to @tester, the warning waits there for a turn that may
      // never come while the rest of the cap is spent elsewhere.
      await spend(mind, 0.85, "@tester");
      const drained = await drainEvents(mind, "@lyra");
      assert.ok(
        drained.some((e) => e.type === "budget" && /about 80%/.test(e.body)),
        "the warning should drain into whichever thread turns next",
      );
    } finally {
      await sb.removeBudget(mind);
      await cleanup(mind);
    }
  });

  it("the warning fires once per period and re-arms after a reset", async () => {
    const mind = "tl-spend-warn-once";
    const sb = getSpendBudget();
    sb.setBudget(mind, 1, 0); // 0-minute period: a tick rolls it over
    try {
      await spend(mind, 0.85);
      assert.equal((await budgetNotices(mind)).length, 1, "warned once");

      await spend(mind, 0.02);
      assert.equal((await budgetNotices(mind)).length, 1, "not warned again this period");

      await sb.tick(); // period rolls over, spend resets to 0
      await spend(mind, 0.85);
      assert.equal((await budgetNotices(mind)).length, 2, "re-armed for the new period");
    } finally {
      await sb.removeBudget(mind);
      await cleanup(mind);
    }
  });

  it("a warning that fails to record does not burn the once-per-period flag", async () => {
    // The exceeded branch already retracts on a failed insert; the warning branch
    // returned a bare `true`, so a transient DB failure cost the mind its heads-up for
    // the whole period — silence being the exact failure the warning exists to prevent.
    const mind = "tl-spend-warn-fail";
    const sb = getSpendBudget();
    sb.setBudget(mind, 1, 60);
    const db = await getDb();
    const trigger = "tl_spend_warn_fail";
    await db.run(
      sql.raw(
        `CREATE TRIGGER ${trigger} BEFORE INSERT ON system_events WHEN NEW.mind = '${mind}' BEGIN SELECT RAISE(ABORT, 'boom'); END`,
      ),
    );
    try {
      await spend(mind, 0.85);
      assert.equal((await budgetNotices(mind)).length, 0, "the insert failed");

      await db.run(sql.raw(`DROP TRIGGER ${trigger}`));
      await spend(mind, 0.01);
      assert.equal((await budgetNotices(mind)).length, 1, "warned on the next turn instead");
    } finally {
      await db.run(sql.raw(`DROP TRIGGER IF EXISTS ${trigger}`));
      await sb.removeBudget(mind);
      await cleanup(mind);
    }
  });

  it("a turn that jumps straight past the cap gets the exceeded notice, not the warning", async () => {
    const mind = "tl-spend-jump";
    const sb = getSpendBudget();
    sb.setBudget(mind, 1, 60);
    try {
      await spend(mind, 1.5);

      const notices = await budgetNotices(mind);
      assert.equal(notices.length, 1);
      assert.match(notices[0].body, /spent your full/, "exceeded wording");
      assert.match(notices[0].body, /resets in about 1 hour/, "exceeded notice names the reset");
      // The notice may now promise a hold, because the delivery manager actually performs
      // one — `holdFor` gates every POST. Whatever the wording claims has to be true of
      // the code: messages are held, they are not lost, and they arrive when it resets.
      assert.match(notices[0].body, /being held/i, "states that messages are held");
      assert.match(notices[0].body, /nothing is deleted/i, "and that nothing is dropped");
      // Schedules are held too now, so the notice must say so — the earlier wording
      // promised they still fired, which stopped being true the moment the event gate
      // landed. The claim that survives is about the mind's own agency.
      assert.match(notices[0].body, /scheduled wakeups/i, "names that schedules are held too");
      assert.doesNotMatch(
        notices[0].body,
        /schedules still fire/i,
        "and no longer claims they keep firing",
      );
      assert.match(
        notices[0].body,
        /own tools still work/i,
        "the hold is on the world reaching in, not on the mind acting",
      );
      assert.match(
        notices[0].body,
        /not being replayed/i,
        "and warns that the release is bounded rather than a flood",
      );
    } finally {
      await sb.removeBudget(mind);
      await cleanup(mind);
    }
  });

  it("warning then exceeded are two distinct notices in the same period", async () => {
    const mind = "tl-spend-both";
    const sb = getSpendBudget();
    sb.setBudget(mind, 1, 60);
    try {
      await spend(mind, 0.85);
      await spend(mind, 0.3);

      const notices = await budgetNotices(mind);
      assert.equal(notices.length, 2);
      assert.match(notices[0].body, /about 80%/);
      assert.match(notices[1].body, /spent your full/);
      // The warning can wait for the next turn — the mind is still receiving, so one is
      // coming. The exceeded notice cannot: from that moment inbound messages are held,
      // and an inbound message is what would have produced the next turn. It would sit
      // undrained behind the very silence it explains.
      assert.equal(notices[0].delivery, "next-turn", "the warning rides the next turn");
      assert.equal(notices[1].delivery, "immediate", "the exceeded notice does not wait");
      // Exceeded fires only once, however many more turns land.
      await spend(mind, 0.1);
      assert.equal((await budgetNotices(mind)).length, 2);
    } finally {
      await sb.removeBudget(mind);
      await cleanup(mind);
    }
  });

  it("the system cap's notice says it is the install's budget, not the mind's", async () => {
    const mind = "tl-spend-system";
    const sb = getSpendBudget();
    sb.setSystemCap(1);
    sb.setBudget(mind, 100, 60); // nowhere near its own cap
    try {
      await spend(mind, 1.2);

      const notices = await budgetNotices(mind);
      assert.equal(notices.length, 1);
      assert.match(notices[0].body, /This install/, "attributes the spend to the install");
      assert.match(notices[0].body, /not yours in particular/);
      assert.doesNotMatch(notices[0].body, /You've spent your full/, "does not blame the mind");
      assert.match(notices[0].body, /being held/i, "states that messages are held");
      assert.match(notices[0].meta ?? "", /system_spend_cap/);
    } finally {
      sb.setSystemCap(null);
      await sb.removeBudget(mind);
      await cleanup(mind);
    }
  });

  it("an unpriced turn says the figure is incomplete rather than quoting it as exact", async () => {
    const mind = "tl-spend-unpriced";
    const sb = getSpendBudget();
    sb.setBudget(mind, 1, 60);
    try {
      // An un-upgraded mind's two-field usage: priced as null, accumulating nothing.
      await handleMindEvent(mind, {
        type: "usage",
        session: "s1",
        metadata: {
          input_tokens: 900,
          output_tokens: 900_000,
          model: "anthropic:claude-haiku-4-5",
        },
      });
      assert.equal((await budgetNotices(mind)).length, 0, "an unpriced turn trips nothing");
      assert.equal(sb.getUsage(mind)!.spentUsd, 0);

      await spend(mind, 0.85);
      const notices = await budgetNotices(mind);
      assert.equal(notices.length, 1);
      assert.match(notices[0].body, /couldn't be priced/, "says the figure is a floor");
    } finally {
      await sb.removeBudget(mind);
      await cleanup(mind);
    }
  });

  it("a mind with no cap and no system cap gets no notices at all", async () => {
    const mind = "tl-spend-uncapped";
    try {
      await spend(mind, 500);
      assert.equal((await budgetNotices(mind)).length, 0);
    } finally {
      await cleanup(mind);
    }
  });
});
