import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  addAgent,
  agentDir,
  daemonLoopback,
  nextPort,
  readRegistry,
  removeAgent,
  stateDir,
  validateAgentName,
  voluteHome,
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

  it("stateDir returns path under VOLUTE_HOME/state", () => {
    const dir = stateDir("my-agent");
    assert.ok(dir.startsWith(voluteHome()));
    assert.ok(dir.endsWith("/state/my-agent"));
  });

  it("stateDir handles name@variant format", () => {
    const dir = stateDir("my-agent@v1");
    assert.ok(dir.endsWith("/state/my-agent@v1"));
  });
});

describe("agentDir", () => {
  const originalAgentsDir = process.env.VOLUTE_AGENTS_DIR;
  afterEach(() => {
    if (originalAgentsDir === undefined) delete process.env.VOLUTE_AGENTS_DIR;
    else process.env.VOLUTE_AGENTS_DIR = originalAgentsDir;
  });

  it("returns VOLUTE_AGENTS_DIR/<name> when env var is set", () => {
    process.env.VOLUTE_AGENTS_DIR = "/agents";
    assert.equal(agentDir("foo"), "/agents/foo");
  });

  it("falls back to VOLUTE_HOME/agents/<name> when env var is unset", () => {
    delete process.env.VOLUTE_AGENTS_DIR;
    const dir = agentDir("foo");
    assert.ok(dir.startsWith(voluteHome()));
    assert.ok(dir.endsWith("/agents/foo"));
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
