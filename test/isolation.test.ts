import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { agentUserName, isIsolationEnabled } from "../src/lib/isolation.js";

describe("isolation", () => {
  const originalEnv = process.env.VOLUTE_ISOLATION;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.VOLUTE_ISOLATION;
    } else {
      process.env.VOLUTE_ISOLATION = originalEnv;
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
});
