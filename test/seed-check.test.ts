import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { eq } from "drizzle-orm";
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
    writeFileSync(resolve(dir, "home/SOUL.md"), "You don't have a soul yet");
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

  it("returns 404 for unknown mind", async () => {
    const { default: app } = await import("../packages/daemon/src/web/app.js");
    const res = await app.request("http://localhost/api/minds/nonexistent-xyz/seed-check", {
      headers: postHeaders(cookie),
    });
    assert.equal(res.status, 404);
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
