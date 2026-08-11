import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { eq } from "drizzle-orm";
import {
  deliverEvent,
  drainEvents,
  eventMatchKey,
  MIND_LEVEL_THREAD,
  recordNotice,
} from "../packages/daemon/src/lib/chat/system-events.js";
import { getDb } from "../packages/daemon/src/lib/db.js";
import { clearConfigCache } from "../packages/daemon/src/lib/delivery/delivery-router.js";
import { addMind, removeMind } from "../packages/daemon/src/lib/mind/registry.js";
import { systemEvents } from "../packages/daemon/src/lib/schema.js";

type Posted = { kind?: string; session?: string; event?: { body: string } };

/** A stub mind server recording the envelopes POSTed to /message, with routes.json on disk. */
async function routableMind(
  routes: object,
): Promise<{ name: string; posted: Posted[]; close: () => void }> {
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
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, event: true }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const name = `evroute-${process.pid}-${port}`;
  await addMind(name, port);
  const configDir = resolve(process.env.VOLUTE_HOME!, "minds", name, "home/.config");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(resolve(configDir, "routes.json"), JSON.stringify(routes));
  clearConfigCache(name);
  return { name, posted, close: () => server.close() };
}

async function cleanup(name: string): Promise<void> {
  const db = await getDb();
  await db.delete(systemEvents).where(eq(systemEvents.mind, name));
  clearConfigCache(name);
  await removeMind(name);
}

async function threadOf(id: number): Promise<string | undefined> {
  const db = await getDb();
  const row = await db.select().from(systemEvents).where(eq(systemEvents.id, id)).get();
  return row?.thread;
}

describe("eventMatchKey", () => {
  it("builds <type>:<discriminator> keys, or the bare type", () => {
    assert.equal(eventMatchKey("schedule", { scheduleId: "dream" }), "schedule:dream");
    assert.equal(eventMatchKey("webhook", { source: "stripe" }), "webhook:stripe");
    assert.equal(eventMatchKey("notice", { subtype: "crash" }), "notice:crash");
    assert.equal(eventMatchKey("lifecycle", { subtype: "merge" }), "lifecycle:merge");
    assert.equal(eventMatchKey("budget", {}), "budget");
    assert.equal(eventMatchKey("schedule", {}), "schedule");
  });
});

