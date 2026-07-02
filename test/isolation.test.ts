import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  chownTargets,
  isIsolationEnabled,
  mindUserName,
  wrapForIsolation,
} from "../packages/daemon/src/lib/mind/isolation.js";
import { addMind, addVariant, removeMind } from "../packages/daemon/src/lib/mind/registry.js";

describe("isolation", () => {
  const originalEnv = process.env.VOLUTE_ISOLATION;
  const originalPrefix = process.env.VOLUTE_USER_PREFIX;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.VOLUTE_ISOLATION;
    } else {
      process.env.VOLUTE_ISOLATION = originalEnv;
    }
    if (originalPrefix === undefined) {
      delete process.env.VOLUTE_USER_PREFIX;
    } else {
      process.env.VOLUTE_USER_PREFIX = originalPrefix;
    }
  });

  it("isIsolationEnabled returns false by default", () => {
    delete process.env.VOLUTE_ISOLATION;
    assert.equal(isIsolationEnabled(), false);
  });

  it("isIsolationEnabled returns false for other values", () => {
    process.env.VOLUTE_ISOLATION = "none";
    assert.equal(isIsolationEnabled(), false);
  });

  it("isIsolationEnabled returns true when set to user", () => {
    process.env.VOLUTE_ISOLATION = "user";
    assert.equal(isIsolationEnabled(), true);
  });

  it("mindUserName prefixes with mind-", () => {
    assert.equal(mindUserName("alice"), "mind-alice");
    assert.equal(mindUserName("my-mind_1"), "mind-my-mind_1");
  });

  it("wrapForIsolation returns original cmd when isolation disabled", async () => {
    delete process.env.VOLUTE_ISOLATION;
    const [cmd, args] = await wrapForIsolation("/usr/bin/tsx", ["src/server.ts"], "alice");
    assert.equal(cmd, "/usr/bin/tsx");
    assert.deepEqual(args, ["src/server.ts"]);
  });

  it("wrapForIsolation wraps with runuser/sudo when isolation enabled", async () => {
    process.env.VOLUTE_ISOLATION = "user";
    const [cmd, args] = await wrapForIsolation(
      "/usr/bin/tsx",
      ["src/server.ts", "--port", "4100"],
      "alice",
    );
    const expectedCmd = process.platform === "darwin" ? "sudo" : "runuser";
    assert.equal(cmd, expectedCmd);
    assert.deepEqual(args, [
      "-u",
      "mind-alice",
      "--",
      "/usr/bin/tsx",
      "src/server.ts",
      "--port",
      "4100",
    ]);
  });

  it("wrapForIsolation uses base name for splits", async () => {
    process.env.VOLUTE_ISOLATION = "user";
    await addMind("alice", 4150);
    await addVariant("alice-experiment", "alice", 4151, "/fake", "experiment");
    const [cmd, args] = await wrapForIsolation("node", ["index.js"], "alice-experiment");
    const expectedCmd = process.platform === "darwin" ? "sudo" : "runuser";
    assert.equal(cmd, expectedCmd);
    assert.deepEqual(args, ["-u", "mind-alice", "--", "node", "index.js"]);
    await removeMind("alice");
  });

  it("wrapForIsolation respects VOLUTE_USER_PREFIX", async () => {
    process.env.VOLUTE_ISOLATION = "user";
    process.env.VOLUTE_USER_PREFIX = "volute-";
    const [cmd, args] = await wrapForIsolation("node", ["index.js"], "bob");
    const expectedCmd = process.platform === "darwin" ? "sudo" : "runuser";
    assert.equal(cmd, expectedCmd);
    assert.deepEqual(args, ["-u", "volute-bob", "--", "node", "index.js"]);
  });

  it("chownTargets skips only node_modules when it is already owned", async () => {
    const dir = mkdtempSync(resolve(tmpdir(), "chown-narrow-"));
    mkdirSync(resolve(dir, "node_modules"));
    mkdirSync(resolve(dir, "home"));
    mkdirSync(resolve(dir, ".mind"));
    mkdirSync(resolve(dir, ".git"));
    mkdirSync(resolve(dir, "src"));
    // node_modules was just created by this process, so it's owned by us.
    const targets = await chownTargets(dir, userInfo().username);
    // Every top-level entry is recursed except the (already-owned) node_modules,
    // so root-created files (e.g. merge/upgrade git objects under .git) still get
    // re-chowned.
    assert.ok(!targets.includes(resolve(dir, "node_modules")), "node_modules should be skipped");
    assert.ok(targets.includes(resolve(dir, ".git")), ".git must be re-chowned");
    assert.deepEqual(
      [...targets].sort(),
      [
        resolve(dir, ".git"),
        resolve(dir, ".mind"),
        resolve(dir, "home"),
        resolve(dir, "src"),
      ].sort(),
    );
  });

  it("chownTargets recurses the whole dir when node_modules owner differs", async () => {
    const dir = mkdtempSync(resolve(tmpdir(), "chown-owner-"));
    mkdirSync(resolve(dir, "node_modules"));
    mkdirSync(resolve(dir, "home"));
    const targets = await chownTargets(dir, "no-such-user-xyz-123");
    assert.deepEqual(targets, [dir]);
  });

  it("chownTargets recurses the whole dir when there is no node_modules", async () => {
    const dir = mkdtempSync(resolve(tmpdir(), "chown-plain-"));
    mkdirSync(resolve(dir, "home"));
    const targets = await chownTargets(dir, userInfo().username);
    assert.deepEqual(targets, [dir]);
  });
});
