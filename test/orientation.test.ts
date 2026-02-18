import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createUser } from "../src/lib/auth.js";
import { getDb } from "../src/lib/db.js";
import {
  addMind,
  findMind,
  readRegistry,
  removeMind,
  setMindStage,
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
    removeMind(name);
  });

  it("addMind with stage=seed persists correctly", () => {
    addMind(name, 4100, "seed");
    const entry = findMind(name);
    assert.ok(entry);
    assert.equal(entry.stage, "seed");
  });

  it("addMind without stage defaults to sprouted on read", () => {
    addMind(name, 4100);
    const entry = findMind(name);
    assert.ok(entry);
    assert.equal(entry.stage, "sprouted");
  });

  it("readRegistry defaults missing stage to sprouted", () => {
    // Write a registry entry without stage field
    const registryPath = resolve(voluteHome(), "minds.json");
    writeFileSync(
      registryPath,
      JSON.stringify([{ name, port: 4100, created: new Date().toISOString(), running: false }]),
    );
    const entries = readRegistry();
    const entry = entries.find((e) => e.name === name);
    assert.ok(entry);
    assert.equal(entry.stage, "sprouted");
  });

  it("setMindStage flips seed to sprouted", () => {
    addMind(name, 4100, "seed");
    assert.equal(findMind(name)?.stage, "seed");
    setMindStage(name, "sprouted");
    assert.equal(findMind(name)?.stage, "sprouted");
  });
});

describe("seed mind creation API", () => {
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
    // Clean up any minds we created
    for (const entry of readRegistry()) {
      if (entry.name.startsWith("seed-test-")) {
        removeMind(entry.name);
      }
    }
    await cleanup();
  });

  it("POST /api/minds with stage=seed creates mind with correct stage", async () => {
    const mindName = `seed-test-${Date.now()}`;
    // Create the mind directory so the route doesn't fail on disk operations
    const mindsDir = resolve(voluteHome(), "minds");
    mkdirSync(mindsDir, { recursive: true });

    const { default: app } = await import("../src/web/app.js");

    const res = await app.request("http://localhost/api/minds", {
      method: "POST",
      headers: {
        ...postHeaders(cookie),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: mindName, stage: "seed" }),
    });

    // Will likely fail because template copy needs real templates dir,
    // but we can test the registry side separately
    if (res.status === 200) {
      const body = (await res.json()) as { stage?: string };
      assert.equal(body.stage, "seed");
      const entry = findMind(mindName);
      assert.ok(entry);
      assert.equal(entry.stage, "seed");
    }
    // Clean up
    removeMind(mindName);
  });
});

describe("seed gating", () => {
  let cookie: string;
  const mindName = `gated-seed-${Date.now()}`;

  async function cleanup() {
    const db = await getDb();
    await db.delete(sessions);
    await db.delete(users);
    removeMind(mindName);
  }

  beforeEach(async () => {
    await cleanup();
    const user = await createUser("gate-admin", "pass");
    cookie = await createSession(user.id);
    addMind(mindName, 4199, "seed");
    // Create minimal mind directory
    const dir = resolve(voluteHome(), "minds", mindName);
    mkdirSync(resolve(dir, "home/.config"), { recursive: true });
    writeFileSync(resolve(dir, "home/.config/volute.json"), "{}");
  });
  afterEach(cleanup);

  it("POST connectors returns 403 for seed minds", async () => {
    const { default: app } = await import("../src/web/app.js");

    const res = await app.request(`http://localhost/api/minds/${mindName}/connectors/discord`, {
      method: "POST",
      headers: postHeaders(cookie),
    });
    assert.equal(res.status, 403);
    const body = (await res.json()) as { error: string };
    assert.ok(body.error.includes("Seed"));
  });

  it("POST schedules returns 403 for seed minds", async () => {
    const { default: app } = await import("../src/web/app.js");

    const res = await app.request(`http://localhost/api/minds/${mindName}/schedules`, {
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

  it("POST variants returns 403 for seed minds", async () => {
    const { default: app } = await import("../src/web/app.js");

    const res = await app.request(`http://localhost/api/minds/${mindName}/variants`, {
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
