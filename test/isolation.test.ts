import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
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
});
