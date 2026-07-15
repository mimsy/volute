import assert from "node:assert/strict";
import { afterEach, before, describe, it } from "node:test";
import { and, eq } from "drizzle-orm";
import { drainEvents } from "../packages/daemon/src/lib/chat/system-events.js";
import { getTypingMap } from "../packages/daemon/src/lib/chat/typing.js";
import { initTokenBudget } from "../packages/daemon/src/lib/daemon/token-budget.js";
import { handleMindEvent } from "../packages/daemon/src/lib/daemon/turn-lifecycle.js";
import {
  clearMind,
  getActiveTurnId,
  linkInboundToActiveTurn,
} from "../packages/daemon/src/lib/daemon/turn-tracker.js";
import { getDb } from "../packages/daemon/src/lib/db.js";
import {
  recordInbound,
  recordOutbound,
} from "../packages/daemon/src/lib/delivery/message-delivery.js";
import { subscribe as subscribeActivity } from "../packages/daemon/src/lib/events/activity-events.js";
import {
  type ConversationEvent,
  subscribe,
} from "../packages/daemon/src/lib/events/conversation-events.js";
import { mindHistory, systemEvents, turns } from "../packages/daemon/src/lib/schema.js";

async function cleanup(mind: string): Promise<void> {
  await clearMind(mind);
  const db = await getDb();
  await db.delete(mindHistory).where(eq(mindHistory.mind, mind));
  await db.delete(turns).where(eq(turns.mind, mind));
  await db.delete(systemEvents).where(eq(systemEvents.mind, mind));
}

