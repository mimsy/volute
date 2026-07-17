import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { before, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import {
  captureReflection,
  cleanExpiredEvents,
  clearDeliveredEvents,
  deliverEvent,
  drainEvents,
  eventChannel,
  eventLabel,
  flushQueuedEvents,
  formatEvents,
  hasUndeliveredEvent,
  latestEvent,
  latestFailureEvent,
  parseMeta,
  pendingEventsLine,
  recordNotice,
  type SystemEvent,
} from "../packages/daemon/src/lib/chat/system-events.js";
import {
  getSleepManagerIfReady,
  initSleepManager,
} from "../packages/daemon/src/lib/daemon/sleep-manager.js";
import { initTokenBudget } from "../packages/daemon/src/lib/daemon/token-budget.js";
import { handleMindEvent } from "../packages/daemon/src/lib/daemon/turn-lifecycle.js";
import { clearMind } from "../packages/daemon/src/lib/daemon/turn-tracker.js";
import { getDb } from "../packages/daemon/src/lib/db.js";
import { addMind, removeMind } from "../packages/daemon/src/lib/mind/registry.js";
import { mindHistory, minds, systemEvents, turns } from "../packages/daemon/src/lib/schema.js";

type Posted = {
  kind?: string;
  event?: { id: number; label: string; body: string; type: string };
  session?: string;
};

/** A stub mind server that records the envelopes POSTed to /message. */
async function stubMind(
  name: string,
  opts: { status?: number; ackBody?: string } = {},
): Promise<{ port: number; posted: Posted[]; close: () => void }> {
  const posted: Posted[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      try {
        posted.push(JSON.parse(Buffer.concat(chunks).toString()));
      } catch {
        // ignore
      }
      res.writeHead(opts.status ?? 200, { "Content-Type": "application/json" });
      res.end(opts.ackBody ?? JSON.stringify({ ok: true, event: true }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  await addMind(name, port);
  return { port, posted, close: () => server.close() };
}

async function eventRow(id: number): Promise<SystemEvent | undefined> {
  const db = await getDb();
  return db.select().from(systemEvents).where(eq(systemEvents.id, id)).get();
}

/**
 * The mind_history rows recording a delivered event. These are `event` rows, NOT `inbound`:
 * an event is not a message, and every history surface keys off the type to render it as a
 * system marker instead of a chat bubble with a phantom sender.
 */
async function inboundRows(mind: string) {
  const db = await getDb();
  return (await db.select().from(mindHistory).where(eq(mindHistory.mind, mind))).filter(
    (r) => r.type === "event",
  );
}

async function cleanupMind(mind: string): Promise<void> {
  const db = await getDb();
  await db.delete(systemEvents).where(eq(systemEvents.mind, mind));
  await db.delete(mindHistory).where(eq(mindHistory.mind, mind));
  await db.delete(turns).where(eq(turns.mind, mind));
  clearMind(mind);
  await removeMind(mind);
}

let counter = 0;
function uniqueMind(): string {
  counter += 1;
  return `sysev-${process.pid}-${counter}`;
}

describe("system-events deliverEvent", () => {
  it("immediate: POSTs an event envelope, stamps delivered_at, records inbound", async () => {
    const mind = uniqueMind();
    const stub = await stubMind(mind);
    try {
      const { id, delivered } = await deliverEvent(mind, {
        type: "schedule",
        body: "check the garden",
        meta: { scheduleId: "morning" },
      });
      assert.equal(delivered, true);
      assert.ok(id);

      // The envelope reached the mind with an event shape and worded label.
      assert.equal(stub.posted.length, 1);
      assert.equal(stub.posted[0].kind, "event");
      assert.equal(stub.posted[0].event?.body, "check the garden");
      assert.equal(stub.posted[0].event?.label, "Schedule: morning");

      const row = await eventRow(id!);
      assert.ok(row?.delivered_at, "delivered_at is stamped");

      // Recorded (only on actual delivery) with the unique event channel.
      const inbound = await inboundRows(mind);
      assert.equal(inbound.length, 1);
      assert.equal(inbound[0].content, "check the garden");
      assert.equal(inbound[0].channel, eventChannel("schedule", id!));
      assert.equal(parseMeta(inbound[0].metadata).systemEventId, id);

      // Typed `event`, never `inbound` — a message row would render as chat with a phantom
      // sender ("user"), which is exactly what made events indistinguishable from messages.
      assert.equal(inbound[0].type, "event");
      assert.equal(inbound[0].sender, null);
      // The worded label rides on the row so history surfaces don't re-derive it.
      assert.equal(parseMeta(inbound[0].metadata).label, "Schedule: morning");

      const db = await getDb();
      const asMessages = (
        await db.select().from(mindHistory).where(eq(mindHistory.mind, mind))
      ).filter((r) => r.type === "inbound");
      assert.equal(asMessages.length, 0, "an event must never be recorded as an inbound message");
    } finally {
      stub.close();
      await cleanupMind(mind);
    }
  });

  it("failed POST: delivered:false, row stays pending, NO inbound; flush later delivers it", async () => {
    const mind = uniqueMind();
    const failing = await stubMind(mind, { status: 500 });
    try {
      const { id, delivered } = await deliverEvent(mind, {
        type: "file-share",
        body: "a file is waiting",
      });
      assert.equal(delivered, false);
      assert.ok(id);
      assert.equal((await eventRow(id!))?.delivered_at, null, "row stays pending");
      assert.equal(
        (await inboundRows(mind)).length,
        0,
        "no inbound recorded for an undelivered event (#420 honesty)",
      );

      // The mind comes back: flush redelivers the pending event.
      failing.close();
      await removeMind(mind);
      const healthy = await stubMind(mind);
      try {
        const flushed = await flushQueuedEvents(mind);
        assert.equal(flushed, 1);
        assert.equal(healthy.posted[0]?.event?.body, "a file is waiting");
        assert.ok((await eventRow(id!))?.delivered_at, "stamped on flush");
        assert.equal((await inboundRows(mind)).length, 1, "inbound recorded at flush");
      } finally {
        healthy.close();
      }
    } finally {
      await cleanupMind(mind);
    }
  });

  it("variant events land on the variant's own port, not the parent's", async () => {
    const parent = uniqueMind();
    const variant = `${parent}-exp`;
    const parentStub = await stubMind(parent);
    const variantStub = await stubMind(variant);
    try {
      // Mark the variant row as a child of the parent (its own port stays).
      const db = await getDb();
      await db.update(minds).set({ parent }).where(eq(minds.name, variant));

      const { delivered } = await deliverEvent(variant, {
        type: "lifecycle",
        meta: { subtype: "farewell", parent },
        body: "wind down",
      });
      assert.equal(delivered, true);
      assert.equal(variantStub.posted.length, 1, "variant received the event");
      assert.equal(parentStub.posted.length, 0, "parent did not");
    } finally {
      parentStub.close();
      variantStub.close();
      await cleanupMind(variant);
      await cleanupMind(parent);
    }
  });

  it("sleep queue: an immediate event to a sleeping mind stays pending, then flushes on wake", async () => {
    const mind = uniqueMind();
    const stub = await stubMind(mind);
    const sm = getSleepManagerIfReady() ?? initSleepManager();
    const realIsSleeping = sm.isSleeping.bind(sm);
    (sm as unknown as { isSleeping: (n: string) => boolean }).isSleeping = (n) => n === mind;
    try {
      const { id, delivered } = await deliverEvent(mind, {
        type: "schedule",
        body: "queued while asleep",
        whileSleeping: "queue",
      });
      assert.equal(delivered, false, "not delivered while sleeping");
      assert.equal(stub.posted.length, 0);
      assert.equal((await eventRow(id!))?.delivered_at, null, "stays pending");
      assert.equal((await inboundRows(mind)).length, 0, "no inbound until flush");

      // Flush delivers it.
      const flushed = await flushQueuedEvents(mind);
      assert.equal(flushed, 1);
      assert.equal(stub.posted.length, 1);
      assert.equal(stub.posted[0].event?.body, "queued while asleep");
      assert.equal((await inboundRows(mind)).length, 1, "inbound recorded at flush");
    } finally {
      (sm as unknown as { isSleeping: (n: string) => boolean }).isSleeping = realIsSleeping;
      stub.close();
      await cleanupMind(mind);
    }
  });

  it("sleep skip: an immediate event with whileSleeping=skip is dropped, not flushed", async () => {
    const mind = uniqueMind();
    const stub = await stubMind(mind);
    const sm = getSleepManagerIfReady() ?? initSleepManager();
    const realIsSleeping = sm.isSleeping.bind(sm);
    (sm as unknown as { isSleeping: (n: string) => boolean }).isSleeping = (n) => n === mind;
    try {
      const { id } = await deliverEvent(mind, {
        type: "schedule",
        body: "skipped while asleep",
        whileSleeping: "skip",
      });
      const row = await eventRow(id!);
      assert.ok(row?.delivered_at, "skip stamps delivered_at so it won't flush");
      assert.equal(parseMeta(row?.meta).skipped, true);
      assert.equal((await inboundRows(mind)).length, 0, "the mind never heard it");

      const flushed = await flushQueuedEvents(mind);
      assert.equal(flushed, 0);
      assert.equal(stub.posted.length, 0, "never delivered");
    } finally {
      (sm as unknown as { isSleeping: (n: string) => boolean }).isSleeping = realIsSleeping;
      stub.close();
      await cleanupMind(mind);
    }
  });

  it("trigger-wake: initiates a wake and leaves the row pending for the flush", async () => {
    const mind = uniqueMind();
    const stub = await stubMind(mind);
    const sm = getSleepManagerIfReady() ?? initSleepManager();
    const realIsSleeping = sm.isSleeping.bind(sm);
    const realInitiateWake = sm.initiateWake.bind(sm);
    const wakes: { name: string; channel?: string }[] = [];
    (sm as unknown as { isSleeping: (n: string) => boolean }).isSleeping = (n) => n === mind;
    (
      sm as unknown as {
        initiateWake: (n: string, o?: { trigger?: { channel: string } }) => Promise<void>;
      }
    ).initiateWake = async (n, o) => {
      wakes.push({ name: n, channel: o?.trigger?.channel });
    };
    try {
      const { id, delivered } = await deliverEvent(mind, {
        type: "schedule",
        body: "wake up for this",
        whileSleeping: "trigger-wake",
      });
      assert.equal(delivered, false);
      // The wake is fire-and-forget; give the microtask a beat.
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(wakes.length, 1, "wake initiated");
      assert.equal(wakes[0].name, mind);
      assert.equal((await eventRow(id!))?.delivered_at, null, "row pending for the wake flush");
      assert.equal(stub.posted.length, 0, "not POSTed while sleeping");
    } finally {
      (sm as unknown as { isSleeping: (n: string) => boolean }).isSleeping = realIsSleeping;
      (sm as unknown as { initiateWake: typeof realInitiateWake }).initiateWake = realInitiateWake;
      stub.close();
      await cleanupMind(mind);
    }
  });
});

describe("system-events $new thread expansion", () => {
  it("immediate $new: expands to a unique new-* session, stored and POSTed, isolated per fire", async () => {
    const mind = uniqueMind();
    const stub = await stubMind(mind);
    try {
      const { id: id1, delivered } = await deliverEvent(mind, {
        type: "schedule",
        body: "dream one",
        meta: { scheduleId: "dream" },
        thread: "$new",
      });
      assert.equal(delivered, true);

      // The row is stamped with the expanded thread, never the literal "$new".
      const row1 = await eventRow(id1!);
      assert.notEqual(row1?.thread, "$new", "literal $new must not be stored");
      assert.match(row1!.thread, /^new-/, "expanded to a new-* session");

      // The envelope carries the same expanded session the row was stamped with.
      assert.equal(stub.posted[0].session, row1!.thread, "POSTed session matches the row thread");

      // A second fire gets a DIFFERENT isolated session — dreams don't share context.
      const { id: id2 } = await deliverEvent(mind, {
        type: "schedule",
        body: "dream two",
        meta: { scheduleId: "dream" },
        thread: "$new",
      });
      const row2 = await eventRow(id2!);
      assert.match(row2!.thread, /^new-/);
      assert.notEqual(row2!.thread, row1!.thread, "each fire is its own session");
    } finally {
      stub.close();
      await cleanupMind(mind);
    }
  });

  it("next-turn $new: collapses to mind-level so it can't strand in a session that never runs", async () => {
    const mind = uniqueMind();
    try {
      // A next-turn event stamped to a unique new-* session would never drain (nothing
      // triggers a turn there); mind-level lets it reach whichever thread next runs.
      const { id } = await deliverEvent(mind, {
        type: "notice",
        body: "mind-level, not stranded",
        thread: "$new",
        delivery: "next-turn",
      });
      const row = await eventRow(id!);
      assert.equal(row?.thread, "", "next-turn $new stored as mind-level (MIND_LEVEL_THREAD)");

      // It drains into an arbitrary session's next turn, proving it isn't stranded.
      const drained = await drainEvents(mind, "some-other-session");
      assert.deepEqual(
        drained.map((e) => e.body),
        ["mind-level, not stranded"],
      );
    } finally {
      await cleanupMind(mind);
    }
  });
});

describe("system-events flushQueuedEvents", () => {
  it("delivers pending events oldest-first", async () => {
    const mind = uniqueMind();
    const failing = await stubMind(mind, { status: 500 });
    try {
      await deliverEvent(mind, { type: "channel", body: "first" });
      await deliverEvent(mind, { type: "channel", body: "second" });
      failing.close();
      await removeMind(mind);

      const healthy = await stubMind(mind);
      try {
        const flushed = await flushQueuedEvents(mind);
        assert.equal(flushed, 2);
        assert.deepEqual(
          healthy.posted.map((p) => p.event?.body),
          ["first", "second"],
          "oldest-first",
        );
      } finally {
        healthy.close();
      }
    } finally {
      await cleanupMind(mind);
    }
  });

  it("a corrupt-meta row does not block the rows behind it", async () => {
    const mind = uniqueMind();
    const failing = await stubMind(mind, { status: 500 });
    try {
      const { id: badId } = await deliverEvent(mind, { type: "channel", body: "corrupt" });
      const { id: goodId } = await deliverEvent(mind, { type: "channel", body: "fine" });
      failing.close();
      await removeMind(mind);

      const db = await getDb();
      await db.update(systemEvents).set({ meta: "{not json!!" }).where(eq(systemEvents.id, badId!));

      const healthy = await stubMind(mind);
      try {
        const flushed = await flushQueuedEvents(mind);
        assert.equal(flushed, 2, "both rows delivered despite the corrupt meta");
        assert.ok((await eventRow(goodId!))?.delivered_at, "row behind the corrupt one flushed");
      } finally {
        healthy.close();
      }
    } finally {
      await cleanupMind(mind);
    }
  });

  it("never replays sleep-type events — stamps them expired instead", async () => {
    const mind = uniqueMind();
    const failing = await stubMind(mind, { status: 500 });
    try {
      const { id } = await deliverEvent(mind, { type: "sleep", body: "Time to rest." });
      failing.close();
      await removeMind(mind);

      const healthy = await stubMind(mind);
      try {
        const flushed = await flushQueuedEvents(mind);
        assert.equal(flushed, 0);
        assert.equal(healthy.posted.length, 0, "stale bedtime prompt not replayed");
        const row = await eventRow(id!);
        assert.ok(row?.delivered_at, "stamped so it never flushes again");
        assert.equal(parseMeta(row?.meta).expired, true);
      } finally {
        healthy.close();
      }
    } finally {
      await cleanupMind(mind);
    }
  });

  it("expires pending events older than the max age", async () => {
    const mind = uniqueMind();
    const failing = await stubMind(mind, { status: 500 });
    try {
      const { id } = await deliverEvent(mind, { type: "channel", body: "ancient" });
      failing.close();
      await removeMind(mind);
      const db = await getDb();
      await db
        .update(systemEvents)
        .set({ created_at: "2020-01-01 00:00:00" })
        .where(eq(systemEvents.id, id!));

      const healthy = await stubMind(mind);
      try {
        const flushed = await flushQueuedEvents(mind);
        assert.equal(flushed, 0);
        assert.equal(parseMeta((await eventRow(id!))?.meta).expired, true);
      } finally {
        healthy.close();
      }
    } finally {
      await cleanupMind(mind);
    }
  });
});

describe("system-events reflection attribution", () => {
  before(() => {
    try {
      initTokenBudget();
    } catch {
      // already initialized
    }
  });

  /** Simulate an event turn: text event carrying the event channel, then done. */
  async function runEventTurn(mind: string, id: number, type: string, text: string) {
    await handleMindEvent(mind, {
      type: "text",
      session: "main",
      channel: eventChannel(type, id),
      content: text,
    });
    await handleMindEvent(mind, { type: "done", session: "main" });
  }

  /** captureReflection is fire-and-forget on `done` — poll for the row to settle. */
  async function waitForReflection(id: number, timeoutMs = 3000): Promise<string | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const row = await eventRow(id);
      if (row?.reflection != null) return row.reflection;
      await new Promise((r) => setTimeout(r, 25));
    }
    return (await eventRow(id))?.reflection ?? null;
  }

  it("stores the event turn's final text on the event row (exact via trigger_event_id)", async () => {
    const mind = uniqueMind();
    const stub = await stubMind(mind);
    try {
      const { id } = await deliverEvent(mind, { type: "schedule", body: "reflect on this" });
      await runEventTurn(mind, id!, "schedule", "I tended the garden and felt calm.");
      assert.equal(await waitForReflection(id!), "I tended the garden and felt calm.");
    } finally {
      stub.close();
      await cleanupMind(mind);
    }
  });

  it("an unrelated turn completing first does NOT steal the reflection", async () => {
    const mind = uniqueMind();
    const stub = await stubMind(mind);
    try {
      const { id } = await deliverEvent(mind, { type: "schedule", body: "morning check" });

      // A normal chat turn on the same session completes before the event turn: its
      // trigger links to the chat inbound, so it must record nothing on the event.
      const { recordInbound } = await import(
        "../packages/daemon/src/lib/delivery/message-delivery.js"
      );
      await recordInbound(mind, "@alice", "alice", "hey, private question");
      await handleMindEvent(mind, {
        type: "text",
        session: "main",
        channel: "@alice",
        content: "A private reply meant only for alice.",
      });
      await handleMindEvent(mind, { type: "done", session: "main" });
      // Give the fire-and-forget capture a moment; it must NOT write anything.
      await new Promise((r) => setTimeout(r, 150));

      assert.equal(
        (await eventRow(id!))?.reflection,
        null,
        "chat turn's closing text must not become the event's reflection",
      );

      // The event's own turn then completes and is attributed exactly.
      await runEventTurn(mind, id!, "schedule", "The garden is fine.");
      assert.equal(await waitForReflection(id!), "The garden is fine.");
    } finally {
      stub.close();
      await cleanupMind(mind);
    }
  });

  it("two events into one session are each attributed to their own turn", async () => {
    const mind = uniqueMind();
    const stub = await stubMind(mind);
    try {
      const { id: id1 } = await deliverEvent(mind, { type: "schedule", body: "first event" });
      const { id: id2 } = await deliverEvent(mind, { type: "webhook", body: "second event" });

      await runEventTurn(mind, id1!, "schedule", "Reflection one.");
      await runEventTurn(mind, id2!, "webhook", "Reflection two.");

      assert.equal(await waitForReflection(id1!), "Reflection one.");
      assert.equal(await waitForReflection(id2!), "Reflection two.");
    } finally {
      stub.close();
      await cleanupMind(mind);
    }
  });

  it("captureReflection is a no-op for a turn with no trigger", async () => {
    const mind = uniqueMind();
    const db = await getDb();
    await db.insert(turns).values({ id: `${mind}-t`, mind, thread: "main", status: "complete" });
    try {
      await captureReflection(mind, `${mind}-t`); // must not throw
    } finally {
      await cleanupMind(mind);
    }
  });
});

// --- Ports of the notices.test.ts cases over the new table ---

describe("system-events next-turn drain", () => {
  it("records and drains notices per session, oldest first", async () => {
    const mind = uniqueMind();
    await recordNotice({
      mind,
      thread: "main",
      kind: "turn_error",
      reason: "auth_error",
      detail: "first",
    });
    await recordNotice({
      mind,
      thread: "main",
      kind: "turn_error",
      reason: "rate_limit",
      detail: "second",
    });
    await recordNotice({
      mind,
      thread: "other",
      kind: "crash",
      reason: "process_crash",
      detail: "elsewhere",
    });

    const main = await drainEvents(mind, "main");
    assert.deepEqual(
      main.map((n) => n.body),
      ["first", "second"],
    );
    const other = await drainEvents(mind, "other");
    assert.deepEqual(
      other.map((n) => n.body),
      ["elsewhere"],
    );
    await cleanupMind(mind);
  });

  it("clears delivered events up to a watermark id, leaving newer ones queued", async () => {
    const mind = uniqueMind();
    await recordNotice({
      mind,
      thread: "main",
      kind: "turn_error",
      reason: "unknown",
      detail: "a",
    });
    await recordNotice({
      mind,
      thread: "main",
      kind: "turn_error",
      reason: "unknown",
      detail: "b",
    });

    const drained = await drainEvents(mind, "main");
    assert.equal(drained.length, 2);
    const watermark = Math.max(...drained.map((n) => n.id));

    // An event created AFTER the drain (id > watermark) must survive the clear.
    await recordNotice({
      mind,
      thread: "main",
      kind: "budget",
      reason: "token_budget",
      detail: "c",
    });

    await clearDeliveredEvents(mind, "main", watermark);
    const remaining = await drainEvents(mind, "main");
    assert.deepEqual(
      remaining.map((n) => n.body),
      ["c"],
    );
    await cleanupMind(mind);
  });

  it("mind-level events (session '') drain into any session and clear by watermark", async () => {
    const mind = uniqueMind();
    await recordNotice({
      mind,
      thread: "main",
      kind: "turn_error",
      reason: "unknown",
      detail: "session-scoped",
    });
    await recordNotice({
      mind,
      thread: "",
      kind: "extension",
      reason: "notes",
      detail: "pip commented on your note",
    });

    // Draining "main" picks up both (mind-level included), oldest first.
    const drained = await drainEvents(mind, "main");
    assert.deepEqual(
      drained.map((n) => n.body),
      ["session-scoped", "pip commented on your note"],
    );

    // A clean turn clears both by watermark — the "" row must not redeliver.
    await clearDeliveredEvents(mind, "main", Math.max(...drained.map((n) => n.id)));
    assert.deepEqual(await drainEvents(mind, "main"), []);
    assert.deepEqual(await drainEvents(mind, "other"), []);
    await cleanupMind(mind);
  });

  it("caps retained next-turn events per session by stamping overflow dropped (not deleting)", async () => {
    const mind = uniqueMind();
    for (let i = 0; i < 110; i++) {
      await recordNotice({
        mind,
        thread: "main",
        kind: "turn_error",
        reason: "network",
        detail: `n${i}`,
      });
    }
    const drained = await drainEvents(mind, "main", 1000);
    assert.equal(drained.length, 100, "should retain at most the cap (100) pending");
    assert.ok(
      drained.some((n) => n.body === "n109"),
      "newest kept",
    );
    assert.ok(!drained.some((n) => n.body === "n0"), "oldest no longer pending");

    // The overflow rows still exist for the events UI, stamped dropped.
    const db = await getDb();
    const all = await db.select().from(systemEvents).where(eq(systemEvents.mind, mind));
    assert.equal(all.length, 110, "no rows deleted");
    const dropped = all.filter((r) => parseMeta(r.meta).dropped);
    assert.equal(dropped.length, 10);
    assert.ok(dropped.every((r) => r.delivered_at != null));
    await cleanupMind(mind);
  });
});

describe("system-events latestFailureEvent", () => {
  it("returns null when the mind has no events", async () => {
    assert.equal(await latestFailureEvent(uniqueMind()), null);
  });

  it("returns the newest failure across sessions, ignoring budget/extension", async () => {
    const mind = uniqueMind();
    await recordNotice({
      mind,
      thread: "main",
      kind: "turn_error",
      reason: "network",
      detail: "older",
    });
    await recordNotice({
      mind,
      thread: "other",
      kind: "crash",
      reason: "process_crash",
      detail: "newer",
    });
    await recordNotice({
      mind,
      thread: "main",
      kind: "budget",
      reason: "token_budget",
      detail: "budget pause",
    });
    await recordNotice({
      mind,
      thread: "",
      kind: "extension",
      reason: "notes",
      detail: "someone commented",
    });

    const failure = await latestFailureEvent(mind);
    assert.equal(failure?.kind, "crash");
    assert.equal(failure?.reason, "process_crash");
    assert.equal(failure?.detail, "newer");
    assert.ok(failure?.at, "should carry the event timestamp");
    await cleanupMind(mind);
  });

  it("clears once delivered events are stamped (recovery on a clean turn)", async () => {
    const mind = uniqueMind();
    await recordNotice({
      mind,
      thread: "main",
      kind: "turn_error",
      reason: "overloaded",
      detail: "a 529",
    });
    assert.ok(await latestFailureEvent(mind));

    const drained = await drainEvents(mind, "main");
    await clearDeliveredEvents(mind, "main", Math.max(...drained.map((n) => n.id)));
    assert.equal(await latestFailureEvent(mind), null);
    await cleanupMind(mind);
  });

  it("clears when another session completes a turn after the failure (cross-session recovery)", async () => {
    const mind = uniqueMind();
    await recordNotice({
      mind,
      thread: "quiet-channel",
      kind: "crash",
      reason: "process_crash",
      detail: "crashed",
    });
    assert.ok(await latestFailureEvent(mind));

    const db = await getDb();
    await db.insert(turns).values({
      id: `${mind}-turn-1`,
      mind,
      thread: "main",
      status: "complete",
      created_at: "2999-01-01 00:00:00",
    });
    try {
      assert.equal(await latestFailureEvent(mind), null);
    } finally {
      await cleanupMind(mind);
    }
  });

  it("a turn completed before the failure does not count as recovery", async () => {
    const mind = uniqueMind();
    const db = await getDb();
    await db.insert(turns).values({
      id: `${mind}-turn-0`,
      mind,
      thread: "main",
      status: "complete",
      created_at: "2000-01-01 00:00:00",
    });
    try {
      await recordNotice({
        mind,
        thread: "main",
        kind: "turn_error",
        reason: "network",
        detail: "still broken",
      });
      assert.equal((await latestFailureEvent(mind))?.detail, "still broken");
    } finally {
      await cleanupMind(mind);
    }
  });
});

describe("system-events status surfaces", () => {
  it("latestEvent returns the newest un-drained next-turn event across sessions", async () => {
    const mind = uniqueMind();
    assert.equal(await latestEvent(mind), null);
    await recordNotice({
      mind,
      thread: "main",
      kind: "turn_error",
      reason: "auth_error",
      detail: "older",
    });
    await recordNotice({
      mind,
      thread: "",
      kind: "startup",
      reason: "no_credentials",
      detail: "newest",
    });
    const latest = await latestEvent(mind);
    assert.equal(latest?.detail, "newest");
    assert.equal(latest?.reason, "no_credentials");
    await cleanupMind(mind);
  });

  it("hasUndeliveredEvent detects (and dedupes) a reason for a mind", async () => {
    const mind = uniqueMind();
    assert.equal(await hasUndeliveredEvent(mind, "no_credentials"), false);
    await recordNotice({
      mind,
      thread: "",
      kind: "startup",
      reason: "no_credentials",
      detail: "mute",
    });
    assert.equal(await hasUndeliveredEvent(mind, "no_credentials"), true);
    assert.equal(await hasUndeliveredEvent(mind, "process_crash"), false);
    await cleanupMind(mind);
  });
});

describe("system-events cleanExpiredEvents", () => {
  it("sweeps delivered events past the retention window and keeps everything else", async () => {
    const mind = uniqueMind();
    const db = await getDb();
    const day = 24 * 60 * 60 * 1000;
    const ago = (ms: number) =>
      new Date(Date.now() - ms).toISOString().replace("T", " ").slice(0, 19);

    await db.insert(systemEvents).values([
      // Delivered, well past the 30-day retention window — swept.
      {
        mind,
        type: "notice",
        body: "old delivered",
        delivery: "next-turn",
        thread: "main",
        created_at: ago(40 * day),
        delivered_at: ago(40 * day),
      },
      // Delivered, but recent — survives.
      {
        mind,
        type: "notice",
        body: "recent delivered",
        delivery: "next-turn",
        thread: "main",
        created_at: ago(day),
        delivered_at: ago(day),
      },
      // Undelivered and old — must survive: pending rows are never swept by age alone,
      // only by the per-(mind,thread) cap and flush-time expiry.
      {
        mind,
        type: "notice",
        body: "old pending",
        delivery: "next-turn",
        thread: "main",
        created_at: ago(40 * day),
        delivered_at: null,
      },
    ]);

    await cleanExpiredEvents();

    const rows = await db.select().from(systemEvents).where(eq(systemEvents.mind, mind));
    const bodies = rows.map((r) => r.body).sort();
    assert.deepEqual(bodies, ["old pending", "recent delivered"]);

    await cleanupMind(mind);
  });
});

describe("system-events eventLabel", () => {
  it("produces worded labels, never raw ids in isolation", () => {
    assert.equal(
      eventLabel("schedule", { scheduleId: "morning-check" }),
      "Schedule: morning-check",
    );
    assert.equal(eventLabel("wake", null), "Woke from sleep");
    assert.equal(eventLabel("lifecycle", { subtype: "merge" }), "Variant merged in");
    assert.equal(eventLabel("webhook", { source: "github" }), "Webhook: github");
  });
});

describe("system-events pendingEventsLine", () => {
  it("mentions the pending count with singular/plural phrasing", () => {
    assert.equal(pendingEventsLine(0), "");
    assert.match(pendingEventsLine(1), /1 system event arrived while you slept/);
    assert.match(pendingEventsLine(3), /3 system events arrived while you slept/);
  });
});

describe("system-events formatEvents", () => {
  const base = {
    mind: "m",
    thread: "s",
    delivery: "next-turn",
    delivered_at: null,
    reflection: null,
    body: "",
  };
  const at = (t: string) => `2026-06-22 ${t}:00`;
  const noticeMeta = (subtype: string, reason: string) => JSON.stringify({ subtype, reason });
  // Mirror formatEvents' UTC→local rendering so assertions hold in any timezone.
  const localHM = (utc: string) =>
    new Date(`${utc.replace(" ", "T")}Z`).toLocaleTimeString("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
    });

  it("returns null for an empty list", () => {
    assert.equal(formatEvents([]), null);
  });

  it("uses singular phrasing for a single failure", () => {
    const events = [
      {
        ...base,
        id: 1,
        type: "notice",
        body: "creds",
        meta: noticeMeta("turn_error", "auth_error"),
        created_at: at("14:02"),
      },
    ] as SystemEvent[];
    const out = formatEvents(events)!;
    assert.match(out, /1 turn failed/);
    assert.ok(!/1 turns/.test(out));
  });

  it("groups same-reason failures with a count and local time span", () => {
    const events = [
      {
        ...base,
        id: 1,
        type: "notice",
        body: "net",
        meta: noticeMeta("turn_error", "network"),
        created_at: at("14:02"),
      },
      {
        ...base,
        id: 2,
        type: "notice",
        body: "net",
        meta: noticeMeta("turn_error", "network"),
        created_at: at("14:31"),
      },
    ] as SystemEvent[];
    const out = formatEvents(events)!;
    assert.equal(out.split("\n").filter((l) => l.startsWith("- ")).length, 1);
    assert.ok(
      out.includes(`2 turns failed (${localHM(at("14:02"))}–${localHM(at("14:31"))}): net`),
    );
  });

  it("renders one line per distinct reason", () => {
    const events = [
      {
        ...base,
        id: 1,
        type: "notice",
        body: "creds",
        meta: noticeMeta("turn_error", "auth_error"),
        created_at: at("14:02"),
      },
      {
        ...base,
        id: 2,
        type: "notice",
        body: "net",
        meta: noticeMeta("turn_error", "network"),
        created_at: at("14:05"),
      },
      {
        ...base,
        id: 3,
        type: "notice",
        body: "net",
        meta: noticeMeta("turn_error", "network"),
        created_at: at("14:06"),
      },
    ] as SystemEvent[];
    const out = formatEvents(events)!;
    const lines = out.split("\n").filter((l) => l.startsWith("- "));
    assert.equal(lines.length, 2);
    assert.ok(lines.some((l) => /1 turn failed/.test(l) && /creds/.test(l)));
    assert.ok(lines.some((l) => /2 turns failed/.test(l) && /net/.test(l)));
  });

  it("renders extension notices verbatim under a per-extension header", () => {
    const events = [
      {
        ...base,
        id: 1,
        type: "notice",
        body: "pip commented on whorl/one-macaroni",
        meta: noticeMeta("extension", "notes"),
        created_at: at("14:02"),
      },
      {
        ...base,
        id: 2,
        type: "notice",
        body: "pip reacted 🌱 to whorl/calendar",
        meta: noticeMeta("extension", "notes"),
        created_at: at("15:10"),
      },
    ] as SystemEvent[];
    const out = formatEvents(events)!;
    assert.match(out, /\[Notes\]/);
    assert.match(out, /pip commented on whorl\/one-macaroni/);
    assert.match(out, /pip reacted 🌱/);
    assert.ok(!/turn failed/.test(out));
  });

  it("keeps failure and extension notices in separate blocks", () => {
    const events = [
      {
        ...base,
        id: 1,
        type: "notice",
        body: "creds",
        meta: noticeMeta("turn_error", "auth_error"),
        created_at: at("14:02"),
      },
      {
        ...base,
        id: 2,
        type: "notice",
        body: "someone commented",
        meta: noticeMeta("extension", "notes"),
        created_at: at("14:05"),
      },
    ] as SystemEvent[];
    const out = formatEvents(events)!;
    assert.match(out, /turn failed/);
    assert.match(out, /\[Notes\]/);
    assert.ok(out.indexOf("[Notices]") < out.indexOf("[Notes]"));
  });

  it("renders budget and version events in their own blocks", () => {
    const events = [
      { ...base, id: 1, type: "budget", body: "budget pause", meta: null, created_at: at("14:02") },
      { ...base, id: 2, type: "version", body: "v2 is out", meta: null, created_at: at("14:05") },
    ] as SystemEvent[];
    const out = formatEvents(events)!;
    assert.match(out, /\[Budget\]\n- .*budget pause/);
    assert.match(out, /\[Update\]\n- .*v2 is out/);
  });

  it("falls back to a generic block for unknown types — nothing drained may vanish", () => {
    const events = [
      {
        ...base,
        id: 1,
        type: "some-new-type",
        body: "novel content",
        meta: null,
        created_at: at("14:02"),
      },
      {
        ...base,
        id: 2,
        type: "notice",
        body: "odd subtype",
        meta: noticeMeta("mystery", "x"),
        created_at: at("14:03"),
      },
    ] as SystemEvent[];
    const out = formatEvents(events)!;
    assert.match(out, /\[Events\]/);
    assert.match(out, /novel content/);
    assert.match(out, /odd subtype/);
  });
});
