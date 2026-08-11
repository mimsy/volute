import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { createUser } from "../packages/daemon/src/lib/auth.js";
import { getDb } from "../packages/daemon/src/lib/db.js";
import { addMind, removeMind } from "../packages/daemon/src/lib/mind/registry.js";
import { users } from "../packages/daemon/src/lib/schema.js";
import { createSession, deleteSession } from "../packages/daemon/src/web/middleware/auth.js";

// Bad-payload coverage for the zValidator sweep (#333). Each case asserts a 400 whose
// body carries the zod envelope (`success: false`) — the structured error zValidator
// emits. Asserting on `success` (rather than just the status) is what makes each test a
// reverted-feature check: drop the validator and the route no longer produces that
// envelope, so the assertion fails.
//
// Path convention (see the brief): routes on a module with a v1 mount use /api/v1/…;
// the bare-/api modules on this base — setup, extensions, and the mind-scoped
// channels/file-sharing under /api/minds — use their bare path.

const ADMIN = "reqval-admin";
const MIND = "reqval-mind";
const MIND_PORT = 4820;

let adminCookie: string;
const sessions: string[] = [];

async function cleanup() {
  const db = await getDb();
  await db.delete(users).where(eq(users.username, ADMIN));
  try {
    await removeMind(MIND);
  } catch {
    // not registered
  }
}

function headers() {
  return {
    Cookie: `volute_session=${adminCookie}`,
    Origin: "http://localhost",
    "Content-Type": "application/json",
  };
}

async function loadApp() {
  const { default: app } = await import("../packages/daemon/src/web/app.js");
  return app;
}

/** Send a malformed body and assert a structured zod 400. */
async function expectZod400(method: string, path: string, body: unknown, withAuth = true) {
  const app = await loadApp();
  const res = await app.request(`http://localhost${path}`, {
    method,
    headers: withAuth
      ? headers()
      : { Origin: "http://localhost", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  assert.equal(res.status, 400, `${method} ${path} — expected 400 for ${JSON.stringify(body)}`);
  const json = (await res.json()) as { success?: boolean };
  assert.equal(
    json.success,
    false,
    `${method} ${path} — expected a zod envelope (success:false), got ${JSON.stringify(json)}`,
  );
}

describe("request-body validation (#333 zValidator sweep)", () => {
  beforeEach(async () => {
    await cleanup();
    // First human user is auto-admin — passes requireSelf and requireAdmin.
    const admin = await createUser(ADMIN, "pass");
    adminCookie = await createSession(admin.id);
    sessions.push(adminCookie);
    await addMind(MIND, MIND_PORT);
  });
  afterEach(async () => {
    while (sessions.length) deleteSession(sessions.pop()!);
    await cleanup();
  });

  // ── minds.ts (v1) ──
  it("PATCH /:name/profile — non-string avatar", async () => {
    await expectZod400("PATCH", `/api/v1/minds/${MIND}/profile`, { avatar: 123 });
  });
  it("POST /:name/gates/decline — missing channel", async () => {
    await expectZod400("POST", `/api/v1/minds/${MIND}/gates/decline`, {});
  });
  it("POST /:name/gates/accept — missing channel", async () => {
    await expectZod400("POST", `/api/v1/minds/${MIND}/gates/accept`, { thread: "x" });
  });
  it("POST /:name/ai/complete — missing message", async () => {
    await expectZod400("POST", `/api/v1/minds/${MIND}/ai/complete`, { systemPrompt: "x" });
  });
  it("POST /:name/events — missing type", async () => {
    await expectZod400("POST", `/api/v1/minds/${MIND}/events`, { channel: "x" });
  });
  it("POST /:name/history — missing content", async () => {
    await expectZod400("POST", `/api/v1/minds/${MIND}/history`, { channel: "x" });
  });
  it("POST /import — non-string field", async () => {
    await expectZod400("POST", "/api/v1/minds/import", { name: 123 });
  });

  // ── schedules.ts (v1) ──
  it("POST /:name/schedules — non-string id", async () => {
    await expectZod400("POST", `/api/v1/minds/${MIND}/schedules`, { id: 123 });
  });
  it("PUT /:name/schedules/:id — non-array messages", async () => {
    await expectZod400("PUT", `/api/v1/minds/${MIND}/schedules/some-id`, { messages: "nope" });
  });
  it("PUT /:name/sleep/config — non-boolean enabled", async () => {
    await expectZod400("PUT", `/api/v1/minds/${MIND}/sleep/config`, { enabled: "yes" });
  });
  it("PUT /:name/sleep/config — schedule missing wake", async () => {
    await expectZod400("PUT", `/api/v1/minds/${MIND}/sleep/config`, {
      schedule: { sleep: "0 22 * * *" },
    });
  });

  // ── skills.ts (v1) ──
  it("PUT /skills/defaults/list — non-array skills", async () => {
    await expectZod400("PUT", "/api/v1/skills/defaults/list", { skills: "not-an-array" });
  });
  it("POST /skills/defaults/list — missing skill", async () => {
    await expectZod400("POST", "/api/v1/skills/defaults/list", {});
  });
  it("PUT /skills/auto-update — non-boolean enabled", async () => {
    await expectZod400("PUT", "/api/v1/skills/auto-update", { enabled: "yes" });
  });

  // ── file-sharing.ts (canonical /api/v1/minds) ──
  it("POST /:name/files/send — missing filePath", async () => {
    await expectZod400("POST", `/api/v1/minds/${MIND}/files/send`, { targetMind: "x" });
  });
  it("POST /:name/files/accept — missing id", async () => {
    await expectZod400("POST", `/api/v1/minds/${MIND}/files/accept`, {});
  });
  it("POST /:name/files/reject — missing id", async () => {
    await expectZod400("POST", `/api/v1/minds/${MIND}/files/reject`, {});
  });
  it("POST /:name/files/stage — missing data", async () => {
    await expectZod400("POST", `/api/v1/minds/${MIND}/files/stage`, {
      sender: "x",
      filename: "y",
    });
  });

  // ── channels.ts (canonical /api/v1/minds) ──
  it("POST /:name/channels/create — missing platform", async () => {
    await expectZod400("POST", `/api/v1/minds/${MIND}/channels/create`, { participants: [] });
  });

  // ── extensions.ts (canonical /api/v1/extensions) ──
  it("PUT /extensions/:id/enabled — non-boolean enabled", async () => {
    await expectZod400("PUT", "/api/v1/extensions/some-ext/enabled", { enabled: "yes" });
  });
  it("POST /extensions/install — missing package", async () => {
    await expectZod400("POST", "/api/v1/extensions/install", {});
  });

  // ── setup.ts (canonical /api/v1/setup, no auth — zValidator runs before the setup-state guard) ──
  it("POST /setup/system — missing name", async () => {
    await expectZod400("POST", "/api/v1/setup/system", {}, false);
  });
  it("POST /setup/system/register — missing slug", async () => {
    await expectZod400("POST", "/api/v1/setup/system/register", {}, false);
  });
  it("POST /setup/system/login — missing key", async () => {
    await expectZod400("POST", "/api/v1/setup/system/login", {}, false);
  });
  it("POST /setup/account — missing password", async () => {
    await expectZod400("POST", "/api/v1/setup/account", { username: "x" }, false);
  });
  it("POST /setup/models — missing spiritModel", async () => {
    await expectZod400("POST", "/api/v1/setup/models", { models: ["a"] }, false);
  });
  it("POST /setup/spirit — missing name", async () => {
    await expectZod400("POST", "/api/v1/setup/spirit", {}, false);
  });
});
