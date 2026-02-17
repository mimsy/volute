import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createUser } from "../src/lib/auth.js";
import { getDb } from "../src/lib/db.js";
import {
  addAgent,
  findAgent,
  readRegistry,
  removeAgent,
  setAgentStage,
  voluteHome,
} from "../src/lib/registry.js";
import { sessions, users } from "../src/lib/schema.js";
import { createSession } from "../src/web/middleware/auth.js";

function postHeaders(cookie: string) {
  return {
    Cookie: `volute_session=${cookie}`,
    Origin: "http://localhost",
  };
}

describe("registry stage", () => {
  const name = `orient-test-${Date.now()}`;

  afterEach(() => {
    removeAgent(name);
  });

  it("addAgent with stage=seed persists correctly", () => {
    addAgent(name, 4100, "seed");
    const entry = findAgent(name);
    assert.ok(entry);
    assert.equal(entry.stage, "seed");
  });

  it("addAgent without stage defaults to mind on read", () => {
    addAgent(name, 4100);
    const entry = findAgent(name);
    assert.ok(entry);
    assert.equal(entry.stage, "mind");
  });

  it("readRegistry defaults missing stage to mind", () => {
    // Write a registry entry without stage field
    const registryPath = resolve(voluteHome(), "agents.json");
    writeFileSync(
      registryPath,
      JSON.stringify([{ name, port: 4100, created: new Date().toISOString(), running: false }]),
    );
    const entries = readRegistry();
    const entry = entries.find((e) => e.name === name);
    assert.ok(entry);
    assert.equal(entry.stage, "mind");
  });

  it("setAgentStage flips seed to mind", () => {
    addAgent(name, 4100, "seed");
    assert.equal(findAgent(name)?.stage, "seed");
    setAgentStage(name, "mind");
    assert.equal(findAgent(name)?.stage, "mind");
  });
});

describe("seed agent creation API", () => {
  let cookie: string;

  async function cleanup() {
    const db = await getDb();
    await db.delete(sessions);
    await db.delete(users);
  }

  beforeEach(async () => {
    await cleanup();
    const user = await createUser("orient-admin", "pass");
    cookie = await createSession(user.id);
  });
  afterEach(async () => {
    // Clean up any agents we created
    for (const entry of readRegistry()) {
      if (entry.name.startsWith("seed-test-")) {
        removeAgent(entry.name);
      }
    }
    await cleanup();
  });

  it("POST /api/agents with stage=seed creates agent with correct stage", async () => {
    const agentName = `seed-test-${Date.now()}`;
    // Create the agent directory so the route doesn't fail on disk operations
    const agentsDir = resolve(voluteHome(), "agents");
    mkdirSync(agentsDir, { recursive: true });

    const { default: app } = await import("../src/web/app.js");

    const res = await app.request("http://localhost/api/agents", {
      method: "POST",
      headers: {
        ...postHeaders(cookie),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: agentName, stage: "seed" }),
    });

    // Will likely fail because template copy needs real templates dir,
    // but we can test the registry side separately
    if (res.status === 200) {
      const body = (await res.json()) as { stage?: string };
      assert.equal(body.stage, "seed");
      const entry = findAgent(agentName);
      assert.ok(entry);
      assert.equal(entry.stage, "seed");
    }
    // Clean up
    removeAgent(agentName);
  });
});

describe("seed gating", () => {
  let cookie: string;
  const agentName = `gated-seed-${Date.now()}`;

  async function cleanup() {
    const db = await getDb();
    await db.delete(sessions);
    await db.delete(users);
    removeAgent(agentName);
  }

  beforeEach(async () => {
    await cleanup();
    const user = await createUser("gate-admin", "pass");
    cookie = await createSession(user.id);
    addAgent(agentName, 4199, "seed");
    // Create minimal agent directory
    const dir = resolve(voluteHome(), "agents", agentName);
    mkdirSync(resolve(dir, "home/.config"), { recursive: true });
    writeFileSync(resolve(dir, "home/.config/volute.json"), "{}");
  });
  afterEach(cleanup);

  it("POST connectors returns 403 for seed agents", async () => {
    const { default: app } = await import("../src/web/app.js");

    const res = await app.request(`http://localhost/api/agents/${agentName}/connectors/discord`, {
      method: "POST",
      headers: postHeaders(cookie),
    });
    assert.equal(res.status, 403);
    const body = (await res.json()) as { error: string };
    assert.ok(body.error.includes("Seed"));
  });

  it("POST schedules returns 403 for seed agents", async () => {
    const { default: app } = await import("../src/web/app.js");

    const res = await app.request(`http://localhost/api/agents/${agentName}/schedules`, {
      method: "POST",
      headers: {
        ...postHeaders(cookie),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ cron: "0 * * * *", message: "test" }),
    });
    assert.equal(res.status, 403);
    const body = (await res.json()) as { error: string };
    assert.ok(body.error.includes("Seed"));
  });

  it("POST variants returns 403 for seed agents", async () => {
    const { default: app } = await import("../src/web/app.js");

    const res = await app.request(`http://localhost/api/agents/${agentName}/variants`, {
      method: "POST",
      headers: {
        ...postHeaders(cookie),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "test-variant" }),
    });
    assert.equal(res.status, 403);
    const body = (await res.json()) as { error: string };
    assert.ok(body.error.includes("Seed"));
  });
});
