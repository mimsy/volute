import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { createUser } from "../packages/daemon/src/lib/auth.js";
import { readGlobalConfig, writeGlobalConfig } from "../packages/daemon/src/lib/config/setup.js";
import { getDb } from "../packages/daemon/src/lib/db.js";
import { users } from "../packages/daemon/src/lib/schema.js";
import setup from "../packages/daemon/src/web/api/setup.js";

// Guards the fields `volute login` relies on to detect the login-before-wizard
// case (packages/cli/src/commands/login.ts): when setup is incomplete and no
// brain account exists, /api/v1/setup/status must report complete:false + hasAccount:false.

const TEST_USERNAME = "setupstatususer";

function createApp() {
  const app = new Hono();
  app.route("/api/v1/setup", setup);
  return app;
}

async function cleanup() {
  const db = await getDb();
  await db.delete(users).where(eq(users.username, TEST_USERNAME));
  const config = readGlobalConfig();
  delete config.name;
  delete config.setup;
  delete config.setupCompleted;
  writeGlobalConfig(config);
}

describe("GET /api/v1/setup/status", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("reports no account when setup is incomplete and no brain exists", async () => {
    const config = readGlobalConfig();
    config.name = "test-system";
    config.setup = { type: "local", mindsDir: "/tmp/minds", isolation: "none", service: false };
    config.setupCompleted = false;
    writeGlobalConfig(config);

    const res = await createApp().request("/api/v1/setup/status");
    assert.equal(res.status, 200);
    const body = (await res.json()) as { complete: boolean; hasAccount: boolean };
    assert.equal(body.complete, false);
    assert.equal(body.hasAccount, false);
  });

  it("reports an account once a brain user exists", async () => {
    const config = readGlobalConfig();
    config.name = "test-system";
    config.setup = { type: "local", mindsDir: "/tmp/minds", isolation: "none", service: false };
    config.setupCompleted = false;
    writeGlobalConfig(config);

    await createUser(TEST_USERNAME, "pass123");

    const res = await createApp().request("/api/v1/setup/status");
    assert.equal(res.status, 200);
    const body = (await res.json()) as { complete: boolean; hasAccount: boolean };
    assert.equal(body.complete, false);
    assert.equal(body.hasAccount, true);
  });
});
