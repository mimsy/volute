import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { deliverEvent } from "../packages/daemon/src/lib/chat/system-events.js";
import { getDb } from "../packages/daemon/src/lib/db.js";
import { clearConfigCache } from "../packages/daemon/src/lib/delivery/delivery-router.js";
import {
  migrateScheduleThreadsToRoutes,
  readRoutesConfig,
  upsertEventRule,
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
async function seedVoluteConfig(name: string, schedules: object[]): Promise<string> {
  const dir = mindDirFor(name);
  mkdirSync(resolve(dir, "home/.config"), { recursive: true });
  await writeVoluteConfig(dir, { schedules } as never, null);
  return dir;
}

describe("migrateScheduleThreadsToRoutes", () => {
  it("moves a schedule.thread into an equivalent routes.json rule and strips the field", async () => {
    const name = `mig-${process.pid}-a`;
    const dir = await seedVoluteConfig(name, [
      { id: "dream", cron: "0 3 * * *", message: "dream", enabled: true, thread: "$new" },
      { id: "chore", cron: "0 9 * * *", message: "tidy", enabled: true, thread: "chores" },
      { id: "beat", cron: "0 12 * * *", message: "hi", enabled: true },
    ]);

    const changed = await migrateScheduleThreadsToRoutes(dir, name, null);
    assert.equal(changed, true);

    const rules = (await readRoutesConfig(dir, null)).rules ?? [];
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

  it("is idempotent — a second run finds nothing to move and no-ops", async () => {
    const name = `mig-${process.pid}-b`;
    const dir = await seedVoluteConfig(name, [
      { id: "chore", cron: "0 9 * * *", message: "tidy", enabled: true, thread: "chores" },
    ]);
    assert.equal(await migrateScheduleThreadsToRoutes(dir, name, null), true);
    assert.equal(await migrateScheduleThreadsToRoutes(dir, name, null), false);
    // The rule is present exactly once.
    const rules = (await readRoutesConfig(dir, null)).rules ?? [];
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
    const dir = await seedVoluteConfig(name, [
      { id: "reports", cron: "0 9 * * *", message: "report", enabled: true, thread: "work" },
    ]);

    try {
      await migrateScheduleThreadsToRoutes(dir, name, null);
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

// Under user isolation the daemon is root and the mind owns its tree (#1116, #1167): the
// routes.json the daemon creates must be the mind's, and a link it planted must refuse.
describe("upsertEventRule", () => {
  function scratch(): string {
    return mkdtempSync(resolve(tmpdir(), "upsert-event-rule-"));
  }

  it("hands a routes.json (and .config/) it creates to the owner", async (t) => {
    const dir = scratch();
    mkdirSync(resolve(dir, "home"));
    const uid = process.getuid?.();
    // Not the group a new file would get anyway (see mind-file-write.test.ts).
    const usual = [process.getgid?.(), statSync(resolve(dir, "home")).gid];
    const other = process.getgroups?.().find((g) => !usual.includes(g));
    if (uid === undefined || other === undefined) {
      t.skip("needs a second group to observe the chown");
      return;
    }
    await upsertEventRule(dir, "schedule:x", "$new", { owner: { uid, gid: other } });
    assert.equal(statSync(resolve(dir, "home/.config/routes.json")).gid, other);
    assert.equal(statSync(resolve(dir, "home/.config")).gid, other);
  });

  it("refuses a symlink planted at routes.json, leaving its target alone", async () => {
    const dir = scratch();
    mkdirSync(resolve(dir, "home/.config"), { recursive: true });
    const outside = resolve(dir, "outside");
    writeFileSync(outside, "untouched");
    symlinkSync(outside, resolve(dir, "home/.config/routes.json"));
    await assert.rejects(upsertEventRule(dir, "schedule:x", "$new", { owner: null }));
    assert.equal(readFileSync(outside, "utf-8"), "untouched");
    await assert.rejects(readRoutesConfig(dir, null));
  });

  it("removing a rule never creates routes.json", async () => {
    const dir = scratch();
    assert.equal(await upsertEventRule(dir, "schedule:x", null, { owner: null }), false);
    assert.equal(existsSync(resolve(dir, "home")), false);
  });
});
