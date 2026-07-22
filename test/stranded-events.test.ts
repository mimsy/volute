import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { findStrandedEventMinds } from "../packages/daemon/src/lib/chat/system-events.js";
import { getDb } from "../packages/daemon/src/lib/db.js";
import { systemEvents, turns } from "../packages/daemon/src/lib/schema.js";

/** A zone-less UTC DB timestamp `ms` in the past — the shape SQLite's datetime('now') writes. */
function ago(ms: number): string {
  return new Date(Date.now() - ms).toISOString().replace("T", " ").slice(0, 19);
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

let seq = 0;
function uniqueMind(label: string): string {
  seq += 1;
  return `stranded-${label}-${process.pid}-${seq}`;
}

async function seedPendingEvent(mind: string, createdAt: string): Promise<void> {
  const db = await getDb();
  await db.insert(systemEvents).values({
    mind,
    type: "notice",
    body: "your process crashed mid-turn",
    meta: JSON.stringify({ subtype: "crash", reason: "crash" }),
    delivery: "next-turn",
    thread: "main",
    created_at: createdAt,
  });
}

async function seedTurns(mind: string, count: number, createdAt: string): Promise<void> {
  const db = await getDb();
  for (let i = 0; i < count; i++) {
    await db.insert(turns).values({
      id: `${mind}-turn-${i}`,
      mind,
      thread: "main",
      status: "complete",
      created_at: createdAt,
    });
  }
}

async function findFor(mind: string, threshold?: number) {
  const all = await findStrandedEventMinds(threshold);
  return all.find((s) => s.mind === mind);
}

describe("findStrandedEventMinds", () => {
  it("flags a mind that keeps taking turns without draining its next-turn events", async () => {
    // The production shape: events recorded, many completed turns since, nothing drained.
    const mind = uniqueMind("deaf");
    await seedPendingEvent(mind, ago(6 * DAY));
    await seedPendingEvent(mind, ago(5 * DAY));
    await seedTurns(mind, 46, ago(DAY));

    const found = await findFor(mind);

    assert.ok(found, "a mind with 46 turns and 2 undrained events must be flagged");
    assert.equal(found.pending, 2);
    assert.equal(found.turnsSince, 46);
    // Age is derived from a zone-less UTC string; parsing it as local time would
    // skew this by the host's offset (the recurring bug parseDbTimestamp exists for).
    assert.ok(
      Math.abs(found.ageHours - 6 * 24) <= 1,
      `oldest event should read ~144h old, got ${found.ageHours}`,
    );
  });

  it("stays quiet for a mind that has not yet taken enough turns", async () => {
    // A pending event is normal until a turn has had the chance to drain it.
    const mind = uniqueMind("patient");
    await seedPendingEvent(mind, ago(HOUR));
    await seedTurns(mind, 2, ago(30 * 60 * 1000));

    assert.equal(await findFor(mind), undefined);
  });

  it("stays quiet for a mind whose events are all delivered", async () => {
    const mind = uniqueMind("healthy");
    const db = await getDb();
    await db.insert(systemEvents).values({
      mind,
      type: "notice",
      body: "delivered fine",
      delivery: "next-turn",
      thread: "main",
      created_at: ago(2 * DAY),
      delivered_at: ago(2 * DAY),
    });
    await seedTurns(mind, 50, ago(DAY));

    assert.equal(await findFor(mind), undefined);
  });

  it("ignores turns that predate the oldest pending event", async () => {
    // Turns run *before* the event was recorded had nothing to drain, so they
    // are no evidence the drain is broken.
    const mind = uniqueMind("earlier");
    await seedTurns(mind, 50, ago(10 * DAY));
    await seedPendingEvent(mind, ago(HOUR));

    assert.equal(await findFor(mind), undefined);
  });

  it("ignores incomplete turns", async () => {
    // Only a clean turn drains; an active or failed one proves nothing.
    const mind = uniqueMind("incomplete");
    await seedPendingEvent(mind, ago(2 * DAY));
    const db = await getDb();
    for (let i = 0; i < 30; i++) {
      await db.insert(turns).values({
        id: `${mind}-active-${i}`,
        mind,
        thread: "main",
        status: "active",
        created_at: ago(DAY),
      });
    }

    assert.equal(await findFor(mind), undefined);
  });

  it("does not flag immediate-delivery events, which use a different path", async () => {
    const mind = uniqueMind("immediate");
    const db = await getDb();
    await db.insert(systemEvents).values({
      mind,
      type: "schedule",
      body: "queued while asleep",
      delivery: "immediate",
      thread: "main",
      created_at: ago(2 * DAY),
    });
    await seedTurns(mind, 50, ago(DAY));

    assert.equal(await findFor(mind), undefined);
  });

  it("honours the turn threshold", async () => {
    const mind = uniqueMind("threshold");
    await seedPendingEvent(mind, ago(2 * DAY));
    await seedTurns(mind, 5, ago(DAY));

    assert.equal(await findFor(mind, 10), undefined, "5 turns is under the default threshold");
    assert.ok(await findFor(mind, 5), "5 turns meets a threshold of 5");
  });

  it("reports each affected mind separately", async () => {
    const a = uniqueMind("multi-a");
    const b = uniqueMind("multi-b");
    await seedPendingEvent(a, ago(3 * DAY));
    await seedTurns(a, 20, ago(DAY));
    await seedPendingEvent(b, ago(3 * DAY));
    await seedPendingEvent(b, ago(2 * DAY));
    await seedTurns(b, 30, ago(DAY));

    const foundA = await findFor(a);
    const foundB = await findFor(b);

    assert.equal(foundA?.pending, 1);
    assert.equal(foundB?.pending, 2);
  });
});
