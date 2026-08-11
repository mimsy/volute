import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { deliverEvent } from "../packages/daemon/src/lib/chat/system-events.js";
import { getDb } from "../packages/daemon/src/lib/db.js";
import { clearConfigCache } from "../packages/daemon/src/lib/delivery/delivery-router.js";
import {
  migrateScheduleThreadsToRoutes,
  readRoutesConfig,
} from "../packages/daemon/src/lib/mind/event-routes.js";
import { addMind, removeMind } from "../packages/daemon/src/lib/mind/registry.js";
import {
  readVoluteConfig,
  writeVoluteConfig,
} from "../packages/daemon/src/lib/mind/volute-config.js";
import { systemEvents } from "../packages/daemon/src/lib/schema.js";

function mindDirFor(name: string): string {
  return resolve(process.env.VOLUTE_HOME!, "minds", name);
}

/** Prepare a mind dir with a volute.json holding the given schedules. */
function seedVoluteConfig(name: string, schedules: object[]): string {
  const dir = mindDirFor(name);
  mkdirSync(resolve(dir, "home/.config"), { recursive: true });
  writeVoluteConfig(dir, { schedules } as never);
  return dir;
}

describe("migrateScheduleThreadsToRoutes", () => {
  it("moves a schedule.thread into an equivalent routes.json rule and strips the field", () => {
    const name = `mig-${process.pid}-a`;
    const dir = seedVoluteConfig(name, [
      { id: "dream", cron: "0 3 * * *", message: "dream", enabled: true, thread: "$new" },
      { id: "chore", cron: "0 9 * * *", message: "tidy", enabled: true, thread: "chores" },
      { id: "beat", cron: "0 12 * * *", message: "hi", enabled: true },
    ]);

    const changed = migrateScheduleThreadsToRoutes(dir, name);
    assert.equal(changed, true);

    const rules = readRoutesConfig(dir).rules ?? [];
    const byEvent = (ev: string) => rules.find((r) => r.event === ev);
    assert.deepEqual(byEvent("schedule:dream"), { event: "schedule:dream", thread: "$new" });
    assert.deepEqual(byEvent("schedule:chore"), { event: "schedule:chore", thread: "chores" });
    // A threadless schedule gets no rule.
    assert.equal(byEvent("schedule:beat"), undefined);

    // The legacy field is stripped from volute.json.
    const sched = readVoluteConfig(dir)?.schedules ?? [];
    assert.equal(
      sched.every((s) => s.thread === undefined),
      true,
    );

    clearConfigCache(name);
  });

  it("is idempotent — a second run finds nothing to move and no-ops", () => {
    const name = `mig-${process.pid}-b`;
    const dir = seedVoluteConfig(name, [
      { id: "chore", cron: "0 9 * * *", message: "tidy", enabled: true, thread: "chores" },
    ]);
    assert.equal(migrateScheduleThreadsToRoutes(dir, name), true);
    assert.equal(migrateScheduleThreadsToRoutes(dir, name), false);
    // The rule is present exactly once.
    const rules = readRoutesConfig(dir).rules ?? [];
    assert.equal(rules.filter((r) => r.event === "schedule:chore").length, 1);
    clearConfigCache(name);
  });

  it("preserves delivery to the same thread: an un-migrated schedule fires there post-migration", async () => {
    // A stub mind so an immediate schedule fire records the session it lands on.
    const posted: { session?: string }[] = [];
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
    const name = `mig-${process.pid}-c`;
    await addMind(name, port);
    const dir = seedVoluteConfig(name, [
      { id: "reports", cron: "0 9 * * *", message: "report", enabled: true, thread: "work" },
    ]);

    try {
      migrateScheduleThreadsToRoutes(dir, name);
      clearConfigCache(name);
      // Fire the schedule the way the scheduler does (no explicit thread — routing owns it).
      await deliverEvent(name, {
        type: "schedule",
        body: "report",
        meta: { scheduleId: "reports" },
      });
      assert.equal(posted[0]?.session, "work");
    } finally {
      server.close();
      const db = await getDb();
      await db.delete(systemEvents).where(eq(systemEvents.mind, name));
      clearConfigCache(name);
      await removeMind(name);
    }
  });
});
