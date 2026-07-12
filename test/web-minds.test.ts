import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { approveUser, createUser } from "../packages/daemon/src/lib/auth.js";
import { getDb } from "../packages/daemon/src/lib/db.js";
import { users } from "../packages/daemon/src/lib/schema.js";
import { createSession, deleteSession } from "../packages/daemon/src/web/middleware/auth.js";

const TEST_USERNAMES = ["testmind-admin", "regular-user", "regular-user2"];

let sessionId: string;

async function cleanup() {
  const db = await getDb();
  for (const username of TEST_USERNAMES) {
    await db.delete(users).where(eq(users.username, username));
  }
}

async function setupAuth(): Promise<string> {
  const user = await createUser("testmind-admin", "pass");
  sessionId = await createSession(user.id);
  return sessionId;
}

// Helper to build POST request headers that pass CSRF
function postHeaders(cookie: string) {
  return {
    Cookie: `volute_session=${cookie}`,
    Origin: "http://localhost",
  };
}

describe("web minds routes", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("GET / — lists minds from registry", async () => {
    const cookie = await setupAuth();
    const { default: app } = await import("../packages/daemon/src/web/app.js");

    const res = await app.request("/api/minds", {
      headers: { Cookie: `volute_session=${cookie}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body));
  });

  it("GET /:name — 404 for missing mind", async () => {
    const cookie = await setupAuth();
    const { default: app } = await import("../packages/daemon/src/web/app.js");

    const res = await app.request("/api/minds/nonexistent-mind-xyz", {
      headers: { Cookie: `volute_session=${cookie}` },
    });
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.ok(body.error);
  });

  it("POST /:name/start — 404 for missing mind", async () => {
    const cookie = await setupAuth();
    const { default: app } = await import("../packages/daemon/src/web/app.js");

    const res = await app.request("http://localhost/api/minds/nonexistent-mind-xyz/start", {
      method: "POST",
      headers: postHeaders(cookie),
    });
    assert.equal(res.status, 404);
  });

  it("POST /:name/stop — 404 for missing mind", async () => {
    const cookie = await setupAuth();
    const { default: app } = await import("../packages/daemon/src/web/app.js");

    const res = await app.request("http://localhost/api/minds/nonexistent-mind-xyz/stop", {
      method: "POST",
      headers: postHeaders(cookie),
    });
    assert.equal(res.status, 404);
  });

  it("GET / — requires auth (401 without cookie)", async () => {
    const { default: app } = await import("../packages/daemon/src/web/app.js");

    const res = await app.request("/api/minds");
    assert.equal(res.status, 401);
  });

  it("GET / — Bearer token auth works for CLI requests", async () => {
    const token = "test-daemon-token";
    const prev = process.env.VOLUTE_DAEMON_TOKEN;
    process.env.VOLUTE_DAEMON_TOKEN = token;
    try {
      const { default: app } = await import("../packages/daemon/src/web/app.js");
      const res = await app.request("/api/minds", {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.ok(Array.isArray(body));
    } finally {
      if (prev !== undefined) {
        process.env.VOLUTE_DAEMON_TOKEN = prev;
      } else {
        delete process.env.VOLUTE_DAEMON_TOKEN;
      }
    }
  });

  it("GET / — Bearer token rejects invalid token", async () => {
    const prev = process.env.VOLUTE_DAEMON_TOKEN;
    process.env.VOLUTE_DAEMON_TOKEN = "real-token";
    try {
      const { default: app } = await import("../packages/daemon/src/web/app.js");
      const res = await app.request("/api/minds", {
        headers: { Authorization: "Bearer wrong-token" },
      });
      assert.equal(res.status, 401);
    } finally {
      if (prev !== undefined) {
        process.env.VOLUTE_DAEMON_TOKEN = prev;
      } else {
        delete process.env.VOLUTE_DAEMON_TOKEN;
      }
    }
  });

  it("POST /:name/start — blocked by CSRF without origin", async () => {
    const { default: app } = await import("../packages/daemon/src/web/app.js");

    const res = await app.request("/api/minds/test/start", {
      method: "POST",
    });
    // CSRF middleware rejects POSTs without matching origin
    assert.equal(res.status, 403);
  });

  it("POST /:name/start — non-admin user gets 403", async () => {
    // First user becomes admin
    await setupAuth();
    // Second user gets "pending" role, approve to "user"
    const user2 = await createUser("regular-user", "pass");
    await approveUser(user2.id);
    const cookie2 = await createSession(user2.id);

    const { default: app } = await import("../packages/daemon/src/web/app.js");

    const res = await app.request("http://localhost/api/minds/nonexistent/start", {
      method: "POST",
      headers: {
        Cookie: `volute_session=${cookie2}`,
        Origin: "http://localhost",
      },
    });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.error, "Forbidden");

    await deleteSession(cookie2);
  });

  it("POST / — 409 when at the maxMinds cap, with an actionable message", async () => {
    const cookie = await setupAuth();
    const { addMind, countCappedMinds, removeMind } = await import(
      "../packages/daemon/src/lib/mind/registry.js"
    );
    const { readGlobalConfig, writeGlobalConfig, _resetConfigCache } = await import(
      "../packages/daemon/src/lib/config/setup.js"
    );
    const existing = `cap-existing-${Date.now()}`;
    const savedConfig = readGlobalConfig();
    await addMind(existing, 4100);
    try {
      const count = await countCappedMinds();
      writeGlobalConfig({ ...savedConfig, maxMinds: count });

      const { default: app } = await import("../packages/daemon/src/web/app.js");
      const res = await app.request("http://localhost/api/minds", {
        method: "POST",
        headers: { ...postHeaders(cookie), "Content-Type": "application/json" },
        body: JSON.stringify({ name: `cap-over-${Date.now()}` }),
      });
      assert.equal(res.status, 409);
      const body = (await res.json()) as { error?: string };
      assert.match(body.error ?? "", /Mind limit reached/);
      assert.match(body.error ?? "", /maxMinds/);
    } finally {
      writeGlobalConfig(savedConfig);
      _resetConfigCache();
      await removeMind(existing);
    }
  });

  it("GET/PUT /api/system/max-minds — roundtrips the cap and reports the count", async () => {
    const cookie = await setupAuth();
    const { readGlobalConfig, writeGlobalConfig } = await import(
      "../packages/daemon/src/lib/config/setup.js"
    );
    const savedConfig = readGlobalConfig();
    const { default: app } = await import("../packages/daemon/src/web/app.js");
    try {
      const putRes = await app.request("http://localhost/api/system/max-minds", {
        method: "PUT",
        headers: { ...postHeaders(cookie), "Content-Type": "application/json" },
        body: JSON.stringify({ maxMinds: 42 }),
      });
      assert.equal(putRes.status, 200);
      const putBody = (await putRes.json()) as { maxMinds: number | null; count: number };
      assert.equal(putBody.maxMinds, 42);
      assert.equal(typeof putBody.count, "number");

      const getRes = await app.request("http://localhost/api/system/max-minds", {
        headers: { Cookie: `volute_session=${cookie}` },
      });
      assert.equal(getRes.status, 200);
      assert.equal(((await getRes.json()) as { maxMinds: number | null }).maxMinds, 42);

      // null clears the cap (unlimited)
      const clearRes = await app.request("http://localhost/api/system/max-minds", {
        method: "PUT",
        headers: { ...postHeaders(cookie), "Content-Type": "application/json" },
        body: JSON.stringify({ maxMinds: null }),
      });
      assert.equal(clearRes.status, 200);
      assert.equal(((await clearRes.json()) as { maxMinds: number | null }).maxMinds, null);
    } finally {
      writeGlobalConfig(savedConfig);
    }
  });

  it("PUT /api/system/max-minds — rejects non-positive and non-integer caps (400)", async () => {
    // The Zod schema is the real trust boundary: a cap of 0 would silently block
    // ALL mind creation, so 0/-1/1.5 must never persist.
    const cookie = await setupAuth();
    const { default: app } = await import("../packages/daemon/src/web/app.js");
    for (const bad of [0, -1, 1.5]) {
      const res = await app.request("http://localhost/api/system/max-minds", {
        method: "PUT",
        headers: { ...postHeaders(cookie), "Content-Type": "application/json" },
        body: JSON.stringify({ maxMinds: bad }),
      });
      assert.equal(res.status, 400, `maxMinds: ${bad} should be rejected`);
    }
  });

  it("PUT /api/system/max-minds — non-admin gets 403", async () => {
    await setupAuth();
    const user2 = await createUser("regular-user", "pass");
    await approveUser(user2.id);
    const cookie2 = await createSession(user2.id);
    const { default: app } = await import("../packages/daemon/src/web/app.js");
    const res = await app.request("http://localhost/api/system/max-minds", {
      method: "PUT",
      headers: {
        Cookie: `volute_session=${cookie2}`,
        Origin: "http://localhost",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ maxMinds: 5 }),
    });
    assert.equal(res.status, 403);
    await deleteSession(cookie2);
  });

  it("GET /api/system/max-minds — non-admin gets 403", async () => {
    // requireAdmin guards GET too, but authz-coverage.test.ts only protects
    // /:name routes, so exercise this literal route directly.
    await setupAuth();
    const user2 = await createUser("regular-user2", "pass");
    await approveUser(user2.id);
    const cookie2 = await createSession(user2.id);
    const { default: app } = await import("../packages/daemon/src/web/app.js");
    const res = await app.request("http://localhost/api/system/max-minds", {
      headers: { Cookie: `volute_session=${cookie2}` },
    });
    assert.equal(res.status, 403);
    await deleteSession(cookie2);
  });

  it("GET /:name/history/export — 404 for missing mind", async () => {
    const cookie = await setupAuth();
    const { default: app } = await import("../packages/daemon/src/web/app.js");

    const res = await app.request("/api/minds/nonexistent-mind-xyz/history/export", {
      headers: { Cookie: `volute_session=${cookie}` },
    });
    assert.equal(res.status, 404);
  });

  it("GET / — non-admin user can still list minds", async () => {
    await setupAuth();
    const user2 = await createUser("regular-user2", "pass");
    await approveUser(user2.id);
    const cookie2 = await createSession(user2.id);

    const { default: app } = await import("../packages/daemon/src/web/app.js");

    const res = await app.request("/api/minds", {
      headers: { Cookie: `volute_session=${cookie2}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body));

    await deleteSession(cookie2);
  });

  it("GET / — exposes templateStale for each mind", async () => {
    const { mkdirSync, readFileSync, rmSync, writeFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const { addMind, mindDir, removeMind } = await import(
      "../packages/daemon/src/lib/mind/registry.js"
    );
    const { composeTemplate, copyTemplateToDir, findTemplatesRoot } = await import(
      "../packages/daemon/src/lib/template/template.js"
    );
    const { initMindManager, tryGetMindManager } = await import(
      "../packages/daemon/src/lib/daemon/mind-manager.js"
    );
    if (!tryGetMindManager()) initMindManager();

    const name = `web-stale-${Date.now()}`;
    const dir = resolve(mindDir(name));
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const { composedDir, manifest } = composeTemplate(findTemplatesRoot(), "claude");
    try {
      copyTemplateToDir(composedDir, dir, name, manifest);
    } finally {
      rmSync(composedDir, { recursive: true, force: true });
    }
    await addMind(name, 4199, undefined, "claude");

    try {
      const cookie = await setupAuth();
      const { default: app } = await import("../packages/daemon/src/web/app.js");
      const res = await app.request("/api/minds", {
        headers: { Cookie: `volute_session=${cookie}` },
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as Array<{ name: string; templateStale?: boolean }>;
      const pristine = body.find((m) => m.name === name);
      assert.ok(pristine, "created mind should be listed");
      assert.equal(pristine.templateStale, false, "a pristine mind is current");

      // Drift the mind's framework code and confirm the API flips to stale.
      const agent = resolve(dir, "src", "agent.ts");
      writeFileSync(agent, `${readFileSync(agent, "utf-8")}\n// drift\n`);
      const res2 = await app.request("/api/minds", {
        headers: { Cookie: `volute_session=${cookie}` },
      });
      const body2 = (await res2.json()) as Array<{ name: string; templateStale?: boolean }>;
      assert.equal(body2.find((m) => m.name === name)?.templateStale, true);
    } finally {
      await removeMind(name);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("GET /:name — surfaces lastNotice to admins only (#573)", async () => {
    const { mkdirSync, rmSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const { addMind, mindDir, removeMind } = await import(
      "../packages/daemon/src/lib/mind/registry.js"
    );
    const { recordNotice } = await import("../packages/daemon/src/lib/daemon/notices.js");
    const { initMindManager, tryGetMindManager } = await import(
      "../packages/daemon/src/lib/daemon/mind-manager.js"
    );
    if (!tryGetMindManager()) initMindManager();

    const name = `web-notice-${Date.now()}`;
    const dir = resolve(mindDir(name));
    mkdirSync(dir, { recursive: true });
    await addMind(name, 4198, undefined, "claude");
    await recordNotice({
      mind: name,
      session: "",
      kind: "startup",
      reason: "no_credentials",
      detail: "no anthropic key — mind will stay silent",
    });

    try {
      const cookie = await setupAuth();
      const { default: app } = await import("../packages/daemon/src/web/app.js");
      const res = await app.request(`/api/minds/${name}`, {
        headers: { Cookie: `volute_session=${cookie}` },
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        lastNotice?: { kind: string; reason: string; detail: string; created_at: string };
      };
      assert.ok(body.lastNotice, "admin sees lastNotice");
      assert.equal(body.lastNotice.kind, "startup");
      assert.equal(body.lastNotice.reason, "no_credentials");
      assert.match(body.lastNotice.detail, /stay silent/);
      assert.ok(body.lastNotice.created_at);

      // Non-privileged callers get profile-level fields only — no lastNotice.
      const user2 = await createUser("regular-user2", "pass");
      await approveUser(user2.id);
      const cookie2 = await createSession(user2.id);
      const res2 = await app.request(`/api/minds/${name}`, {
        headers: { Cookie: `volute_session=${cookie2}` },
      });
      assert.equal(res2.status, 200);
      const body2 = (await res2.json()) as { lastNotice?: unknown };
      assert.equal(body2.lastNotice, undefined);
      await deleteSession(cookie2);
    } finally {
      await removeMind(name);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("GET /:name — surfaces the sprout checklist for seed minds (#664)", async () => {
    const { mkdirSync, rmSync, writeFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const { addMind, mindDir, removeMind } = await import(
      "../packages/daemon/src/lib/mind/registry.js"
    );
    const { initMindManager, tryGetMindManager } = await import(
      "../packages/daemon/src/lib/daemon/mind-manager.js"
    );
    if (!tryGetMindManager()) initMindManager();

    const name = `web-seed-${Date.now()}`;
    const dir = resolve(mindDir(name));
    mkdirSync(resolve(dir, "home/.config"), { recursive: true });
    // SOUL written (no orientation marker), MEMORY still unwritten (empty),
    // display name set — a partially-oriented seed.
    writeFileSync(resolve(dir, "home/SOUL.md"), "# Me\nA real identity.");
    writeFileSync(resolve(dir, "home/MEMORY.md"), "   \n");
    writeFileSync(
      resolve(dir, "home/.config/volute.json"),
      JSON.stringify({ profile: { displayName: "Sprout" } }),
    );
    await addMind(name, 4197, "seed", "claude");

    try {
      const cookie = await setupAuth();
      const { default: app } = await import("../packages/daemon/src/web/app.js");
      const res = await app.request(`/api/minds/${name}`, {
        headers: { Cookie: `volute_session=${cookie}` },
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        seedChecklist?: {
          soulWritten: boolean;
          memoryWritten: boolean;
          displayNameSet: boolean;
          avatarSet: boolean;
        };
      };
      assert.ok(body.seedChecklist, "seed minds expose seedChecklist");
      assert.equal(body.seedChecklist.soulWritten, true);
      assert.equal(body.seedChecklist.memoryWritten, false);
      assert.equal(body.seedChecklist.displayNameSet, true);
      assert.equal(body.seedChecklist.avatarSet, false);

      // Non-privileged callers get the checklist too — it's derived from
      // already-public profile fields, nothing secret.
      const user2 = await createUser("regular-user2", "pass");
      await approveUser(user2.id);
      const cookie2 = await createSession(user2.id);
      const res2 = await app.request(`/api/minds/${name}`, {
        headers: { Cookie: `volute_session=${cookie2}` },
      });
      const body2 = (await res2.json()) as { seedChecklist?: { soulWritten: boolean } };
      assert.ok(body2.seedChecklist, "non-privileged callers also see the checklist");
      assert.equal(body2.seedChecklist.soulWritten, true);
      await deleteSession(cookie2);

      // The dashboard renders the card from the list route (data.minds), a
      // separate call site from GET /:name — assert the checklist rides it too.
      const listRes = await app.request("/api/minds", {
        headers: { Cookie: `volute_session=${cookie}` },
      });
      assert.equal(listRes.status, 200);
      const list = (await listRes.json()) as Array<{
        name: string;
        seedChecklist?: { soulWritten: boolean; displayNameSet: boolean };
      }>;
      const listed = list.find((m) => m.name === name);
      assert.ok(listed?.seedChecklist, "list route carries the seed checklist");
      assert.equal(listed.seedChecklist.soulWritten, true);
      assert.equal(listed.seedChecklist.displayNameSet, true);
    } finally {
      await removeMind(name);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("GET /:name — omits the sprout checklist for sprouted minds (#664)", async () => {
    const { mkdirSync, rmSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const { addMind, mindDir, removeMind } = await import(
      "../packages/daemon/src/lib/mind/registry.js"
    );
    const { initMindManager, tryGetMindManager } = await import(
      "../packages/daemon/src/lib/daemon/mind-manager.js"
    );
    if (!tryGetMindManager()) initMindManager();

    const name = `web-sprouted-${Date.now()}`;
    const dir = resolve(mindDir(name));
    mkdirSync(dir, { recursive: true });
    await addMind(name, 4196, "sprouted", "claude");

    try {
      const cookie = await setupAuth();
      const { default: app } = await import("../packages/daemon/src/web/app.js");
      const res = await app.request(`/api/minds/${name}`, {
        headers: { Cookie: `volute_session=${cookie}` },
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { seedChecklist?: unknown };
      assert.equal(body.seedChecklist, undefined);
    } finally {
      await removeMind(name);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("toPublicMind", () => {
  it("strips lastError.detail from the non-privileged projection", async () => {
    // detail can embed the raw error string (unknown classifications), which is
    // mind-private — non-admin callers get kind/reason/at only.
    const { toPublicMind } = await import("../packages/daemon/src/web/api/minds.js");
    const entry = {
      name: "proj-test",
      port: 4100,
      created: "2026-01-01",
      running: true,
      mindType: "mind" as const,
    };
    const status = {
      status: "running" as const,
      wakeAt: null,
      lastError: {
        kind: "turn_error" as const,
        reason: "unknown",
        detail: "Your last turn failed with an error: raw-private-text",
        at: "2026-07-10 12:00:00",
      },
      channels: [],
      displayName: undefined,
      description: undefined,
      avatar: undefined,
    };
    const pub = toPublicMind(entry, status, { hasPages: false });
    assert.deepEqual(pub.lastError, {
      kind: "turn_error",
      reason: "unknown",
      at: "2026-07-10 12:00:00",
    });
    assert.ok(!JSON.stringify(pub).includes("raw-private-text"));
  });
});
