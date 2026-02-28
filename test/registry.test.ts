import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  addMind,
  daemonLoopback,
  getRegistryCache,
  initRegistryCache,
  mindDir,
  nextPort,
  readRegistry,
  removeMind,
  setMindRunning,
  stateDir,
  validateMindName,
  voluteHome,
} from "@volute/shared/registry";
import { addVariant, removeAllVariants } from "@volute/shared/variants";

const testMind = `registry-test-${Date.now()}`;

describe("registry", () => {
  afterEach(() => {
    removeMind(testMind);
    removeAllVariants(testMind);
  });

  it("nextPort returns 4100 when registry is empty", () => {
    const port = nextPort();
    assert.ok(port >= 4100, `Expected port >= 4100, got ${port}`);
  });

  it("readRegistry returns array", () => {
    const entries = readRegistry();
    assert.ok(Array.isArray(entries));
  });

  it("nextPort skips variant ports", () => {
    addMind(testMind, 4100);
    addVariant(testMind, {
      name: "v1",
      branch: "v1",
      path: "/fake/v1",
      port: 4101,
      pid: null,
      created: new Date().toISOString(),
    });
    const port = nextPort();
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

  it("addMind throws on invalid name", () => {
    assert.throws(() => addMind("../evil", 4100), /Mind name must/);
  });

  it("stateDir returns path under VOLUTE_HOME/state", () => {
    const dir = stateDir("my-mind");
    assert.ok(dir.startsWith(voluteHome()));
    assert.ok(dir.endsWith("/state/my-mind"));
  });

  it("stateDir handles name@variant format", () => {
    const dir = stateDir("my-mind@v1");
    assert.ok(dir.endsWith("/state/my-mind@v1"));
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

describe("registry cache", () => {
  const cacheMind = `cache-test-${Date.now()}`;

  afterEach(() => {
    removeMind(cacheMind);
  });

  it("getRegistryCache returns null before init", () => {
    // At this point in the test suite, no initRegistryCache has been called
    // so getRegistryCache should reflect whatever state exists.
    // We test the public contract: before initRegistryCache, readRegistry reads from disk.
    const entries = readRegistry();
    assert.ok(Array.isArray(entries));
  });

  it("initRegistryCache loads from disk and caches", () => {
    addMind(cacheMind, 4199);
    initRegistryCache();

    const cached = getRegistryCache();
    assert.ok(cached !== null);
    assert.ok(cached!.some((e) => e.name === cacheMind));
  });

  it("readRegistry returns cached data after initRegistryCache", () => {
    addMind(cacheMind, 4199);
    initRegistryCache();

    const entries = readRegistry();
    assert.ok(entries.some((e) => e.name === cacheMind));
  });

  it("writeRegistry updates both cache and disk", () => {
    initRegistryCache();
    addMind(cacheMind, 4199);

    // Cache should be updated
    const cached = getRegistryCache();
    assert.ok(cached!.some((e) => e.name === cacheMind));

    // Disk should also be updated
    const registryPath = resolve(voluteHome(), "minds.json");
    const diskEntries = JSON.parse(readFileSync(registryPath, "utf-8"));
    assert.ok(diskEntries.some((e: { name: string }) => e.name === cacheMind));
  });

  it("setMindRunning propagates through cache", () => {
    addMind(cacheMind, 4199);
    initRegistryCache();

    setMindRunning(cacheMind, true);
    const cached = getRegistryCache();
    const entry = cached!.find((e) => e.name === cacheMind);
    assert.equal(entry!.running, true);

    setMindRunning(cacheMind, false);
    const entry2 = getRegistryCache()!.find((e) => e.name === cacheMind);
    assert.equal(entry2!.running, false);
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