describe("event routing (daemon-side, via routes.json)", () => {
  it("a schedule:* rule routes a schedule fire to the mapped thread", async () => {
    const m = await routableMind({ rules: [{ event: "schedule:*", thread: "chores" }] });
    try {
      const { delivered } = await deliverEvent(m.name, {
        type: "schedule",
        body: "tidy",
        meta: { scheduleId: "heartbeat" },
      });
      assert.equal(delivered, true);
      assert.equal(m.posted[0]?.session, "chores");
    } finally {
      m.close();
      await cleanup(m.name);
    }
  });

  it("an exact schedule:<id> rule beats a schedule:* rule (first match wins)", async () => {
    const m = await routableMind({
      rules: [
        { event: "schedule:dream", thread: "dreamland" },
        { event: "schedule:*", thread: "chores" },
      ],
    });
    try {
      await deliverEvent(m.name, { type: "schedule", body: "d", meta: { scheduleId: "dream" } });
      await deliverEvent(m.name, {
        type: "schedule",
        body: "h",
        meta: { scheduleId: "heartbeat" },
      });
      assert.equal(m.posted[0]?.session, "dreamland");
      assert.equal(m.posted[1]?.session, "chores");
    } finally {
      m.close();
      await cleanup(m.name);
    }
  });

  it("a webhook:* rule routes webhook events", async () => {
    const m = await routableMind({ rules: [{ event: "webhook:*", thread: "inbox" }] });
    try {
      await deliverEvent(m.name, { type: "webhook", body: "ping", meta: { source: "gh" } });
      assert.equal(m.posted[0]?.session, "inbox");
    } finally {
      m.close();
      await cleanup(m.name);
    }
  });

  it("a matched rule beats the main default; no rule falls back to main", async () => {
    const m = await routableMind({ rules: [{ event: "schedule:reports", thread: "work" }] });
    try {
      // Unmatched schedule → the "main" default, not the rule.
      await deliverEvent(m.name, { type: "schedule", body: "x", meta: { scheduleId: "other" } });
      assert.equal(m.posted[0]?.session, "main");
      // Matched schedule → the rule's thread.
      await deliverEvent(m.name, { type: "schedule", body: "y", meta: { scheduleId: "reports" } });
      assert.equal(m.posted[1]?.session, "work");
    } finally {
      m.close();
      await cleanup(m.name);
    }
  });

  it("channel rules never route events, and event rules never route channels", async () => {
    // A mind whose only rule is a channel rule: an event falls through to main.
    const m = await routableMind({ rules: [{ channel: "#*", thread: "chatter" }] });
    try {
      await deliverEvent(m.name, { type: "schedule", body: "x", meta: { scheduleId: "s" } });
      assert.equal(m.posted[0]?.session, "main");
    } finally {
      m.close();
      await cleanup(m.name);
    }
  });

  it("$new expands to a fresh isolated session for immediate delivery", async () => {
    const m = await routableMind({ rules: [{ event: "schedule:dream", thread: "$new" }] });
    try {
      await deliverEvent(m.name, {
        type: "schedule",
        body: "dream",
        meta: { scheduleId: "dream" },
      });
      assert.match(m.posted[0]?.session ?? "", /^new-/);
    } finally {
      m.close();
      await cleanup(m.name);
    }
  });

  it("stranding: a next-turn event routed to $new collapses to the mind-level drain, not lost", async () => {
    // $new for a next-turn event would mint a unique session that never runs a turn and
    // strand the event forever (#356/#735). It must collapse to MIND_LEVEL_THREAD, which
    // any thread's next drain surfaces.
    const m = await routableMind({ rules: [{ event: "webhook:*", thread: "$new" }] });
    try {
      const { id } = await deliverEvent(m.name, {
        type: "webhook",
        body: "async",
        meta: { source: "gh" },
        delivery: "next-turn",
      });
      assert.ok(id);
      assert.equal(await threadOf(id!), MIND_LEVEL_THREAD);
      // Drains into an arbitrary, unrelated thread — proof it isn't stranded.
      const drained = await drainEvents(m.name, "some-unrelated-thread");
      assert.ok(drained.some((e) => e.id === id));
    } finally {
      m.close();
      await cleanup(m.name);
    }
  });

  it("non-routable: a crash/turn_error notice ignores a rule that would route it away", async () => {
    // A mind routes ALL notices to a named thread — but crash/turn_error must land at
    // mind-level attention regardless, so a routing mistake can't bury a failure notice.
    const m = await routableMind({ rules: [{ event: "notice:*", thread: "hideaway" }] });
    try {
      for (const kind of ["crash", "turn_error"] as const) {
        await recordNotice({
          mind: m.name,
          thread: "somewhere", // a caller-chosen thread the pin overrides
          kind,
          reason: `${kind}_test`,
          detail: "boom",
        });
      }
      const db = await getDb();
      const rows = await db.select().from(systemEvents).where(eq(systemEvents.mind, m.name)).all();
      assert.equal(rows.length, 2);
      assert.equal(
        rows.every((r) => r.thread === MIND_LEVEL_THREAD),
        true,
        "crash/turn_error notices pin to mind-level, not the routed thread",
      );
      // A routable notice (delivery_failed) still honours the same rule.
      await recordNotice({
        mind: m.name,
        thread: MIND_LEVEL_THREAD,
        kind: "delivery_failed",
        reason: "df",
        detail: "x",
      });
      const df = await db
        .select()
        .from(systemEvents)
        .where(eq(systemEvents.mind, m.name))
        .orderBy(systemEvents.id)
        .all();
      assert.equal(df.at(-1)?.thread, "hideaway");
    } finally {
      m.close();
      await cleanup(m.name);
    }
  });
});
