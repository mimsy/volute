import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import {
  type GlobalConfig,
  readGlobalConfig,
  writeGlobalConfig,
} from "../packages/daemon/src/lib/config/setup.js";
import { getDb } from "../packages/daemon/src/lib/db.js";
import { sessions, users } from "../packages/daemon/src/lib/schema.js";
import {
  composeTemplate,
  findTemplatesDir,
  findTemplatesRoot,
} from "../packages/daemon/src/lib/template/template.js";
import mindsApp from "../packages/daemon/src/web/api/minds.js";
import { type AuthEnv, authMiddleware } from "../packages/daemon/src/web/middleware/auth.js";

// The whole point of #330 part 4: these locators throw instead of process.exit(1),
// so a route handler catches → 500 rather than the throw killing the daemon (and
// every mind on it). If any of these still called process.exit, this test *file*
// would abort the whole run — surviving to make an assertion is itself the proof.
describe("template locators throw instead of exiting", () => {
  it("composeTemplate throws on an unknown template", () => {
    const root = findTemplatesRoot();
    assert.throws(() => composeTemplate(root, "no-such-template-xyz"), /Template not found/);
  });

  it("findTemplatesDir throws on an unknown template", () => {
    assert.throws(() => findTemplatesDir("no-such-template-xyz"), /Template not found/);
  });
});

describe("create route returns 500 (not a process exit) on a broken template", () => {
  const adminUser = "template-throws-admin";
  let adminCookie: string;
  let savedConfig: GlobalConfig;

  function createApp() {
    const app = new Hono<AuthEnv>();
    app.use("/*", authMiddleware);
    app.route("/minds", mindsApp);
    return app;
  }

  before(async () => {
    const db = await getDb();
    await db.delete(users).where(eq(users.username, adminUser));
    const [user] = await db
      .insert(users)
      .values({ username: adminUser, password_hash: "x", role: "admin" })
      .returning();
    const sessionId = crypto.randomUUID();
    await db.insert(sessions).values({ id: sessionId, userId: user.id, createdAt: Date.now() });
    adminCookie = `volute_session=${sessionId}`;

    // The create route refuses (409) when no AI provider is configured, before it
    // ever reaches composeTemplate — give it an enabled model so it gets that far.
    savedConfig = readGlobalConfig();
    writeGlobalConfig({ ...savedConfig, ai: { ...savedConfig.ai, models: ["anthropic/x"] } });
  });

  after(async () => {
    writeGlobalConfig(savedConfig);
    const db = await getDb();
    await db.delete(users).where(eq(users.username, adminUser));
  });

  it("maps a composeTemplate throw to HTTP 500", async () => {
    const app = createApp();
    const res = await app.request("/minds", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: adminCookie },
      body: JSON.stringify({ name: "template-throws-mind", template: "no-such-template-xyz" }),
    });
    assert.equal(res.status, 500);
  });
});
