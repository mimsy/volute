import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { beforeEach, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import {
  _resetReflectionState,
  captureReflection,
  clearDeliveredEvents,
  deliverEvent,
  drainEvents,
  eventLabel,
  flushQueuedEvents,
  formatEvents,
  hasUndeliveredEvent,
  latestEvent,
  latestFailureEvent,
  recordNotice,
} from "../packages/daemon/src/lib/chat/system-events.js";
import {
  getSleepManagerIfReady,
  initSleepManager,
} from "../packages/daemon/src/lib/daemon/sleep-manager.js";
import { getDb } from "../packages/daemon/src/lib/db.js";
import { addMind, removeMind } from "../packages/daemon/src/lib/mind/registry.js";
import { mindHistory, systemEvents } from "../packages/daemon/src/lib/schema.js";

type Posted = {
  kind?: string;
  event?: { label: string; body: string; type: string };
  session?: string;
};

/** A stub mind server that records the envelopes POSTed to /message. */
async function stubMind(
  name: string,
  opts: { status?: number } = {},
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
      res.end("{}");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  await addMind(name, port);
  return { port, posted, close: () => server.close() };
}

describe("system-events deliverEvent", () => {
  beforeEach(() => _resetReflectionState());

  it("immediate: POSTs an event envelope, stamps delivered_at, records inbound", async () => {
    const mind = "ev-immediate";
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

      const db = await getDb();
      const row = await db.select().from(systemEvents).where(eq(systemEvents.id, id!)).get();
      assert.ok(row?.delivered_at, "delivered_at is stamped");

      // Recorded as inbound so history/feed keep working.
      const inbound = await db.select().from(mindHistory).where(eq(mindHistory.mind, mind)).all();
      assert.ok(inbound.some((r) => r.type === "inbound" && r.content === "check the garden"));
    } finally {
      stub.close();
      await removeMind(mind);
    }
  });

  it("next-turn: leaves the row pending, drained + formatted, then marked delivered", async () => {
    const mind = "ev-next-turn";
    await addMind(mind, 0);
    try {
      await recordNotice({
        mind,
        session: "main",
        kind: "turn_error",
        reason: "rate_limit",
        detail: "rate limited",
      });

      const pending = await drainEvents(mind, "main");
      assert.equal(pending.length, 1);
      assert.equal(pending[0].delivery, "next-turn");
      assert.equal(pending[0].body, "rate limited");

      const block = formatEvents(pending);
      assert.ok(block?.includes("rate limited"));
      assert.ok(block?.includes("failed"));

      // Clearing stamps delivered_at (rows persist for the events UI, unlike old notices).
      await clearDeliveredEvents(mind, "main", pending[0].id);
      const after = await drainEvents(mind, "main");
      assert.equal(after.length, 0);
    } finally {
      await removeMind(mind);
    }
  });

  it("sleep queue: an immediate event to a sleeping mind stays pending, then flushes on wake", async () => {
    const mind = "ev-sleep-queue";
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

      const db = await getDb();
      const row = await db.select().from(systemEvents).where(eq(systemEvents.id, id!)).get();
      assert.equal(row?.delivered_at, null, "stays pending");

      // Flush delivers it oldest-first.
      const flushed = await flushQueuedEvents(mind);
      assert.equal(flushed, 1);
      assert.equal(stub.posted.length, 1);
      assert.equal(stub.posted[0].event?.body, "queued while asleep");
    } finally {
      (sm as unknown as { isSleeping: (n: string) => boolean }).isSleeping = realIsSleeping;
      stub.close();
      await removeMind(mind);
    }
  });

  it("sleep skip: an immediate event with whileSleeping=skip is dropped, not flushed", async () => {
    const mind = "ev-sleep-skip";
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
      const db = await getDb();
      const row = await db.select().from(systemEvents).where(eq(systemEvents.id, id!)).get();
      assert.ok(row?.delivered_at, "skip stamps delivered_at so it won't flush");
      assert.match(row?.meta ?? "", /"skipped":true/);

      const flushed = await flushQueuedEvents(mind);
      assert.equal(flushed, 0);
      assert.equal(stub.posted.length, 0, "never delivered");
    } finally {
      (sm as unknown as { isSleeping: (n: string) => boolean }).isSleeping = realIsSleeping;
      stub.close();
      await removeMind(mind);
    }
  });

  it("reflection: the event turn's final text is stored on the event row", async () => {
    const mind = "ev-reflection";
    const stub = await stubMind(mind);
    try {
      const { id } = await deliverEvent(mind, { type: "schedule", body: "reflect on this" });

      // Simulate the turn: a final text event tagged to a turn.
      const db = await getDb();
      await db.insert(mindHistory).values({
        mind,
        type: "text",
        session: "main",
        content: "I tended the garden and felt calm.",
        turn_id: "turn-1",
      });

      await captureReflection(mind, "main", "turn-1");

      const row = await db.select().from(systemEvents).where(eq(systemEvents.id, id!)).get();
      assert.equal(row?.reflection, "I tended the garden and felt calm.");
    } finally {
      stub.close();
      await removeMind(mind);
    }
  });

  it("notice status surfaces: latestFailureEvent + hasUndeliveredEvent + latestEvent", async () => {
    const mind = "ev-notice-status";
    await addMind(mind, 0);
    try {
      await recordNotice({
        mind,
        session: "main",
        kind: "startup",
        reason: "no_credentials",
        detail: "no credentials configured",
      });

      assert.equal(await hasUndeliveredEvent(mind, "no_credentials"), true);
      assert.equal(await hasUndeliveredEvent(mind, "token_budget"), false);

      const failure = await latestFailureEvent(mind);
      assert.equal(failure?.kind, "startup");
      assert.equal(failure?.reason, "no_credentials");

      const latest = await latestEvent(mind);
      assert.equal(latest?.detail, "no credentials configured");
    } finally {
      await removeMind(mind);
    }
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

describe("system-events formatEvents", () => {
  it("returns null for an empty list", () => {
    assert.equal(formatEvents([]), null);
  });

  it("groups repeated failure reasons with a count", () => {
    const now = "2026-07-12 07:30:00";
    const rows = [
      {
        type: "notice",
        body: "auth failed",
        meta: JSON.stringify({ subtype: "turn_error", reason: "auth_error" }),
        created_at: now,
      },
      {
        type: "notice",
        body: "auth failed",
        meta: JSON.stringify({ subtype: "turn_error", reason: "auth_error" }),
        created_at: now,
      },
    ] as never[];
    const block = formatEvents(rows);
    assert.ok(block?.includes("2 turns failed"));
  });
});
