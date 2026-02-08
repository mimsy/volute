import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  addAgent,
  nextPort,
  readRegistry,
  removeAgent,
  validateAgentName,
} from "../src/lib/registry.js";
import { addVariant, removeAllVariants } from "../src/lib/variants.js";

const testAgent = `registry-test-${Date.now()}`;

describe("registry", () => {
  afterEach(() => {
    removeAgent(testAgent);
    removeAllVariants(testAgent);
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
    addAgent(testAgent, 4100);
    addVariant(testAgent, {
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

  it("validateAgentName accepts valid names", () => {
    assert.equal(validateAgentName("my-agent"), null);
    assert.equal(validateAgentName("agent_1"), null);
    assert.equal(validateAgentName("Agent.v2"), null);
    assert.equal(validateAgentName("a"), null);
    assert.equal(validateAgentName("123"), null);
  });

  it("validateAgentName rejects invalid names", () => {
    assert.ok(validateAgentName("") !== null);
    assert.ok(validateAgentName("-starts-with-dash") !== null);
    assert.ok(validateAgentName(".starts-with-dot") !== null);
    assert.ok(validateAgentName("has spaces") !== null);
    assert.ok(validateAgentName("has/slash") !== null);
    assert.ok(validateAgentName("a".repeat(65)) !== null);
  });

  it("addAgent throws on invalid name", () => {
    assert.throws(() => addAgent("../evil", 4100), /Agent name must/);
  });
});
