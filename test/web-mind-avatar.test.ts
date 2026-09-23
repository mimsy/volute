import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { getDb } from "../packages/daemon/src/lib/db.js";
import { addMind, mindDir, removeMind } from "../packages/daemon/src/lib/mind/registry.js";
import {
  readVoluteConfig,
  writeVoluteConfig,
} from "../packages/daemon/src/lib/mind/volute-config.js";
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

  // Containment permits target === base, so a *.png symlink to home/ itself stays
  // inside the tree and passes the path check. Without an isFile() guard the route
  // 500s on EISDIR; it must give the same 400 the old strict-prefix check gave.
  // Written straight to volute.json because a mind owns that file and can set a
  // value the PATCH validator would refuse.
  it("rejects an avatar that resolves to a directory rather than a file", async () => {
    const app = createApp();
    const home = join(mindDir(testMindName), "home");
    const link = join(home, "selfie.png");
    rmSync(link, { force: true });
    symlinkSync(home, link);

    const config = readVoluteConfig(mindDir(testMindName)) ?? {};
    config.profile = { ...(config.profile ?? {}), avatar: "selfie.png" };
    writeVoluteConfig(mindDir(testMindName), config);

    const serve = await app.request(`/minds/${testMindName}/avatar`, {
      headers: { Cookie: adminCookie },
    });
    assert.equal(serve.status, 400, await serve.clone().text());
    assert.equal((await serve.json()).error, "Invalid avatar path");
  });

  async function uploadAvatar(app: Hono<AuthEnv>) {
    const form = new FormData();
    form.append("file", new File([PNG_BYTES], "me.png", { type: "image/png" }));
    return app.request(`/minds/${testMindName}/avatar`, {
      method: "POST",
      headers: { Cookie: adminCookie },
      body: form,
    });
  }

  // The upload writes as the daemon (root under user isolation). A mind that plants
  // home/avatar.<ext> as a symlink must not get the daemon to write through it.
  it("replaces a planted avatar symlink instead of writing through it", async () => {
    const app = createApp();
    const home = join(mindDir(testMindName), "home");
    const outside = join(mindDir(testMindName), "outside-target");
    writeFileSync(outside, "untouched");
    for (const ext of [".png", ".webp"]) {
      rmSync(join(home, `avatar${ext}`), { force: true });
      symlinkSync(outside, join(home, `avatar${ext}`));
    }

    const res = await uploadAvatar(app);
    assert.equal(res.status, 200, await res.clone().text());
    const { avatar } = await res.json();
    assert.equal(readFileSync(outside, "utf-8"), "untouched");
    assert.ok(lstatSync(join(home, avatar)).isFile(), "avatar is a regular file, not the link");
  });

  it("refuses when home/ is a symlink leading out of the mind", async () => {
    const app = createApp();
    const dir = mindDir(testMindName);
    const elsewhere = mkdtempSync(join(tmpdir(), "avatar-elsewhere-"));
    renameSync(join(dir, "home"), join(dir, "home-real"));
    symlinkSync(elsewhere, join(dir, "home"));
    try {
      const res = await uploadAvatar(app);
      assert.equal(res.status, 404, await res.clone().text());
      assert.deepEqual(readdirSync(elsewhere), []);
    } finally {
      rmSync(join(dir, "home"));
      renameSync(join(dir, "home-real"), join(dir, "home"));
      rmSync(elsewhere, { recursive: true });
    }
  });
});
