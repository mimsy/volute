import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { eq } from "drizzle-orm";
import {
  COALESCE_WINDOW_MINUTES,
  recordDeliveryFailure,
  recordSenderDeliveryFailure,
} from "../packages/daemon/src/lib/chat/delivery-notices.js";
import {
  drainEvents,
  MIND_LEVEL_THREAD,
  parseMeta,
  type SystemEvent,
} from "../packages/daemon/src/lib/chat/system-events.js";
import { Scheduler } from "../packages/daemon/src/lib/daemon/scheduler.js";
import { getDb } from "../packages/daemon/src/lib/db.js";
import { addMind, addVariant, removeMind } from "../packages/daemon/src/lib/mind/registry.js";
import type { Schedule } from "../packages/daemon/src/lib/mind/volute-config.js";
import { systemEvents } from "../packages/daemon/src/lib/schema.js";

let counter = 0;
function uniqueMind(): string {
  return `dn-${Date.now()}-${counter++}`;
}

function metaOf(e: SystemEvent): Record<string, unknown> {
  return parseMeta(e.meta);
}

async function failureRows(mind: string): Promise<SystemEvent[]> {
  const db = await getDb();
  const rows = await db.select().from(systemEvents).where(eq(systemEvents.mind, mind));
  return rows.filter((r) => metaOf(r).subtype === "delivery_failed");
}

describe("recordDeliveryFailure", () => {
  it("records a mind-level notice drained by any thread", async () => {
    const mind = uniqueMind();
    await recordDeliveryFailure({ mind, channel: "discord:srv/general", reason: "bridge down" });

    const drained = await drainEvents(mind, "some-unrelated-thread");
    assert.equal(drained.length, 1, "mind-level notice drains into any thread");
    assert.match(drained[0].body, /discord:srv\/general/);
    assert.match(drained[0].body, /could not be delivered/);
    assert.match(drained[0].body, /bridge down/);
    const meta = metaOf(drained[0]);
    assert.equal(meta.subtype, "delivery_failed");
    assert.equal(meta.channel, "discord:srv/general");
    assert.equal(meta.count, 1);
  });

  it("scopes the notice to a thread when one is given", async () => {
    const mind = uniqueMind();
    await recordDeliveryFailure({
      mind,
      channel: "#planning",
      reason: "boom",
      thread: "planning",
    });

    const other = await drainEvents(mind, "main");
    assert.equal(other.length, 0, "thread-scoped notice must not drain into other threads");
    const scoped = await drainEvents(mind, "planning");
    assert.equal(scoped.length, 1, "the named thread drains it");
  });

  it("coalesces repeated failures to one (mind, channel) into a single counted notice", async () => {
    const mind = uniqueMind();
    for (let i = 0; i < 3; i++) {
      await recordDeliveryFailure({ mind, channel: "slack:ws/random", reason: `err ${i}` });
    }
    await recordDeliveryFailure({ mind, channel: "slack:ws/other", reason: "different channel" });

    const rows = await failureRows(mind);
    assert.equal(rows.length, 2, "one row per channel, not per failure");
    const coalesced = rows.find((r) => metaOf(r).channel === "slack:ws/random");
    assert.ok(coalesced);
    assert.equal(metaOf(coalesced).count, 3);
    assert.match(coalesced.body, /3 messages to slack:ws\/random/);
    assert.match(coalesced.body, /err 2/, "body carries the latest error");
    const single = rows.find((r) => metaOf(r).channel === "slack:ws/other");
    assert.equal(metaOf(single!).count, 1);
  });

  it("does not coalesce into a notice older than the window", async () => {
    const mind = uniqueMind();
    await recordDeliveryFailure({ mind, channel: "#ch", reason: "first" });

    // Age the first notice past the coalescing window.
    const db = await getDb();
    const [row] = await failureRows(mind);
    const old = new Date(Date.now() - (COALESCE_WINDOW_MINUTES + 5) * 60_000)
      .toISOString()
      .replace("T", " ")
      .slice(0, 19);
    await db.update(systemEvents).set({ created_at: old }).where(eq(systemEvents.id, row.id));

    await recordDeliveryFailure({ mind, channel: "#ch", reason: "second" });
    const rows = await failureRows(mind);
    assert.equal(rows.length, 2, "a stale notice starts a new group");
  });

  it("does not coalesce into an already-drained notice", async () => {
    const mind = uniqueMind();
    await recordDeliveryFailure({ mind, channel: "#ch", reason: "first" });

    const db = await getDb();
    const [row] = await failureRows(mind);
    await db
      .update(systemEvents)
      .set({ delivered_at: row.created_at })
      .where(eq(systemEvents.id, row.id));

    await recordDeliveryFailure({ mind, channel: "#ch", reason: "second" });
    const rows = await failureRows(mind);
    assert.equal(rows.length, 2, "a delivered notice must not be mutated");
    const pending = rows.filter((r) => !r.delivered_at);
    assert.equal(pending.length, 1);
    assert.equal(metaOf(pending[0]).count, 1);
  });
});

describe("recordSenderDeliveryFailure", () => {
  it("no-ops for a sender that is not a mind", async () => {
    const sender = uniqueMind(); // never registered
    await recordSenderDeliveryFailure(sender, "#ch", "boom");
    assert.equal((await failureRows(sender)).length, 0);
  });

  it("records under the base name for a variant sender", async () => {
    const parent = uniqueMind();
    const variant = `${parent}-v1`;
    await addMind(parent, 4899);
    await addVariant(variant, parent, 4898, "/tmp/x", "branch");
    try {
      await recordSenderDeliveryFailure(variant, "#ch", "boom");
      const rows = await failureRows(parent);
      assert.equal(rows.length, 1, "notice lands on the base mind, which drains notices");
      assert.equal((await failureRows(variant)).length, 0);
    } finally {
      await removeMind(variant);
      await removeMind(parent);
    }
  });
});

describe("scheduler delivery-failure notice", () => {
  class ExplodingScheduler extends Scheduler {
    protected override async deliverSystem(): Promise<{ id?: number; delivered: boolean }> {
      throw new Error("delivery exploded");
    }
    override async saveState(): Promise<void> {}
  }

  it("records a notice when a schedule fires but delivery throws", async () => {
    const mind = uniqueMind();
    const s = new ExplodingScheduler();
    const schedule: Schedule = { id: "morning-check", message: "hello", enabled: true };
    await (s as unknown as { fire(m: string, sch: Schedule): Promise<void> }).fire(mind, schedule);

    const drained = await drainEvents(mind, "main");
    assert.equal(drained.length, 1, "the failed fire leaves a notice, not just a daemon log");
    assert.match(drained[0].body, /"morning-check"/);
    assert.match(drained[0].body, /could not be delivered/);
    assert.match(drained[0].body, /delivery exploded/);
    assert.equal(metaOf(drained[0]).reason, "schedule_failed");
  });
});
