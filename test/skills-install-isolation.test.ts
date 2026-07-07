import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { getDb } from "../packages/daemon/src/lib/db.js";
import { addMind, mindDir, voluteHome } from "../packages/daemon/src/lib/mind/registry.js";
import { sessions, sharedSkills, users } from "../packages/daemon/src/lib/schema.js";
import { importSkillFromDir } from "../packages/daemon/src/lib/skills.js";
import mindSkillsApp from "../packages/daemon/src/web/api/mind-skills.js";
import { type AuthEnv, authMiddleware } from "../packages/daemon/src/web/middleware/auth.js";
import { createMindGitRepo } from "./helpers/git.js";

// This file lives on its own so flipping VOLUTE_ISOLATION only affects its own
// test process (node runs each test file in a separate process). The mind user
// `mind-<name>` intentionally does not exist, so chownMindDir's real `chown`
// fails — that failure is exactly the observable proving the install/update/
// uninstall routes now hand ownership back to the mind under user isolation.

const testMindName = `skill-iso-test-${Date.now()}`;
let adminCookie: string;
let baseRepoDir: string;

const originalIsolation = process.env.VOLUTE_ISOLATION;

function createApp() {
  const app = new Hono<AuthEnv>();
  app.use("/*", authMiddleware);
  app.route("/minds", mindSkillsApp);
  return app;
}

function createSharedSkillDir(name: string): string {
  const dir = join(voluteHome(), "tmp-iso-skill-src", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: Test skill\n---\n\n# ${name}\n`,
  );
  return dir;
}

describe("mind skills install chowns to the mind under user isolation", () => {
  before(async () => {
    process.env.VOLUTE_ISOLATION = "user";
    baseRepoDir = `${mindDir(testMindName)}-base`;
    await createMindGitRepo(baseRepoDir);

    const db = await getDb();
    const [user] = await db
      .insert(users)
      .values({ username: "skill-iso-admin", password_hash: "x", role: "admin" })
      .returning();
    const sessionId = crypto.randomUUID();
    await db.insert(sessions).values({ id: sessionId, userId: user.id, createdAt: Date.now() });
    adminCookie = `volute_session=${sessionId}`;
  });

  after(async () => {
    if (originalIsolation === undefined) delete process.env.VOLUTE_ISOLATION;
    else process.env.VOLUTE_ISOLATION = originalIsolation;
    if (existsSync(baseRepoDir)) rmSync(baseRepoDir, { recursive: true });
    const db = await getDb();
    await db.delete(users).where(eq(users.username, "skill-iso-admin"));
  });

  beforeEach(async () => {
    const dir = mindDir(testMindName);
    if (existsSync(dir)) rmSync(dir, { recursive: true });
    cpSync(baseRepoDir, dir, { recursive: true });
    await addMind(testMindName, 4198);
  });

  afterEach(async () => {
    const db = await getDb();
    await db.delete(sharedSkills);
    const dir = mindDir(testMindName);
    if (existsSync(dir)) rmSync(dir, { recursive: true });
    const skillsDir = join(voluteHome(), "skills");
    if (existsSync(skillsDir)) rmSync(skillsDir, { recursive: true });
    const tmpDir = join(voluteHome(), "tmp-iso-skill-src");
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
  });

  it("install triggers chownMindDir (fails against the absent mind user)", async () => {
    const source = createSharedSkillDir("iso-installable");
    await importSkillFromDir(source, "author");

    const app = createApp();
    const res = await app.request(`/minds/${testMindName}/skills/install`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: adminCookie },
      body: JSON.stringify({ skillId: "iso-installable" }),
    });

    // The files were copied, but chownMindDir ran and failed because the
    // `mind-<name>` OS user does not exist in the test environment. Without the
    // ownership fix this request would succeed (200) with root-owned files.
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /chown/i);
  });
});
