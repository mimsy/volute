import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { promisify } from "node:util";
import {
  readVoluteConfig,
  resolveWakeTriggers,
  updateVoluteConfig,
  WAKE_TRIGGER_DEFAULTS,
  writeVoluteConfig,
} from "../packages/daemon/src/lib/mind/volute-config.js";

const execFileAsync = promisify(execFile);

let testDir: string;

function setup(config: Record<string, unknown>) {
  testDir = resolve(
    tmpdir(),
    `volute-config-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  const configDir = resolve(testDir, "home/.config");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(resolve(configDir, "volute.json"), JSON.stringify(config));
  return testDir;
}

describe("readVoluteConfig", () => {
  afterEach(() => {
    if (testDir && existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  it("reads config with profile object", () => {
    const dir = setup({
      model: "claude-sonnet-4-20250514",
      profile: { displayName: "Test", description: "A test mind", avatar: "avatar.png" },
    });
    const config = readVoluteConfig(dir);
    assert.ok(config);
    assert.equal(config.profile?.displayName, "Test");
    assert.equal(config.profile?.description, "A test mind");
    assert.equal(config.profile?.avatar, "avatar.png");
  });

  it("returns null for missing config", () => {
    const dir = resolve(tmpdir(), `volute-config-missing-${Date.now()}`);
    const config = readVoluteConfig(dir);
    assert.equal(config, null);
  });
});

describe("resolveWakeTriggers", () => {
  it("defaults mentions and DMs to on when unset", () => {
    assert.deepEqual(WAKE_TRIGGER_DEFAULTS, { mentions: true, dms: true });
    assert.deepEqual(resolveWakeTriggers(undefined), { mentions: true, dms: true });
    assert.deepEqual(resolveWakeTriggers({}), { mentions: true, dms: true });
  });

  it("respects explicit false values", () => {
    assert.deepEqual(resolveWakeTriggers({ mentions: false }), { mentions: false, dms: true });
    assert.deepEqual(resolveWakeTriggers({ dms: false }), { mentions: true, dms: false });
    assert.deepEqual(resolveWakeTriggers({ mentions: false, dms: false }), {
      mentions: false,
      dms: false,
    });
  });
});

// The daemon writes volute.json with its own privileges (root under user isolation), in a
// tree the mind owns (#1072, #1167): through writeMindFile, so nothing planted redirects it.
describe("writeVoluteConfig / updateVoluteConfig", () => {
  let dir: string;
  afterEach(() => {
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true });
  });
  function freshDir(): string {
    dir = resolve(
      tmpdir(),
      `volute-config-own-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(dir);
    return dir;
  }

  it("creates home/.config and the file, and rewrites it", async () => {
    const d = freshDir();
    await writeVoluteConfig(d, { echoText: true }, null);
    await writeVoluteConfig(d, { echoText: false }, null);
    assert.equal(readVoluteConfig(d)?.echoText, false);
    assert.deepEqual(
      readdirSync(resolve(d, "home/.config")).filter((f) => f.endsWith(".tmp")),
      [],
      "no temp file left behind",
    );
  });

  // readVoluteConfig is synchronous (sleep config, spend caps, mind start). A write that
  // truncated in place and then awaited would let it read "" in between — a mind with
  // no sleep config or no spend cap until the next reload.
  it("a synchronous reader never sees a half-written file during updates", async () => {
    const d = freshDir();
    const pool = Array.from({ length: 200 }, (_, i) => `message ${i} `.repeat(20));
    await writeVoluteConfig(d, { schedules: [{ id: "s", enabled: true, messages: pool }] }, null);
    let done = false;
    let emptyReads = 0;
    let reads = 0;
    const reader = (async () => {
      while (!done) {
        reads++;
        if (readVoluteConfig(d) === null) emptyReads++;
        await new Promise((r) => setImmediate(r));
      }
    })();
    for (let i = 0; i < 40; i++) {
      await updateVoluteConfig(d, null, (c) => ({ ...c, echoText: i % 2 === 0 }));
    }
    done = true;
    await reader;
    assert.ok(reads > 40, `reader ran (${reads})`);
    assert.equal(emptyReads, 0);
  });

  it("replaces a symlink planted at volute.json instead of writing through it", async () => {
    const d = freshDir();
    mkdirSync(resolve(d, "home/.config"), { recursive: true });
    const outside = resolve(d, "outside");
    writeFileSync(outside, "untouched");
    symlinkSync(outside, resolve(d, "home/.config/volute.json"));
    await writeVoluteConfig(d, { echoText: true }, null);
    assert.equal(readFileSync(outside, "utf-8"), "untouched");
    assert.ok(lstatSync(resolve(d, "home/.config/volute.json")).isFile());
    // A read-modify-write reads first, and refuses the link rather than replacing it.
    rmSync(resolve(d, "home/.config/volute.json"));
    symlinkSync(outside, resolve(d, "home/.config/volute.json"));
    await assert.rejects(updateVoluteConfig(d, null, (c) => c));
    assert.equal(readFileSync(outside, "utf-8"), "untouched");
  });

  it("refuses a .config/ that a symlink leads out of the mind, creating nothing there", async () => {
    const d = freshDir();
    const elsewhere = mkdtempSync(resolve(tmpdir(), "volute-config-elsewhere-"));
    try {
      mkdirSync(resolve(d, "home"), { recursive: true });
      symlinkSync(elsewhere, resolve(d, "home/.config"));
      await assert.rejects(writeVoluteConfig(d, {}, null));
      assert.deepEqual(readdirSync(elsewhere), []);
    } finally {
      rmSync(elsewhere, { recursive: true });
    }
  });

  it("refuses a home/ that a symlink leads out of the mind, before creating .config/ there", async () => {
    const d = freshDir();
    const elsewhere = mkdtempSync(resolve(tmpdir(), "volute-config-elsewhere-"));
    try {
      symlinkSync(elsewhere, resolve(d, "home"));
      await assert.rejects(writeVoluteConfig(d, {}, null));
      assert.deepEqual(readdirSync(elsewhere), []);
    } finally {
      rmSync(elsewhere, { recursive: true });
    }
  });

  it("update refuses an unparseable file rather than overwriting the mind's config", async () => {
    const d = freshDir();
    mkdirSync(resolve(d, "home/.config"), { recursive: true });
    writeFileSync(resolve(d, "home/.config/volute.json"), "{ not json");
    await assert.rejects(
      updateVoluteConfig(d, null, (c) => ({ ...c, echoText: true })),
      /unparseable/,
    );
    assert.equal(readFileSync(resolve(d, "home/.config/volute.json"), "utf-8"), "{ not json");
  });

  it("update starts from {} when there is no file, and writes nothing on null", async () => {
    const d = freshDir();
    assert.equal(await updateVoluteConfig(d, null, () => null), false);
    assert.equal(existsSync(resolve(d, "home/.config/volute.json")), false);
    assert.equal(await updateVoluteConfig(d, null, (c) => ({ ...c, echoText: true })), true);
    assert.equal(readVoluteConfig(d)?.echoText, true);
  });

  it("concurrent updates don't drop each other's change", async () => {
    const d = freshDir();
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        updateVoluteConfig(d, null, (c) => ({
          ...c,
          schedules: [...(c.schedules ?? []), { id: `s${i}`, enabled: true }],
        })),
      ),
    );
    assert.equal(readVoluteConfig(d)?.schedules?.length, 8);
  });

  it("readVoluteConfig refuses a FIFO instead of blocking the event loop", async () => {
    const d = freshDir();
    mkdirSync(resolve(d, "home/.config"), { recursive: true });
    await execFileAsync("mkfifo", [resolve(d, "home/.config/volute.json")]);
    assert.equal(readVoluteConfig(d), null);
  });
});
