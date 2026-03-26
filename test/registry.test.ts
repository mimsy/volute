import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  addMind,
  addVariant,
  daemonLoopback,
  findMind,
  findVariants,
  getBaseName,
  mindDir,
  nextPort,
  readAllMinds,
  readRegistry,
  removeMind,
  setMindRunning,
  stateDir,
  validateMindName,
  voluteHome,
  voluteSystemDir,
} from "../packages/daemon/src/lib/mind/registry.js";

const testMind = `registry-test-${Date.now()}`;

describe("registry", () => {
  afterEach(async () => {
    try {
      await removeMind(testMind);
    } catch {}
  });

  it("nextPort returns 4100 when registry is empty", async () => {
    const port = await nextPort();
    assert.ok(port >= 4100, `Expected port >= 4100, got ${port}`);
  });

  it("readRegistry returns array", async () => {
    const entries = await readRegistry();
    assert.ok(Array.isArray(entries));
  });

  it("nextPort skips variant ports", async () => {
    await addMind(testMind, 4100);
    await addVariant(`${testMind}-v1`, testMind, 4101, "/fake/v1", "v1");
    const port = await nextPort();
    assert.ok(port >= 4102, `Expected port >= 4102, got ${port}`);
  });

  it("validateMindName accepts valid names", () => {
    assert.equal(validateMindName("my-mind"), null);
    assert.equal(validateMindName("mind_1"), null);
    assert.equal(validateMindName("Mind.v2"), null);
    assert.equal(validateMindName("a"), null);
    assert.equal(validateMindName("123"), null);
  });

  it("validateMindName rejects invalid names", () => {
    assert.ok(validateMindName("") !== null);
    assert.ok(validateMindName("-starts-with-dash") !== null);
    assert.ok(validateMindName(".starts-with-dot") !== null);
    assert.ok(validateMindName("has spaces") !== null);
    assert.ok(validateMindName("has/slash") !== null);
    assert.ok(validateMindName("a".repeat(65)) !== null);
  });

  it("addMind throws on invalid name", async () => {
    await assert.rejects(() => addMind("../evil", 4100), /Mind name must/);
  });

  it("stateDir returns path under VOLUTE_HOME/system/state", () => {
    const dir = stateDir("my-mind");
    assert.ok(dir.startsWith(voluteSystemDir()));
    assert.ok(dir.endsWith("/state/my-mind"));
  });

  it("findMind returns null for non-existent mind", async () => {
    assert.equal(await findMind("nonexistent-mind"), undefined);
  });

  it("findMind returns entry for existing mind", async () => {
    await addMind(testMind, 4100);
    const entry = await findMind(testMind);
    assert.ok(entry);
    assert.equal(entry.name, testMind);
    assert.equal(entry.port, 4100);
  });

  it("setMindRunning updates running state", async () => {
    await addMind(testMind, 4100);
    await setMindRunning(testMind, true);
    assert.equal((await findMind(testMind))!.running, true);
    await setMindRunning(testMind, false);
    assert.equal((await findMind(testMind))!.running, false);
  });

  it("removeMind deletes entry", async () => {
    await addMind(testMind, 4100);
    assert.ok(await findMind(testMind));
    await removeMind(testMind);
    assert.equal(await findMind(testMind), undefined);
  });
});

describe("variants", () => {
  const splitName = `${testMind}-split`;

  afterEach(async () => {
    try {
      await removeMind(testMind);
    } catch {}
  });

  it("addVariant creates a variant with parent", async () => {
    await addMind(testMind, 4100);
    await addVariant(splitName, testMind, 4101, "/fake/split", "split-branch");
    const entry = await findMind(splitName);
    assert.ok(entry);
    assert.equal(entry.parent, testMind);
    assert.equal(entry.dir, "/fake/split");
    assert.equal(entry.branch, "split-branch");
  });

  it("findVariants returns variants for parent", async () => {
    await addMind(testMind, 4100);
    await addVariant(splitName, testMind, 4101, "/fake/split", "split-branch");
    const splits = await findVariants(testMind);
    assert.equal(splits.length, 1);
    assert.equal(splits[0].name, splitName);
  });

  it("getBaseName returns parent for variant", async () => {
    await addMind(testMind, 4100);
    await addVariant(splitName, testMind, 4101, "/fake/split", "split-branch");
    assert.equal(await getBaseName(splitName), testMind);
  });

  it("getBaseName returns name for base mind", async () => {
    await addMind(testMind, 4100);
    assert.equal(await getBaseName(testMind), testMind);
  });

  it("cascade delete removes variants when parent is deleted", async () => {
    await addMind(testMind, 4100);
    await addVariant(splitName, testMind, 4101, "/fake/split", "split-branch");
    await removeMind(testMind);
    assert.equal(await findMind(splitName), undefined);
  });

  it("readAllMinds includes both base minds and variants", async () => {
    await addMind(testMind, 4100);
    await addVariant(splitName, testMind, 4101, "/fake/split", "split-branch");
    const all = await readAllMinds();
    assert.ok(all.some((e) => e.name === testMind));
    assert.ok(all.some((e) => e.name === splitName));
  });

  it("readRegistry excludes variants", async () => {
    await addMind(testMind, 4100);
    await addVariant(splitName, testMind, 4101, "/fake/split", "split-branch");
    const base = await readRegistry();
    assert.ok(base.some((e) => e.name === testMind));
    assert.ok(!base.some((e) => e.name === splitName));
  });
});

describe("mindDir", () => {
  const originalMindsDir = process.env.VOLUTE_MINDS_DIR;
  afterEach(() => {
    if (originalMindsDir === undefined) delete process.env.VOLUTE_MINDS_DIR;
    else process.env.VOLUTE_MINDS_DIR = originalMindsDir;
  });

  it("returns VOLUTE_MINDS_DIR/<name> when env var is set", () => {
    process.env.VOLUTE_MINDS_DIR = "/minds";
    assert.equal(mindDir("foo"), "/minds/foo");
  });

  it("falls back to VOLUTE_HOME/minds/<name> when env var is unset", () => {
    delete process.env.VOLUTE_MINDS_DIR;
    const dir = mindDir("foo");
    assert.ok(dir.startsWith(voluteHome()));
    assert.ok(dir.endsWith("/minds/foo"));
  });
});

describe("daemonLoopback", () => {
  const original = process.env.VOLUTE_DAEMON_HOSTNAME;
  afterEach(() => {
    if (original === undefined) delete process.env.VOLUTE_DAEMON_HOSTNAME;
    else process.env.VOLUTE_DAEMON_HOSTNAME = original;
  });

  it("returns 127.0.0.1 when hostname is 0.0.0.0", () => {
    process.env.VOLUTE_DAEMON_HOSTNAME = "0.0.0.0";
    assert.equal(daemonLoopback(), "127.0.0.1");
  });

  it("returns [::1] when hostname is ::", () => {
    process.env.VOLUTE_DAEMON_HOSTNAME = "::";
    assert.equal(daemonLoopback(), "[::1]");
  });

  it("returns 127.0.0.1 when hostname is unset", () => {
    delete process.env.VOLUTE_DAEMON_HOSTNAME;
    assert.equal(daemonLoopback(), "127.0.0.1");
  });

  it("returns the hostname as-is for specific addresses", () => {
    process.env.VOLUTE_DAEMON_HOSTNAME = "192.168.1.10";
    assert.equal(daemonLoopback(), "192.168.1.10");
  });
});
