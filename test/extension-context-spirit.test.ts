import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import type { ExtensionManifest } from "@volute/extensions";
import { and, eq } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";

import { MIND_LEVEL_THREAD } from "../packages/daemon/src/lib/chat/system-events.js";
import { getSpiritName } from "../packages/daemon/src/lib/config/setup.js";
import { getDb } from "../packages/daemon/src/lib/db.js";
import {
  _clearLoadedExtensionsForTest,
  _registerExtensionForTest,
  buildExtensionContext,
  notifyExtensionsSpiritReady,
} from "../packages/daemon/src/lib/extensions.js";
import {
  addMind,
  addSpirit,
  mindDir,
  removeMind,
} from "../packages/daemon/src/lib/mind/registry.js";
import { systemEvents } from "../packages/daemon/src/lib/schema.js";
import { initDb } from "../packages/extensions/intentions/src/db.js";
import { provisionSpiritSchedule } from "../packages/extensions/intentions/src/spirit-schedule.js";

/**
 * The extension SDK's context helpers used to assume every mind looks like a
 * mind: a `user_type: "mind"` row, living at `$VOLUTE_MINDS_DIR/<name>`. The
 * system spirit is neither — it shares the system user account (`user_type:
 * "system"`) and lives under the system dir. Both assumptions silently no-opped
 * the spirit bootstrap paths of the pages and intentions extensions, so these
 * tests exercise the real context rather than a fake.
 */
describe("extension context: spirit resolution", () => {
  const manifest = { id: "test-ctx", name: "Test", version: "0.0.0" } as ExtensionManifest;
  const noopMw = (async (_c: unknown, next: () => Promise<void>) =>
    next()) as unknown as MiddlewareHandler;

  let dataDir: string;
  let spiritProjectDir: string;
  let spiritName: string;

  before(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "ext-ctx-"));
    spiritProjectDir = resolve(dataDir, "spirit-project");
    mkdirSync(spiritProjectDir, { recursive: true });
    spiritName = getSpiritName();
    await addSpirit(spiritName, 4999, "claude", spiritProjectDir);
  });

  after(async () => {
    await removeMind(spiritName).catch(() => {});
    await removeMind("ordinary-ctx-mind").catch(() => {});
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("resolves the spirit's registry dir, which is not the minds-dir convention", async () => {
    const ctx = await buildExtensionContext(manifest, dataDir, noopMw);

    assert.equal(await ctx.getMindDir(spiritName), spiritProjectDir);
    // The bug this guards: the old implementation resolved mindDir(name) and
    // returned null when that path didn't exist, which is always true for the
    // spirit. If these two ever coincide the test has stopped proving anything.
    assert.notEqual(
      spiritProjectDir,
      mindDir(spiritName),
      "spirit dir must differ from the path convention for this test to bite",
    );
  });

  it("returns null for a mind with no directory on disk", async () => {
    const ctx = await buildExtensionContext(manifest, dataDir, noopMw);
    await addMind("ordinary-ctx-mind", 4998);
    assert.equal(await ctx.getMindDir("ordinary-ctx-mind"), null);
  });

  it("reports the spirit name even when the host never configured one", async () => {
    const ctx = await buildExtensionContext(manifest, dataDir, noopMw);
    // Mirrors the daemon's getSpiritName(), which defaults to "volute" on installs
    // predating spirit naming. Reading setup.spiritName directly returned null there.
    assert.equal(ctx.getSpiritName(), spiritName);
  });

  it("records a notice for the spirit despite its user_type being system", async () => {
    const ctx = await buildExtensionContext(manifest, dataDir, noopMw);
    await ctx.recordNotice(spiritName, "commons has no index yet");

    const db = await getDb();
    const rows = await db
      .select()
      .from(systemEvents)
      .where(and(eq(systemEvents.mind, spiritName), eq(systemEvents.thread, MIND_LEVEL_THREAD)));
    assert.equal(rows.length, 1);
    assert.match(rows[0].body ?? "", /commons has no index/);
  });

  it("drops a notice addressed to a name that is not a registered mind", async () => {
    const ctx = await buildExtensionContext(manifest, dataDir, noopMw);
    await ctx.recordNotice("not-a-mind-at-all", "should go nowhere");

    const db = await getDb();
    const rows = await db
      .select()
      .from(systemEvents)
      .where(eq(systemEvents.mind, "not-a-mind-at-all"));
    assert.equal(rows.length, 0);
  });

  // End-to-end for the bug that left the intentions review lifecycle with no
  // ignition: with the real context and a real spirit registration, the daily
  // review schedule must actually land in the spirit's config.
  it("provisions the intentions spirit schedule through the real context", async () => {
    mkdirSync(resolve(spiritProjectDir, "home/.config"), { recursive: true });
    const configPath = resolve(spiritProjectDir, "home/.config/volute.json");
    writeFileSync(configPath, JSON.stringify({ schedules: [] }));

    const intentionsDataDir = resolve(dataDir, "intentions-data");
    mkdirSync(intentionsDataDir, { recursive: true });
    const ctx = await buildExtensionContext(
      { id: "intentions-test", name: "I", version: "0.0.0", initDb } as ExtensionManifest,
      intentionsDataDir,
      noopMw,
    );
    try {
      await provisionSpiritSchedule(ctx);
    } finally {
      ctx.db?.close();
    }

    const config = JSON.parse(readFileSync(configPath, "utf-8")) as {
      schedules?: { id: string }[];
    };
    assert.ok(
      config.schedules?.some((s) => s.id === "intention-review"),
      "spirit must get its daily intention-review schedule",
    );
  });
});

describe("notifyExtensionsSpiritReady", () => {
  after(() => _clearLoadedExtensionsForTest());

  it("fires every extension's hook and contains one that throws", async () => {
    _clearLoadedExtensionsForTest();
    const fired: string[] = [];
    _registerExtensionForTest({
      id: "boom",
      name: "Boom",
      version: "0",
      onSpiritReady: async () => {
        fired.push("boom");
        throw new Error("bootstrap exploded");
      },
    } as unknown as ExtensionManifest);
    _registerExtensionForTest({
      id: "after",
      name: "After",
      version: "0",
      onSpiritReady: async () => {
        fired.push("after");
      },
    } as unknown as ExtensionManifest);

    // A failing extension must not swallow the ones registered behind it, and must
    // not reject into the daemon startup path that calls this.
    await assert.doesNotReject(() => notifyExtensionsSpiritReady());
    assert.deepEqual(fired, ["boom", "after"]);
  });
});
