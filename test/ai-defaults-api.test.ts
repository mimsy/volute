import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { createUser } from "../packages/daemon/src/lib/auth.js";
import { getDb } from "../packages/daemon/src/lib/db.js";
import { users } from "../packages/daemon/src/lib/schema.js";
import { createSession, deleteSession } from "../packages/daemon/src/web/middleware/auth.js";

const USERNAME = "ai-defaults-admin";

let cookie: string;

async function cleanup() {
  const db = await getDb();
  await db.delete(users).where(eq(users.username, USERNAME));
}

describe("/api/v1/system/ai/defaults", () => {
  before(async () => {
    await cleanup();
    const user = await createUser(USERNAME, "pass");
    cookie = await createSession(user.id);
  });

  after(async () => {
    if (cookie) await deleteSession(cookie);
    await cleanup();
  });

  it("carries only the spirit model", async () => {
    const { default: app } = await import("../packages/daemon/src/web/app.js");
    const headers = {
      Cookie: `volute_session=${cookie}`,
      Origin: "http://localhost",
      "Content-Type": "application/json",
    };
    const put = await app.request("/api/v1/system/ai/defaults", {
      method: "PUT",
      headers,
      body: JSON.stringify({ spiritModel: "anthropic:claude-haiku-4-5" }),
    });
    assert.equal(put.status, 200);
    const got = await app.request("/api/v1/system/ai/defaults", { headers });
    assert.deepEqual(await got.json(), { spiritModel: "anthropic:claude-haiku-4-5" });
  });
});
