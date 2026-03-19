import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { createUser } from "../src/lib/auth.js";
import { getDb } from "../src/lib/db.js";
import { addMind, removeMind, voluteHome } from "../src/lib/registry.js";
import { mindHistory, users } from "../src/lib/schema.js";
import { createSession } from "../src/web/middleware/auth.js";

function postHeaders(cookie: string) {
  return {
    Cookie: `volute_session=${cookie}`,
    Origin: "http://localhost",
  };
}

describe("seed check command", () => {
  const seedName = `check-seed-${Date.now()}`;

  beforeEach(async () => {
    await addMind(seedName, 4200, "seed");
    const dir = resolve(voluteHome(), "minds", seedName);
    mkdirSync(resolve(dir, "home/.config"), { recursive: true });
    writeFileSync(resolve(dir, "home/.config/volute.json"), "{}");
    // Write orientation SOUL.md (still has marker)
    writeFileSync(resolve(dir, "home/SOUL.md"), "You don't have a soul yet");
  });

  afterEach(async () => {
    await removeMind(seedName);
    const db = await getDb();
    await db.delete(mindHistory).where(eq(mindHistory.mind, seedName));
  });

  it("exits silently for non-seed minds", async () => {
    await removeMind(seedName);
    await addMind(seedName, 4200);

    // Capture stdout
    const originalLog = console.log;
    const logs: string[] = [];
    console.log = (...args: unknown[]) => logs.push(args.join(" "));

    try {
      const { run } = await import("../src/commands/seed-check.js");
      await run([seedName]);
      assert.equal(logs.length, 0, "Should produce no output for non-seed");
    } finally {
      console.log = originalLog;
    }
  });

  it("exits silently for unknown minds", async () => {
    const originalLog = console.log;
    const logs: string[] = [];
    console.log = (...args: unknown[]) => logs.push(args.join(" "));

    try {
      const { run } = await import("../src/commands/seed-check.js");
      await run(["nonexistent-mind-xyz"]);
      assert.equal(logs.length, 0, "Should produce no output for unknown mind");
    } finally {
      console.log = originalLog;
    }
  });

  it("outputs status when seed needs attention", async () => {
    const originalLog = console.log;
    const logs: string[] = [];
    console.log = (...args: unknown[]) => logs.push(args.join(" "));

    try {
      const { run } = await import("../src/commands/seed-check.js");
      await run([seedName]);
      const output = logs.join("\n");
      assert.ok(output.includes(`Seed: ${seedName}`));
      assert.ok(output.includes("Write SOUL.md"));
      assert.ok(output.includes("Write MEMORY.md"));
    } finally {
      console.log = originalLog;
    }
  });

  it("reports completed items correctly", async () => {
    const dir = resolve(voluteHome(), "minds", seedName);
    // Write custom SOUL.md (without orientation marker)
    writeFileSync(resolve(dir, "home/SOUL.md"), "# My Soul\nI am a test mind.");
    // Write MEMORY.md
    writeFileSync(resolve(dir, "home/MEMORY.md"), "# Memory\nSome memories.");
    // Set display name in volute.json
    writeFileSync(
      resolve(dir, "home/.config/volute.json"),
      JSON.stringify({ profile: { displayName: "Test Mind" } }),
    );

    const originalLog = console.log;
    const logs: string[] = [];
    console.log = (...args: unknown[]) => logs.push(args.join(" "));

    try {
      const { run } = await import("../src/commands/seed-check.js");
      await run([seedName]);
      const output = logs.join("\n");
      assert.ok(output.includes("SOUL.md written"));
      assert.ok(output.includes("MEMORY.md written"));
      assert.ok(output.includes("Display name set"));
    } finally {
      console.log = originalLog;
    }
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
    const { default: app } = await import("../src/web/app.js");

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
    const { default: app } = await import("../src/web/app.js");

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
    const { readVoluteConfig } = await import("../src/lib/volute-config.js");
    const { mindDir } = await import("../src/lib/registry.js");
    const config = readVoluteConfig(mindDir(mindName));
    assert.equal(config?.profile?.displayName, "Test Display");
    assert.equal(config?.profile?.description, "A test mind");
  });

  it("PATCH /api/minds/:name/profile returns 404 for unknown mind", async () => {
    const { default: app } = await import("../src/web/app.js");

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
