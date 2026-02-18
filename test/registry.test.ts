import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  addMind,
  daemonLoopback,
  mindDir,
  nextPort,
  readRegistry,
  removeMind,
  stateDir,
  validateMindName,
  voluteHome,
} from "../src/lib/registry.js";
import { addVariant, removeAllVariants } from "../src/lib/variants.js";

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
