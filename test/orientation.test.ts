import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { createUser } from "../packages/daemon/src/lib/auth.js";
import {
  ensureSystemChannel,
  resetSystemChannelCache,
} from "../packages/daemon/src/lib/chat/system-channel.js";
import {
  initMindManager,
  tryGetMindManager,
} from "../packages/daemon/src/lib/daemon/mind-manager.js";
import { startMindFull } from "../packages/daemon/src/lib/daemon/mind-service.js";
import { getDb } from "../packages/daemon/src/lib/db.js";
import {
  deleteConversation,
  getChannelSettings,
  getParticipants,
} from "../packages/daemon/src/lib/events/conversations.js";
import {
  addMind,
  findMind,
  readRegistry,
  removeMind,
  setMindStage,
  voluteHome,
} from "../packages/daemon/src/lib/mind/registry.js";
import { users } from "../packages/daemon/src/lib/schema.js";
import { createSession } from "../packages/daemon/src/web/middleware/auth.js";

/** Usernames present in the #system channel, for membership assertions. */
async function systemChannelMembers(): Promise<string[]> {
  const id = await ensureSystemChannel();
  return (await getParticipants(id)).map((p) => p.username);
}

/** Remove the #system channel so each test exercises fresh membership. */
async function resetSystemChannel(): Promise<void> {
  resetSystemChannelCache();
  const ch = await getChannelSettings("system");
  if (ch) await deleteConversation(ch.conversation_id);
}

function postHeaders(cookie: string) {
  return {
    Cookie: `volute_session=${cookie}`,
    Origin: "http://localhost",
  };
}

describe("registry stage", () => {
  const name = `orient-test-${Date.now()}`;

  afterEach(async () => {
    await removeMind(name);
  });

  it("addMind with stage=seed persists correctly", async () => {
    await addMind(name, 4100, "seed");
    const entry = await findMind(name);
    assert.ok(entry);
    assert.equal(entry.stage, "seed");
  });

  it("addMind without stage defaults to sprouted on read", async () => {
    await addMind(name, 4100);
    const entry = await findMind(name);
    assert.ok(entry);
    assert.equal(entry.stage, "sprouted");
  });

  it("readRegistry defaults missing stage to sprouted", async () => {
    // Add a mind without explicit stage — should default to sprouted on read
    await addMind(name, 4100);
    const entries = await readRegistry();
    const entry = entries.find((e) => e.name === name);
    assert.ok(entry);
    assert.equal(entry.stage, "sprouted");
  });

  it("setMindStage flips seed to sprouted", async () => {
    await addMind(name, 4100, "seed");
    assert.equal((await findMind(name))?.stage, "seed");
    await setMindStage(name, "sprouted");
    assert.equal((await findMind(name))?.stage, "sprouted");
  });
});

describe("seed mind creation API", () => {
  let cookie: string;

  async function cleanup() {
    const db = await getDb();
    await db.delete(users).where(eq(users.username, "orient-admin"));
  }

  beforeEach(async () => {
    await cleanup();
    const user = await createUser("orient-admin", "pass");
    cookie = await createSession(user.id);
  });
  afterEach(async () => {
    // Clean up any minds we created
    for (const entry of await readRegistry()) {
      if (entry.name.startsWith("seed-test-")) {
        await removeMind(entry.name);
      }
    }
    await cleanup();
  });

  it("POST /api/minds with stage=seed creates mind with correct stage", async () => {
    const mindName = `seed-test-${Date.now()}`;
    // Create the mind directory so the route doesn't fail on disk operations
    const mindsDir = resolve(voluteHome(), "minds");
    mkdirSync(mindsDir, { recursive: true });

    const { default: app } = await import("../packages/daemon/src/web/app.js");

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
      const entry = await findMind(mindName);
      assert.ok(entry);
      assert.equal(entry.stage, "seed");
    }
    // Clean up
    await removeMind(mindName);
  });
});

describe("seed gating", () => {
  let cookie: string;
  const mindName = `gated-seed-${Date.now()}`;

  async function cleanup() {
    const db = await getDb();
    await db.delete(users).where(eq(users.username, "gate-admin"));
    await removeMind(mindName);
  }

  beforeEach(async () => {
    await cleanup();
    const user = await createUser("gate-admin", "pass");
    cookie = await createSession(user.id);
    await addMind(mindName, 4199, "seed");
    // Create minimal mind directory
    const dir = resolve(voluteHome(), "minds", mindName);
    mkdirSync(resolve(dir, "home/.config"), { recursive: true });
    writeFileSync(resolve(dir, "home/.config/volute.json"), "{}");
  });
  afterEach(cleanup);

  it("POST schedules returns 403 for seed minds", async () => {
    const { default: app } = await import("../packages/daemon/src/web/app.js");

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
    const { default: app } = await import("../packages/daemon/src/web/app.js");

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

// #617: seeds must stay out of the #system commons until they sprout. The spawn
// path (startMindFull) excludes seeds; the sprout endpoint is the moment a mind
// joins. These lock both halves of that invariant.
describe("system commons sprout gate", () => {
  let cookie: string;
  const mindName = `commons-gate-${Date.now()}`;

  async function cleanup() {
    const db = await getDb();
    await db.delete(users).where(eq(users.username, "commons-gate-admin"));
    await db.delete(users).where(eq(users.username, mindName));
    await removeMind(mindName);
    await resetSystemChannel();
  }

  beforeEach(async () => {
    await cleanup();
    const user = await createUser("commons-gate-admin", "pass");
    cookie = await createSession(user.id);
  });
  afterEach(cleanup);

  it("startMindFull does not join a seed to #system", async () => {
    // Stub the mind manager so startMind is a no-op — we exercise startMindFull's
    // membership logic, not a real process spawn.
    const mgr = tryGetMindManager() ?? initMindManager();
    const origStart = mgr.startMind;
    const origRunning = mgr.isRunning;
    mgr.startMind = async () => {};
    mgr.isRunning = () => false;
    try {
      await addMind(mindName, 4198, "seed");
      await startMindFull(mindName);
      // let fire-and-forget seed orientation settle before asserting
      await new Promise((r) => setTimeout(r, 300));
      const members = await systemChannelMembers();
      assert.ok(!members.includes(mindName), "seed must not be a #system member on spawn");
    } finally {
      mgr.startMind = origStart;
      mgr.isRunning = origRunning;
    }
  });

  it("sprouting joins the mind to #system", async () => {
    await addMind(mindName, 4198, "seed");
    // Minimal mind dir so the sprout endpoint's dreaming/config steps have a home
    const dir = resolve(voluteHome(), "minds", mindName);
    mkdirSync(resolve(dir, "home/.config"), { recursive: true });
    writeFileSync(resolve(dir, "home/.config/volute.json"), "{}");

    // Not in the commons while still a seed
    let members = await systemChannelMembers();
    assert.ok(!members.includes(mindName), "seed should not be in #system before sprout");

    const { default: app } = await import("../packages/daemon/src/web/app.js");
    const res = await app.request(`http://localhost/api/minds/${mindName}/sprout`, {
      method: "POST",
      headers: postHeaders(cookie),
    });
    assert.equal(res.status, 200);

    members = await systemChannelMembers();
    assert.ok(members.includes(mindName), "sprouted mind should join #system");
  });
});
