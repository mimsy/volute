import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { createUser } from "../packages/daemon/src/lib/auth.js";
import { getDb } from "../packages/daemon/src/lib/db.js";
import { addMind, removeMind } from "../packages/daemon/src/lib/mind/registry.js";
import { users } from "../packages/daemon/src/lib/schema.js";
import { createSession } from "../packages/daemon/src/web/middleware/auth.js";

const TEST_MIND = "channels-test-mind";
const TEST_USERNAMES = ["channels-admin"];

let sessionId: string;

async function cleanup() {
  const db = await getDb();
  for (const username of TEST_USERNAMES) {
    await db.delete(users).where(eq(users.username, username));
  }
  try {
    removeMind(TEST_MIND);
  } catch {
    // ignore if not registered
  }
}

async function setupAuth(): Promise<string> {
  const user = await createUser("channels-admin", "pass");
  sessionId = await createSession(user.id);
  return sessionId;
}

function postHeaders(cookie: string) {
  return {
    Cookie: `volute_session=${cookie}`,
    Origin: "http://localhost",
    "Content-Type": "application/json",
  };
}

describe("web channels routes", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  // --- create ---

  it("POST /:name/channels/create — 404 for nonexistent mind", async () => {
    const cookie = await setupAuth();
    const { default: app } = await import("../packages/daemon/src/web/app.js");

    const res = await app.request(
      "http://localhost/api/minds/nonexistent-ch-mind/channels/create",
      {
        method: "POST",
        headers: postHeaders(cookie),
        body: JSON.stringify({ platform: "discord", participants: ["user1"] }),
      },
    );
    assert.equal(res.status, 404);
  });

  it("POST /:name/channels/create — 400 for platform without createConversation", async () => {
    const cookie = await setupAuth();
    addMind(TEST_MIND, 4160);
    const { default: app } = await import("../packages/daemon/src/web/app.js");

    // 'system' has no driver
    const res = await app.request(`http://localhost/api/minds/${TEST_MIND}/channels/create`, {
      method: "POST",
      headers: postHeaders(cookie),
      body: JSON.stringify({ platform: "system", participants: ["user1"] }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.ok(body.error.includes("does not support"));
  });

  // --- removed endpoints return 404 ---

  it("POST /:name/channels/send — removed (404)", async () => {
    const cookie = await setupAuth();
    addMind(TEST_MIND, 4160);
    const { default: app } = await import("../packages/daemon/src/web/app.js");

    const res = await app.request(`http://localhost/api/minds/${TEST_MIND}/channels/send`, {
      method: "POST",
      headers: postHeaders(cookie),
      body: JSON.stringify({ platform: "discord", uri: "test:chan", message: "hi" }),
    });
    assert.equal(res.status, 404);
  });

  it("GET /:name/channels/read — removed (404)", async () => {
    const cookie = await setupAuth();
    addMind(TEST_MIND, 4160);
    const { default: app } = await import("../packages/daemon/src/web/app.js");

    const res = await app.request(
      `/api/minds/${TEST_MIND}/channels/read?platform=discord&uri=test`,
      { headers: { Cookie: `volute_session=${cookie}` } },
    );
    assert.equal(res.status, 404);
  });

  it("GET /:name/channels/list — removed (404)", async () => {
    const cookie = await setupAuth();
    addMind(TEST_MIND, 4160);
    const { default: app } = await import("../packages/daemon/src/web/app.js");

    const res = await app.request(`/api/minds/${TEST_MIND}/channels/list`, {
      headers: { Cookie: `volute_session=${cookie}` },
    });
    assert.equal(res.status, 404);
  });

  it("GET /:name/channels/users — removed (404)", async () => {
    const cookie = await setupAuth();
    addMind(TEST_MIND, 4160);
    const { default: app } = await import("../packages/daemon/src/web/app.js");

    const res = await app.request(`/api/minds/${TEST_MIND}/channels/users?platform=discord`, {
      headers: { Cookie: `volute_session=${cookie}` },
    });
    assert.equal(res.status, 404);
  });
});
