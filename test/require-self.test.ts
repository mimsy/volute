import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { approveUser, createUser, getOrCreateMindUser } from "../packages/daemon/src/lib/auth.js";
import { generateMindToken } from "../packages/daemon/src/lib/daemon/mind-tokens.js";
import { getDb } from "../packages/daemon/src/lib/db.js";
import {
  addMind,
  addVariant,
  mindDir,
  removeMind,
} from "../packages/daemon/src/lib/mind/registry.js";
import { users } from "../packages/daemon/src/lib/schema.js";
import {
  authMiddleware,
  createSession,
  requireAdmin,
  requireSelf,
} from "../packages/daemon/src/web/middleware/auth.js";

const testMind = `require-self-test-${Date.now()}`;
const testVariant = `${testMind}-variant`;

const TEST_USERNAMES = ["admin-user", "admin-placeholder", "regular-user", testMind];

async function cleanup() {
  const db = await getDb();
  for (const username of TEST_USERNAMES) {
    await db.delete(users).where(eq(users.username, username));
  }
  try {
    await removeMind(testMind);
  } catch {}
  try {
    await removeMind(testVariant);
  } catch {}
}

function createApp() {
  const app = new Hono();
  app.use("/api/minds/*", authMiddleware);

  // Route protected by requireSelf
  app.get("/api/minds/:name/info", requireSelf(), (c) => {
    return c.json({ ok: true, name: c.req.param("name") });
  });

  // Route protected by requireAdmin for comparison
  app.get("/api/minds/:name/admin-only", requireAdmin, (c) => {
    return c.json({ ok: true });
  });

  return app;
}

describe("requireSelf middleware", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("admin can access any mind", async () => {
    const admin = await createUser("admin-user", "pass");
    const sessionId = await createSession(admin.id);
    await addMind(testMind, 4400);
    const app = createApp();

    const res = await app.request(`/api/minds/${testMind}/info`, {
      headers: { Cookie: `volute_session=${sessionId}` },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean };
    assert.equal(body.ok, true);
  });

  it("mind can access itself via mind token", async () => {
    await addMind(testMind, 4400);
    await getOrCreateMindUser(testMind);
    const token = generateMindToken(testMind);
    const app = createApp();

    const res = await app.request(`/api/minds/${testMind}/info`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean };
    assert.equal(body.ok, true);
  });

  it("mind cannot access a different mind", async () => {
    await addMind(testMind, 4400);
    await addMind("other-mind", 4401);
    await getOrCreateMindUser(testMind);
    const token = generateMindToken(testMind);
    const app = createApp();

    const res = await app.request("/api/minds/other-mind/info", {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 403);

    try {
      await removeMind("other-mind");
    } catch {}
  });

  it("non-admin brain user gets 403", async () => {
    // Create admin first so the second user isn't auto-promoted
    await createUser("admin-placeholder", "pass");
    const user = await createUser("regular-user", "pass");
    await approveUser(user.id);
    const sessionId = await createSession(user.id);
    await addMind(testMind, 4400);
    const app = createApp();

    const res = await app.request(`/api/minds/${testMind}/info`, {
      headers: { Cookie: `volute_session=${sessionId}` },
    });
    assert.equal(res.status, 403);
  });

  it("variant resolves to parent mind for self-check", async () => {
    await addMind(testMind, 4400);
    await addVariant(testVariant, testMind, 4401, mindDir(testMind), "variant-branch");
    await getOrCreateMindUser(testMind);
    const token = generateMindToken(testMind);
    const app = createApp();

    // Parent mind can access its own variant
    const res = await app.request(`/api/minds/${testVariant}/info`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 200);
  });

  it("unauthenticated request gets 401", async () => {
    const app = createApp();
    const res = await app.request(`/api/minds/${testMind}/info`);
    assert.equal(res.status, 401);
  });

  it("requireAdmin still blocks non-admin users", async () => {
    await addMind(testMind, 4400);
    await getOrCreateMindUser(testMind);
    const token = generateMindToken(testMind);
    const app = createApp();

    const res = await app.request(`/api/minds/${testMind}/admin-only`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 403);
  });
});
