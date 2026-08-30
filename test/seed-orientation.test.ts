import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { eq } from "drizzle-orm";
import {
  buildSeedOrientation,
  sendSeedOrientation,
} from "../packages/daemon/src/lib/daemon/mind-service.js";
import { getDb } from "../packages/daemon/src/lib/db.js";
import { systemEvents } from "../packages/daemon/src/lib/schema.js";

describe("buildSeedOrientation", () => {
  it("omits the creator claim when there is no creator", () => {
    const msg = buildSeedOrientation();
    assert.ok(msg.includes("You've just been created as a seed"));
    assert.ok(!msg.includes("Your creator"), "no creator line without a creator");
    // Never assumes a human planted the seed
    assert.ok(!msg.toLowerCase().includes("human"));
  });

  it("names a human creator plainly", () => {
    const msg = buildSeedOrientation("alice", "human");
    assert.ok(msg.includes("Your creator is alice."));
    assert.ok(!msg.toLowerCase().includes("human"));
  });

  it("words a mind creator as another mind", () => {
    const msg = buildSeedOrientation("orchid", "mind");
    assert.ok(msg.includes("Your creator is another mind, orchid."));
  });

  it("words the spirit creator as the spirit of this system", () => {
    const msg = buildSeedOrientation("volute", "spirit");
    assert.ok(msg.includes("Your creator is the spirit of this system (volute)."));
  });

  it("falls back to the bare name when the creator type is unknown", () => {
    const msg = buildSeedOrientation("someone");
    assert.ok(msg.includes("Your creator is someone."));
  });
});

describe("sendSeedOrientation", () => {
  it("orients a seed once, not on every server start (#697)", async () => {
    const mind = `seedorient-${process.pid}`;
    const db = await getDb();
    const rowsFor = async () =>
      db.select().from(systemEvents).where(eq(systemEvents.mind, mind)).all();
    try {
      await sendSeedOrientation(mind, null);
      const first = await rowsFor();
      assert.equal(first.length, 1);
      assert.equal(first[0].type, "orientation");
      assert.ok(first[0].body.includes("You've just been created as a seed"));

      // The seed reads it — which is precisely when a second birth message is worst.
      await db
        .update(systemEvents)
        .set({ delivered_at: "2026-07-14 02:06:48" })
        .where(eq(systemEvents.mind, mind));

      // A restart. It has already been born; it is not born again.
      await sendSeedOrientation(mind, null);
      const after = await rowsFor();
      assert.equal(after.length, 1, "no second orientation after a restart");
      assert.equal(after[0].id, first[0].id);
    } finally {
      await db.delete(systemEvents).where(eq(systemEvents.mind, mind));
    }
  });
});
