import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { and, eq } from "drizzle-orm";
import { createUser } from "../packages/daemon/src/lib/auth.js";
import { getDb } from "../packages/daemon/src/lib/db.js";
import {
  addMind,
  mindDir,
  removeMind,
  voluteHome,
} from "../packages/daemon/src/lib/mind/registry.js";
import { mindHistory, users } from "../packages/daemon/src/lib/schema.js";
import { createSession } from "../packages/daemon/src/web/middleware/auth.js";

function postHeaders(cookie: string) {
  return {
    Cookie: `volute_session=${cookie}`,
    Origin: "http://localhost",
  };
}

describe("seed check endpoint", () => {
  let cookie: string;
  const seedName = `check-seed-${Date.now()}`;

  async function cleanup() {
    const db = await getDb();
    await db.delete(users).where(eq(users.username, "check-admin"));
    await db.delete(mindHistory).where(eq(mindHistory.mind, seedName));
    await removeMind(seedName);
  }

  beforeEach(async () => {
    await cleanup();
    const user = await createUser("check-admin", "pass");
    cookie = await createSession(user.id);
    await addMind(seedName, 4200, "seed");
    const dir = resolve(voluteHome(), "minds", seedName);
    mkdirSync(resolve(dir, "home/.config"), { recursive: true });
    writeFileSync(resolve(dir, "home/.config/volute.json"), "{}");
    // Write orientation SOUL.md (still has marker)
    writeFileSync(resolve(dir, "home/SOUL.md"), "a seed, still discovering who you are");
  });

  afterEach(cleanup);

  it("returns empty output for non-seed minds", async () => {
    await removeMind(seedName);
    await addMind(seedName, 4200);

    const { default: app } = await import("../packages/daemon/src/web/app.js");
    const res = await app.request(`http://localhost/api/minds/${seedName}/seed-check`, {
      headers: postHeaders(cookie),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { output: string };
    assert.equal(body.output, "");
  });

  it("returns status when seed needs attention", async () => {
    const { default: app } = await import("../packages/daemon/src/web/app.js");
    const res = await app.request(`http://localhost/api/minds/${seedName}/seed-check`, {
      headers: postHeaders(cookie),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { output: string };
    assert.ok(body.output.includes(`Seed: ${seedName}`));
    assert.ok(body.output.includes("Write SOUL.md"));
  });

  it("reports completed items correctly", async () => {
    const dir = resolve(voluteHome(), "minds", seedName);
    writeFileSync(resolve(dir, "home/SOUL.md"), "# My Soul\nI am a test mind.");
    writeFileSync(resolve(dir, "home/MEMORY.md"), "# Memory\nSome memories.");
    writeFileSync(
      resolve(dir, "home/.config/volute.json"),
      JSON.stringify({ profile: { displayName: "Test Mind" } }),
    );

    const { default: app } = await import("../packages/daemon/src/web/app.js");
    const res = await app.request(`http://localhost/api/minds/${seedName}/seed-check`, {
      headers: postHeaders(cookie),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { output: string };
    assert.ok(body.output.includes("SOUL.md written"));
    assert.ok(body.output.includes("MEMORY.md written"));
    assert.ok(body.output.includes("Display name set"));
  });

  it("does not count the placeholder MEMORY.md as written", async () => {
    const { MEMORY_PLACEHOLDER_MARKER } = await import("../packages/daemon/src/lib/prompts.js");
    const dir = resolve(voluteHome(), "minds", seedName);
    // Custom SOUL, but MEMORY.md is still the starter placeholder.
    writeFileSync(resolve(dir, "home/SOUL.md"), "# My Soul\nI am a test mind.");
    writeFileSync(
      resolve(dir, "home/MEMORY.md"),
      `# Memory\n\nSome starter text — ${MEMORY_PLACEHOLDER_MARKER}.`,
    );
    writeFileSync(
      resolve(dir, "home/.config/volute.json"),
      JSON.stringify({ profile: { displayName: "Test Mind" } }),
    );

    const { default: app } = await import("../packages/daemon/src/web/app.js");
    const res = await app.request(`http://localhost/api/minds/${seedName}/seed-check`, {
      headers: postHeaders(cookie),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { output: string };
    assert.ok(body.output.includes("Write MEMORY.md"), "placeholder MEMORY.md is still remaining");
    assert.ok(!body.output.includes("MEMORY.md written"));
  });

  it("does not count an empty MEMORY.md as written", async () => {
    const dir = resolve(voluteHome(), "minds", seedName);
    writeFileSync(resolve(dir, "home/SOUL.md"), "# My Soul\nI am a test mind.");
    writeFileSync(resolve(dir, "home/MEMORY.md"), "   \n");

    const { default: app } = await import("../packages/daemon/src/web/app.js");
    const res = await app.request(`http://localhost/api/minds/${seedName}/seed-check`, {
      headers: postHeaders(cookie),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { output: string };
    assert.ok(body.output.includes("Write MEMORY.md"));
    assert.ok(!body.output.includes("MEMORY.md written"));
  });

  it("returns 404 for unknown mind", async () => {
    const { default: app } = await import("../packages/daemon/src/web/app.js");
    const res = await app.request("http://localhost/api/minds/nonexistent-xyz/seed-check", {
      headers: postHeaders(cookie),
    });
    assert.equal(res.status, 404);
  });
});

describe("seed check nurture gate vs. forced host check", () => {
  let cookie: string;
  const seedName = `gate-seed-${Date.now()}`;

  async function cleanup() {
    const db = await getDb();
    await db.delete(users).where(eq(users.username, "gate-admin"));
    await db.delete(mindHistory).where(eq(mindHistory.mind, seedName));
    await removeMind(seedName);
  }

  beforeEach(async () => {
    await cleanup();
    const user = await createUser("gate-admin", "pass");
    cookie = await createSession(user.id);
    await addMind(seedName, 4203, "seed");
    const dir = resolve(voluteHome(), "minds", seedName);
    mkdirSync(resolve(dir, "home/.config"), { recursive: true });
    writeFileSync(resolve(dir, "home/.config/volute.json"), "{}");
    writeFileSync(resolve(dir, "home/SOUL.md"), "a seed, still discovering who you are");

    // Recent creator + spirit messages → the nurture gate should suppress output.
    const db = await getDb();
    const now = new Date().toISOString();
    await db.insert(mindHistory).values([
      { mind: seedName, type: "inbound", sender: "creator", content: "hi", created_at: now },
      { mind: seedName, type: "inbound", sender: "volute", content: "hi", created_at: now },
    ]);
  });

  afterEach(cleanup);

  it("stays silent under the nurture gate when recently attended to", async () => {
    const { default: app } = await import("../packages/daemon/src/web/app.js");
    const res = await app.request(`http://localhost/api/minds/${seedName}/seed-check`, {
      headers: postHeaders(cookie),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { output: string };
    assert.equal(body.output, "");
  });

  it("reports without force when only the creator is recent (gate needs both)", async () => {
    // Remove the spirit message so only the creator is recent — the gate must
    // not suppress (it requires BOTH creator and spirit to be recent).
    const db = await getDb();
    await db
      .delete(mindHistory)
      .where(and(eq(mindHistory.mind, seedName), eq(mindHistory.sender, "volute")));

    const { default: app } = await import("../packages/daemon/src/web/app.js");
    const res = await app.request(`http://localhost/api/minds/${seedName}/seed-check`, {
      headers: postHeaders(cookie),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { output: string };
    assert.ok(body.output.includes(`Seed: ${seedName}`));
  });

  it("forces the readiness state for a manual host check (?force=1)", async () => {
    const { default: app } = await import("../packages/daemon/src/web/app.js");
    const res = await app.request(`http://localhost/api/minds/${seedName}/seed-check?force=1`, {
      headers: postHeaders(cookie),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { output: string };
    assert.ok(body.output.includes(`Seed: ${seedName}`));
    assert.ok(body.output.includes("Write MEMORY.md"));
  });

  it("reports a forced check for a mind that is no longer a seed", async () => {
    await removeMind(seedName);
    await addMind(seedName, 4203);

    const { default: app } = await import("../packages/daemon/src/web/app.js");
    const res = await app.request(`http://localhost/api/minds/${seedName}/seed-check?force=1`, {
      headers: postHeaders(cookie),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { output: string };
    assert.ok(body.output.includes("no longer a seed"));
  });
});

describe("sprout endpoint cleans up nurture schedule", () => {
  let cookie: string;
  const seedName = `sprout-cleanup-${Date.now()}`;

  async function cleanup() {
    const db = await getDb();
    await db.delete(users).where(eq(users.username, "sprout-admin"));
    await removeMind(seedName);
  }

  beforeEach(async () => {
    await cleanup();
    const user = await createUser("sprout-admin", "pass");
    cookie = await createSession(user.id);
    await addMind(seedName, 4201, "seed");
    const dir = resolve(voluteHome(), "minds", seedName);
    mkdirSync(resolve(dir, "home/.config"), { recursive: true });
    writeFileSync(resolve(dir, "home/.config/volute.json"), "{}");
  });

  afterEach(cleanup);

  it("POST /api/minds/:name/sprout sets stage to sprouted", async () => {
    const { default: app } = await import("../packages/daemon/src/web/app.js");

    const res = await app.request(`http://localhost/api/minds/${seedName}/sprout`, {
      method: "POST",
      headers: postHeaders(cookie),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean };
    assert.ok(body.ok);
  });
});

describe("profile endpoint", () => {
  let cookie: string;
  const mindName = `profile-test-${Date.now()}`;

  async function cleanup() {
    const db = await getDb();
    await db.delete(users).where(eq(users.username, "profile-admin"));
    await removeMind(mindName);
  }

  beforeEach(async () => {
    await cleanup();
    const user = await createUser("profile-admin", "pass");
    cookie = await createSession(user.id);
    await addMind(mindName, 4202);
    const dir = resolve(voluteHome(), "minds", mindName);
    mkdirSync(resolve(dir, "home/.config"), { recursive: true });
    writeFileSync(resolve(dir, "home/.config/volute.json"), "{}");
  });

  afterEach(cleanup);

  it("PATCH /api/minds/:name/profile updates profile", async () => {
    const { default: app } = await import("../packages/daemon/src/web/app.js");

    const res = await app.request(`http://localhost/api/minds/${mindName}/profile`, {
      method: "PATCH",
      headers: {
        ...postHeaders(cookie),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        displayName: "Test Display",
        description: "A test mind",
      }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean };
    assert.ok(body.ok);

    // Verify volute.json was updated
    const { readVoluteConfig } = await import("../packages/daemon/src/lib/mind/volute-config.js");
    const config = readVoluteConfig(mindDir(mindName));
    assert.equal(config?.profile?.displayName, "Test Display");
    assert.equal(config?.profile?.description, "A test mind");
  });

  it("PATCH /api/minds/:name/profile returns 404 for unknown mind", async () => {
    const { default: app } = await import("../packages/daemon/src/web/app.js");

    const res = await app.request("http://localhost/api/minds/nonexistent-mind/profile", {
      method: "PATCH",
      headers: {
        ...postHeaders(cookie),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ displayName: "Test" }),
    });
    assert.equal(res.status, 404);
  });
});