describe("turn-lifecycle: handleMindEvent", () => {
  before(() => {
    // usage events accrue against the token budget singleton.
    try {
      initTokenBudget();
    } catch {
      // already initialized by another test in this process
    }
  });

  it("session_start assigns a session to an existing sessionless turn", async () => {
    const mind = "tl-session-start";
    // A sessionless turn opens on the first substantive event without a session.
    await handleMindEvent(mind, { type: "tool_use", content: "x" });
    assert.ok(getActiveTurnId(mind), "sessionless turn should exist");

    await handleMindEvent(mind, { type: "session_start", session: "s1" });
    const turnId = getActiveTurnId(mind, "s1");
    assert.ok(turnId, "turn should now be keyed by session s1");

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
    const inboundId = await recordInbound(mind, "@alice", "alice", "hello");
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
    // The exactly-once machinery: the pre-prompt hook drains (recording a watermark);
    // a clean `done` marks the drained events delivered, but an errored turn must NOT —
    // failures accumulate until the mind demonstrably completes a turn.
    const { setNoticeDrainWatermark } = await import(
      "../packages/daemon/src/lib/daemon/turn-lifecycle.js"
    );
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
    let drained = await drainEvents(mind, "s1");
    assert.equal(drained.length, 1);
    setNoticeDrainWatermark(mind, "s1", Math.max(...drained.map((n) => n.id)));
    await handleMindEvent(mind, { type: "text", session: "s1", content: "trying…" });
    await handleMindEvent(mind, { type: "error", session: "s1", content: "boom again" });
    await handleMindEvent(mind, { type: "done", session: "s1" });

    drained = await drainEvents(mind, "s1");
    assert.ok(
      drained.some((n) => n.body === "flaky"),
      "the drained notice must be redelivered after an errored turn",
    );

    // Turn 2: drains again and completes cleanly — everything drained clears.
    setNoticeDrainWatermark(mind, "s1", Math.max(...drained.map((n) => n.id)));
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

  it("usage accrues against the token budget", async () => {
    const mind = "tl-usage";
    await handleMindEvent(mind, {
      type: "usage",
      session: "s1",
      metadata: { input_tokens: 100, output_tokens: 50 },
    });
    // No throw is the primary assertion; the budget singleton recorded the usage.
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
    // Outbound recorded with no turn_id (no session header path).
    const outboundId = await recordOutbound(mind, "@bob", "sent via CLI");
    // Turn opens sessionless, then the tool_result carries the correlation marker.
    await handleMindEvent(mind, { type: "tool_use", content: "volute chat send" });
    const turnId = getActiveTurnId(mind);
    await handleMindEvent(mind, {
      type: "tool_result",
      content: `Message sent.\n[volute:outbound:${outboundId}]`,
    });

    const db = await getDb();
    const row = await db.select().from(mindHistory).where(eq(mindHistory.id, outboundId!)).get();
    assert.equal(row!.turn_id, turnId, "marker fallback should attribute the outbound to the turn");
    await cleanup(mind);
  });
});

describe("turn-lifecycle: mid-turn inbound tagging", () => {
  it("tags an inbound arriving mid-turn to the in-progress turn, without touching the trigger", async () => {
    const mind = "tl-midturn";
    // A turn is already active for (mind, s1, @alice), triggered by an earlier inbound.
    const triggerId = await recordInbound(mind, "@alice", "alice", "first");
    const { turnId } = await handleMindEvent(mind, {
      type: "text",
      session: "s1",
      channel: "@alice",
      content: "on it",
    });
    assert.ok(turnId);
    assert.equal(getActiveTurnId(mind, "s1"), turnId, "turn should be active");

    // A new inbound arrives on the same channel WHILE the turn is still active.
    const interruptId = await recordInbound(mind, "@alice", "alice", "actually, wait");
    const db = await getDb();
    const before = await db
      .select()
      .from(mindHistory)
      .where(eq(mindHistory.id, interruptId!))
      .get();
    assert.equal(before!.turn_id, null, "interrupt starts untagged");

    // Delivery attributes it to the in-progress turn immediately.
    await linkInboundToActiveTurn(mind, "s1", "@alice");

    const after = await db.select().from(mindHistory).where(eq(mindHistory.id, interruptId!)).get();
    assert.equal(after!.turn_id, turnId, "mid-turn inbound must be tagged to the active turn now");

    // The turn's trigger stays the original triggering inbound — a mid-turn message is not a trigger.
    const turn = await db.select().from(turns).where(eq(turns.id, turnId!)).get();
    assert.equal(turn!.trigger_event_id, triggerId, "trigger_event_id must not be overwritten");
    await cleanup(mind);
  });

  it("tags a system event arriving mid-turn to the in-progress turn", async () => {
    // `linkInboundToActiveTurn` must match "event" rows as well as "inbound" ones. Events are
    // delivered with no busy check, so one can land while a turn is already running — this is
    // the only path that attributes it. If the filter narrows back to "inbound", the event
    // silently drops out of the turn's `events` array in the timeline and out of the
    // summarizer's transcript. Nothing throws; the event simply never happened, as far as
    // history is concerned.
    const mind = "tl-midturn-event";
    const triggerId = await recordInbound(mind, "@alice", "alice", "first");
    const { turnId } = await handleMindEvent(mind, {
      type: "text",
      session: "s1",
      channel: "@alice",
      content: "on it",
    });
    assert.ok(turnId);

    const db = await getDb();
    const inserted = await db
      .insert(mindHistory)
      .values({
        mind,
        type: "event",
        thread: "s1",
        channel: "event:schedule:99",
        content: "Time for your morning check-in.",
        metadata: JSON.stringify({ systemEventId: 99, label: "Schedule: morning-check" }),
      })
      .returning({ id: mindHistory.id });
    const eventRowId = inserted[0].id;

    await linkInboundToActiveTurn(mind, "s1", "event:schedule:99");

    const after = await db.select().from(mindHistory).where(eq(mindHistory.id, eventRowId)).get();
    assert.equal(after!.turn_id, turnId, "mid-turn event must be tagged to the active turn");

    // ...but a mid-turn arrival is never the trigger — the turn was started by alice.
    const turn = await db.select().from(turns).where(eq(turns.id, turnId!)).get();
    assert.equal(turn!.trigger_event_id, triggerId, "trigger_event_id must not be overwritten");
    await cleanup(mind);
  });

  it("tags ALL mid-turn inbounds even when more than 5 accumulate (next-turn sweep would miss them)", async () => {
    const mind = "tl-midturn-backlog";
    // Open a turn on the channel.
    const { turnId } = await handleMindEvent(mind, {
      type: "text",
      session: "s1",
      channel: "@alice",
      content: "working",
    });
    assert.ok(turnId);

    // 7 inbounds pile up mid-turn — more than linkPendingInbound's bounded sweep of 5.
    const ids: number[] = [];
    for (let i = 0; i < 7; i++) {
      const id = await recordInbound(mind, "@alice", "alice", `msg ${i}`);
      ids.push(id!);
    }

    await linkInboundToActiveTurn(mind, "s1", "@alice");

    const db = await getDb();
    for (const id of ids) {
      const row = await db.select().from(mindHistory).where(eq(mindHistory.id, id)).get();
      assert.equal(row!.turn_id, turnId, `inbound ${id} must be tagged (not left NULL)`);
    }
    await cleanup(mind);
  });

  it("is a no-op when no turn is active — the turn-creation path tags it instead", async () => {
    const mind = "tl-midturn-noturn";
    // No active turn for this session yet.
    const inboundId = await recordInbound(mind, "@alice", "alice", "hello");
    await linkInboundToActiveTurn(mind, "s1", "@alice");

    const db = await getDb();
    const row = await db.select().from(mindHistory).where(eq(mindHistory.id, inboundId!)).get();
    assert.equal(
      row!.turn_id,
      null,
      "no active turn → inbound stays untagged for the creation path",
    );

    // The turn-creation path then tags it as the trigger.
    const { turnId } = await handleMindEvent(mind, {
      type: "text",
      session: "s1",
      channel: "@alice",
      content: "hi",
    });
    const tagged = await db.select().from(mindHistory).where(eq(mindHistory.id, inboundId!)).get();
    assert.equal(tagged!.turn_id, turnId, "creation path tags the pending inbound");
    await cleanup(mind);
  });

  it("does not tag inbounds on a different channel", async () => {
    const mind = "tl-midturn-otherchannel";
    const { turnId } = await handleMindEvent(mind, {
      type: "text",
      session: "s1",
      channel: "@alice",
      content: "hi",
    });
    assert.ok(turnId);
    // Inbound on a different channel must not be swept into this turn.
    const otherId = await recordInbound(mind, "@bob", "bob", "unrelated");
    await linkInboundToActiveTurn(mind, "s1", "@alice");

    const db = await getDb();
    const row = await db.select().from(mindHistory).where(eq(mindHistory.id, otherId!)).get();
    assert.equal(row!.turn_id, null, "a different channel's inbound must stay untagged");
    await cleanup(mind);
  });
});

describe("turn-lifecycle: trigger linking (#403)", () => {
  it("links the trigger when the turn-creating event carries no channel (session fallback)", async () => {
    const mind = "tl-channelless-trigger";
    // Inbound arrives on the @alice DM (session is channel-shaped: session === channel).
    const inboundId = await recordInbound(mind, "@alice", "alice", "hello~");
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
    const orphan = await recordInbound(mind, "@bob", "bob", "unrelated ping");
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
    const a1 = await recordInbound(mind, "@pip", "pip", "hello~ seeing skills?");
    const a2 = await recordInbound(mind, "@pip", "pip", "hello again");
    const a3 = await recordInbound(mind, "@pip", "pip", "ping");
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
    const b1 = await recordInbound(mind, "@pip", "pip", "thanks!");
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
    const outA = await recordOutbound(mind, "@a", "from A", {
      turnId: getActiveTurnId(mind, "sA"),
    });
    const outB = await recordOutbound(mind, "@b", "from B", {
      turnId: getActiveTurnId(mind, "sB"),
    });

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
