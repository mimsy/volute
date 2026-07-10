import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { createUser } from "../packages/daemon/src/lib/auth.js";
import {
  getScheduler,
  initScheduler,
  type Scheduler,
} from "../packages/daemon/src/lib/daemon/scheduler.js";
import { getDb } from "../packages/daemon/src/lib/db.js";
import {
  addMind,
  addSpirit,
  removeMind,
  voluteHome,
} from "../packages/daemon/src/lib/mind/registry.js";
import { firstWeekSchedules } from "../packages/daemon/src/lib/mind/spirit.js";
import type { Schedule } from "../packages/daemon/src/lib/mind/volute-config.js";
import { users } from "../packages/daemon/src/lib/schema.js";
import { createSession } from "../packages/daemon/src/web/middleware/auth.js";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("firstWeekSchedules", () => {
  it("builds four one-time schedules 24h apart", () => {
    const sproutedAt = new Date("2026-07-10T12:00:00.000Z");
    const schedules = firstWeekSchedules("fern", sproutedAt);

    assert.equal(schedules.length, 4);
    schedules.forEach((s, i) => {
      assert.equal(s.id, `firstweek-fern-day${i + 1}`);
      assert.equal(s.fireAt, new Date(sproutedAt.getTime() + (i + 1) * DAY_MS).toISOString());
      assert.equal(s.cron, undefined);
      assert.equal(s.enabled, true);
      assert.ok(s.message?.includes("fern"), `day ${i + 1} message should mention the mind`);
    });
  });
});

describe("sprout swaps nurture for the first-week arc", () => {
  let cookie: string;
  const seedName = `arc-seed-${Date.now()}`;
  const spiritTestDir = resolve(voluteHome(), "system", "spirit");
  const spiritConfigPath = resolve(spiritTestDir, "home/.config/volute.json");

  // Initialize the scheduler singleton (without starting its interval) so the
  // endpoint's post-write loadSchedules() runs for real instead of throwing
  // into the fail-soft catch.
  let scheduler: Scheduler;
  try {
    scheduler = initScheduler();
  } catch {
    scheduler = getScheduler();
  }

  function loadedSpiritSchedules(): Schedule[] {
    return (
      (scheduler as unknown as { schedules: Map<string, Schedule[]> }).schedules.get("volute") ?? []
    );
  }

  function writeSpiritConfig(config: Record<string, unknown>) {
    mkdirSync(resolve(spiritTestDir, "home/.config"), { recursive: true });
    writeFileSync(spiritConfigPath, `${JSON.stringify(config, null, 2)}\n`);
  }

  function readSpiritSchedules(): Schedule[] {
    const config = JSON.parse(readFileSync(spiritConfigPath, "utf-8"));
    return config.schedules ?? [];
  }

  async function sprout() {
    const { default: app } = await import("../packages/daemon/src/web/app.js");
    return app.request(`http://localhost/api/minds/${seedName}/sprout`, {
      method: "POST",
      headers: { Cookie: `volute_session=${cookie}`, Origin: "http://localhost" },
    });
  }

  async function cleanup() {
    const db = await getDb();
    await db.delete(users).where(eq(users.username, "arc-admin"));
    await removeMind(seedName);
    await removeMind("volute");
  }

  beforeEach(async () => {
    await cleanup();
    const user = await createUser("arc-admin", "pass");
    cookie = await createSession(user.id);
    await addMind(seedName, 4300, "seed");
    await addSpirit("volute", 4301, "claude", spiritTestDir);
  });

  afterEach(cleanup);

  it("removes nurture-<name>, keeps other schedules, adds four fireAt schedules", async () => {
    writeSpiritConfig({
      profile: { displayName: "Spirit" },
      identity: { privateKey: "priv", publicKey: "pub" },
      schedules: [
        { id: "tending", cron: "0 10 * * *", message: "tend", enabled: true },
        {
          id: `nurture-${seedName}`,
          cron: "*/5 * * * *",
          script: `volute seed check ${seedName}`,
          enabled: true,
        },
      ],
    });

    const before = Date.now();
    const res = await sprout();
    assert.equal(res.status, 200);

    const schedules = readSpiritSchedules();
    assert.ok(!schedules.some((s) => s.id === `nurture-${seedName}`), "nurture removed");
    assert.ok(
      schedules.some((s) => s.id === "tending"),
      "unrelated schedule kept",
    );

    const arc = schedules.filter((s) => s.id.startsWith(`firstweek-${seedName}-`));
    assert.equal(arc.length, 4);
    for (const [i, s] of arc.entries()) {
      assert.equal(s.id, `firstweek-${seedName}-day${i + 1}`);
      assert.ok(s.fireAt, "arc schedules are one-time");
      const fireAt = new Date(s.fireAt!).getTime();
      const expected = before + (i + 1) * DAY_MS;
      assert.ok(
        Math.abs(fireAt - expected) < 60_000,
        `day ${i + 1} fires ~${i + 1} days after sprout`,
      );
      assert.ok(s.message?.trim(), "arc schedule carries a message for the spirit");
      assert.equal(s.enabled, true);
    }

    // Non-schedule config keys survive the rewrite — a regression here would
    // destroy the spirit's profile or identity keypair.
    const config = JSON.parse(readFileSync(spiritConfigPath, "utf-8"));
    assert.deepEqual(config.profile, { displayName: "Spirit" });
    assert.deepEqual(config.identity, { privateKey: "priv", publicKey: "pub" });

    // The scheduler singleton picked up the new schedules in memory.
    const loaded = loadedSpiritSchedules();
    assert.equal(loaded.filter((s) => s.id.startsWith(`firstweek-${seedName}-`)).length, 4);
    assert.ok(!loaded.some((s) => s.id === `nurture-${seedName}`));
  });

  it("adds the arc even when the spirit config has no schedules", async () => {
    writeSpiritConfig({});

    const res = await sprout();
    assert.equal(res.status, 200);

    const arc = readSpiritSchedules().filter((s) => s.id.startsWith(`firstweek-${seedName}-`));
    assert.equal(arc.length, 4);
  });

  it("leaves an unparseable spirit config untouched and still sprouts", async () => {
    mkdirSync(resolve(spiritTestDir, "home/.config"), { recursive: true });
    writeFileSync(spiritConfigPath, "{ not json");

    const res = await sprout();
    assert.equal(res.status, 200);
    assert.equal(readFileSync(spiritConfigPath, "utf-8"), "{ not json");
  });
});
