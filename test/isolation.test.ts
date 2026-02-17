import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { agentUserName, isIsolationEnabled, wrapForIsolation } from "../src/lib/isolation.js";

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

  it("agentUserName prefixes with agent-", () => {
    assert.equal(agentUserName("alice"), "agent-alice");
    assert.equal(agentUserName("my-agent_1"), "agent-my-agent_1");
  });

  it("wrapForIsolation returns original cmd when isolation disabled", () => {
    delete process.env.VOLUTE_ISOLATION;
    const [cmd, args] = wrapForIsolation("/usr/bin/tsx", ["src/server.ts"], "alice");
    assert.equal(cmd, "/usr/bin/tsx");
    assert.deepEqual(args, ["src/server.ts"]);
  });

  it("wrapForIsolation wraps with runuser when isolation enabled", () => {
    process.env.VOLUTE_ISOLATION = "user";
    const [cmd, args] = wrapForIsolation(
      "/usr/bin/tsx",
      ["src/server.ts", "--port", "4100"],
      "alice",
    );
    assert.equal(cmd, "runuser");
    assert.deepEqual(args, [
      "-u",
      "agent-alice",
      "--",
      "/usr/bin/tsx",
      "src/server.ts",
      "--port",
      "4100",
    ]);
  });

  it("wrapForIsolation extracts base name from name@variant", () => {
    process.env.VOLUTE_ISOLATION = "user";
    const [cmd, args] = wrapForIsolation("node", ["index.js"], "alice@experiment");
    assert.equal(cmd, "runuser");
    assert.deepEqual(args, ["-u", "agent-alice", "--", "node", "index.js"]);
  });

  it("wrapForIsolation respects VOLUTE_USER_PREFIX", () => {
    process.env.VOLUTE_ISOLATION = "user";
    process.env.VOLUTE_USER_PREFIX = "volute-";
    const [cmd, args] = wrapForIsolation("node", ["index.js"], "bob");
    assert.equal(cmd, "runuser");
    assert.deepEqual(args, ["-u", "volute-bob", "--", "node", "index.js"]);
  });
});
