import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { resolveAgentName } from "../src/lib/resolve-agent-name.js";

describe("resolveAgentName", () => {
  const original = process.env.VOLUTE_AGENT;
  afterEach(() => {
    if (original === undefined) delete process.env.VOLUTE_AGENT;
    else process.env.VOLUTE_AGENT = original;
  });

  it("returns flags.agent when provided", () => {
    assert.equal(resolveAgentName({ agent: "my-agent" }), "my-agent");
  });

  it("falls back to VOLUTE_AGENT env var", () => {
    process.env.VOLUTE_AGENT = "env-agent";
    assert.equal(resolveAgentName({}), "env-agent");
  });

  it("prefers flags.agent over VOLUTE_AGENT", () => {
    process.env.VOLUTE_AGENT = "env-agent";
    assert.equal(resolveAgentName({ agent: "flag-agent" }), "flag-agent");
  });
});
