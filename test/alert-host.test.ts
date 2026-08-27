import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { beforeEach, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { alertHost, eventLabel, parseMeta } from "../packages/daemon/src/lib/chat/system-events.js";
import { getSpiritName } from "../packages/daemon/src/lib/config/setup.js";
import { getDb } from "../packages/daemon/src/lib/db.js";
import { addMind, removeMind } from "../packages/daemon/src/lib/mind/registry.js";
import { activity, mindHistory, systemEvents } from "../packages/daemon/src/lib/schema.js";

type Posted = { kind?: string; event?: { label: string; body: string; type: string } };

/** A stub mind server that records the envelopes POSTed to /message. */
async function stubMind(name: string): Promise<{ posted: Posted[]; close: () => void }> {
  const posted: Posted[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      try {
        posted.push(JSON.parse(Buffer.concat(chunks).toString()));
      } catch {
        // not JSON — the assertions below will notice
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, event: true }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  await addMind(name, (server.address() as AddressInfo).port);
  return { posted, close: () => server.close() };
}

async function eventsFor(mind: string) {
  const db = await getDb();
  return db.select().from(systemEvents).where(eq(systemEvents.mind, mind));
}

async function activityFor(mind: string) {
  const db = await getDb();
  return db.select().from(activity).where(eq(activity.mind, mind));
}

/** The spirit is a shared target across these tests — reset it between them. */
async function clearSpiritEvents(): Promise<void> {
  const db = await getDb();
  await db.delete(systemEvents).where(eq(systemEvents.mind, getSpiritName()));
}

async function cleanupMind(mind: string): Promise<void> {
  const db = await getDb();
  await db.delete(systemEvents).where(eq(systemEvents.mind, mind));
  await db.delete(mindHistory).where(eq(mindHistory.mind, mind));
  await db.delete(activity).where(eq(activity.mind, mind));
  await removeMind(mind);
}

let counter = 0;
function uniqueMind(): string {
  counter += 1;
  return `alerth-${process.pid}-${counter}`;
}

describe("alertHost", () => {
  beforeEach(clearSpiritEvents);

  it("delivers the failure text to the mind immediately, verbatim", async () => {
    const mind = uniqueMind();
    const stub = await stubMind(mind);
    const text = "Your framework auto-upgrade failed.\n\nwall: refusing this commit";
    try {
      await alertHost(mind, "upgrade_failed", text);

      assert.equal(stub.posted.length, 1, "the mind must be told, not just the journal");
      assert.equal(stub.posted[0].kind, "event");
      assert.equal(stub.posted[0].event?.body, text);

      const rows = await eventsFor(mind);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].delivery, "immediate");
      assert.ok(rows[0].delivered_at, "delivered_at is stamped once the mind has it");
      assert.equal(parseMeta(rows[0].meta).subtype, "upgrade_failed");
    } finally {
      stub.close();
      await cleanupMind(mind);
    }
  });

  it("leaves the spirit a next-turn notice naming the mind and the kind", async () => {
    const mind = uniqueMind();
    const stub = await stubMind(mind);
    const spirit = getSpiritName();
    try {
      await alertHost(mind, "upgrade_failed", "wall: refusing this commit");

      const spiritRows = (await eventsFor(spirit)).filter(
        (r) => parseMeta(r.meta).reason === "upgrade_failed",
      );
      assert.equal(spiritRows.length, 1, "the spirit gets exactly one notice");
      assert.equal(spiritRows[0].delivery, "next-turn");
      assert.equal(parseMeta(spiritRows[0].meta).subtype, "infrastructure");
      assert.match(spiritRows[0].body, new RegExp(mind));
      assert.match(spiritRows[0].body, /refusing this commit/);
      // The mind-facing text is second person. Without a spirit-addressed lead-in,
      // "Your framework auto-upgrade failed" reads in the spirit's context as the
      // spirit's own failure.
      assert.match(
        spiritRows[0].body,
        /hit an infrastructure failure .*It has been told directly/s,
        "the spirit's copy must say whose failure it is before quoting the mind's text",
      );
    } finally {
      stub.close();
      await cleanupMind(mind);
    }
  });

  it("does not notify the spirit about the spirit's own failure", async () => {
    // The spirit's name is reserved in the registry, so it has no stub server here:
    // the immediate event is still recorded, just left pending. What matters is that
    // exactly one row exists — the spirit must not also be sent a notice about itself.
    const spirit = getSpiritName();
    await alertHost(spirit, "upgrade_failed", "wall: refusing this commit");

    const rows = await eventsFor(spirit);
    assert.equal(rows.length, 1, "one immediate event, no self-addressed notice");
    assert.equal(rows[0].delivery, "immediate");

    const db = await getDb();
    await db.delete(activity).where(eq(activity.mind, spirit));
  });

  it("writes a mind_error activity row the dashboard already renders", async () => {
    const mind = uniqueMind();
    const stub = await stubMind(mind);
    try {
      await alertHost(mind, "upgrade_failed", "Your framework auto-upgrade failed.\n\ndetails");

      const rows = await activityFor(mind);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].type, "mind_error");
      assert.equal(rows[0].summary, "Your framework auto-upgrade failed.");
      assert.equal(JSON.parse(rows[0].metadata ?? "{}").kind, "upgrade_failed");
    } finally {
      stub.close();
      await cleanupMind(mind);
    }
  });

  it("still reaches the other audiences when the mind is unreachable", async () => {
    // No stub server: the POST fails, the event stays pending for the mind's next
    // start. The spirit and the dashboard must still learn about it.
    const mind = uniqueMind();
    await addMind(mind, 1);
    const spirit = getSpiritName();
    try {
      await alertHost(mind, "upgrade_failed", "wall: refusing this commit");

      const mindRows = await eventsFor(mind);
      assert.equal(mindRows.length, 1);
      assert.equal(mindRows[0].delivered_at, null, "left pending for the next start");

      assert.equal(
        (await eventsFor(spirit)).filter((r) => parseMeta(r.meta).reason === "upgrade_failed")
          .length,
        1,
      );
      assert.equal((await activityFor(mind)).length, 1);
    } finally {
      await cleanupMind(mind);
    }
  });

  it("labels the spirit's infrastructure notice by its reason", () => {
    assert.equal(
      eventLabel("notice", { subtype: "infrastructure", reason: "upgrade_failed" }),
      "Infrastructure: upgrade_failed",
    );
  });
});
