import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { getDb } from "../packages/daemon/src/lib/db.js";
import { addMind, mindDir, removeMind } from "../packages/daemon/src/lib/mind/registry.js";
import { readVoluteConfig } from "../packages/daemon/src/lib/mind/volute-config.js";
import { sessions, users } from "../packages/daemon/src/lib/schema.js";
import filesApp from "../packages/daemon/src/web/api/files.js";
import mindsApp from "../packages/daemon/src/web/api/minds.js";
import { type AuthEnv, authMiddleware } from "../packages/daemon/src/web/middleware/auth.js";

const testMindName = `avatar-route-test-${Date.now()}`;
let adminCookie: string;

// 1x1 transparent PNG
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

function createApp() {
  const app = new Hono<AuthEnv>();
  app.use("/*", authMiddleware);
  app.route("/minds", mindsApp);
  app.route("/minds", filesApp);
  return app;
}

async function patchProfile(app: Hono<AuthEnv>, body: Record<string, string>) {
  return app.request(`/minds/${testMindName}/profile`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Cookie: adminCookie },
    body: JSON.stringify(body),
  });
}

describe("mind profile avatar", () => {
  before(async () => {
    const db = await getDb();
    await db.delete(users).where(eq(users.username, "avatar-route-admin"));
    const [user] = await db
      .insert(users)
      .values({ username: "avatar-route-admin", password_hash: "x", role: "admin" })
      .returning();
    const sessionId = crypto.randomUUID();
    await db.insert(sessions).values({ id: sessionId, userId: user.id, createdAt: Date.now() });
    adminCookie = `volute_session=${sessionId}`;

    await addMind(testMindName, 4198);
    const home = join(mindDir(testMindName), "home");
    mkdirSync(join(home, ".config"), { recursive: true });
    mkdirSync(join(home, "images"), { recursive: true });
    writeFileSync(join(home, ".config", "volute.json"), "{}");
    writeFileSync(join(home, "images", "sub-avatar.png"), PNG_BYTES);
    writeFileSync(join(home, "top-avatar.png"), PNG_BYTES);
  });

  after(async () => {
    const db = await getDb();
    await db.delete(users).where(eq(users.username, "avatar-route-admin"));
    await db.delete(users).where(eq(users.username, testMindName));
    await removeMind(testMindName);
    const dir = mindDir(testMindName);
    if (existsSync(dir)) rmSync(dir, { recursive: true });
  });

  it("accepts a home-relative subdirectory path and serves the avatar", async () => {
    const app = createApp();
    const res = await patchProfile(app, { avatar: "images/sub-avatar.png" });
    assert.equal(res.status, 200);

    const config = readVoluteConfig(mindDir(testMindName));
    assert.equal(config?.profile?.avatar, "images/sub-avatar.png");

    const serve = await app.request(`/minds/${testMindName}/avatar`, {
      headers: { Cookie: adminCookie },
    });
    assert.equal(serve.status, 200);
    assert.equal(serve.headers.get("Content-Type"), "image/png");
  });

  it("accepts a bare filename at the top of home", async () => {
    const app = createApp();
    const res = await patchProfile(app, { avatar: "top-avatar.png" });
    assert.equal(res.status, 200);
    const config = readVoluteConfig(mindDir(testMindName));
    assert.equal(config?.profile?.avatar, "top-avatar.png");
  });

  it("accepts an absolute path inside home and stores it relative", async () => {
    const app = createApp();
    const abs = join(mindDir(testMindName), "home", "images", "sub-avatar.png");
    const res = await patchProfile(app, { avatar: abs });
    assert.equal(res.status, 200);
    const config = readVoluteConfig(mindDir(testMindName));
    assert.equal(config?.profile?.avatar, "images/sub-avatar.png");
  });

  it("rejects a path that escapes home", async () => {
    const app = createApp();
    const res = await patchProfile(app, { avatar: "../../../etc/passwd" });
    assert.equal(res.status, 400);
    const config = readVoluteConfig(mindDir(testMindName));
    assert.notEqual(config?.profile?.avatar, "../../../etc/passwd");
  });

  it("rejects a nonexistent file", async () => {
    const app = createApp();
    const res = await patchProfile(app, { avatar: "images/missing.png" });
    assert.equal(res.status, 400);
  });
});
