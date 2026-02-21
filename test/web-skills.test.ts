import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import AdmZip from "adm-zip";
import { Hono } from "hono";
import { getDb } from "../src/lib/db.js";
import { exec } from "../src/lib/exec.js";
import { addMind, mindDir, voluteHome } from "../src/lib/registry.js";
import { sessions, sharedSkills, users } from "../src/lib/schema.js";
import { importSkillFromDir } from "../src/lib/skills.js";
import mindSkillsApp from "../src/web/api/mind-skills.js";
import skillsApp from "../src/web/api/skills.js";
import { type AuthEnv, authMiddleware } from "../src/web/middleware/auth.js";

const testMindName = `skill-web-test-${Date.now()}`;
let adminCookie: string;

function createApp() {
  const app = new Hono<AuthEnv>();
  app.use("/*", authMiddleware);
  app.route("/skills", skillsApp);
  app.route("/minds", mindSkillsApp);
  return app;
}

async function setup() {
  const db = await getDb();
  await db.delete(sharedSkills);
  await db.delete(sessions);
  await db.delete(users);

  // Create admin user and session
  const [user] = await db
    .insert(users)
    .values({ username: "admin", password_hash: "x", role: "admin" })
    .returning();
  const sessionId = crypto.randomUUID();
  await db.insert(sessions).values({ id: sessionId, userId: user.id, createdAt: Date.now() });
  adminCookie = `volute_session=${sessionId}`;

  // Create a test mind with git repo
  const dir = mindDir(testMindName);
  const skillsDir = join(dir, "home", ".claude", "skills");
  mkdirSync(skillsDir, { recursive: true });
  writeFileSync(join(dir, "home", ".gitkeep"), "");
  await exec("git", ["init"], { cwd: dir });
  await exec("git", ["config", "user.email", "test@test.com"], { cwd: dir });
  await exec("git", ["config", "user.name", "Test"], { cwd: dir });
  await exec("git", ["add", "-A"], { cwd: dir });
  await exec("git", ["commit", "-m", "init"], { cwd: dir });
  addMind(testMindName, 4199);
}

async function cleanup() {
  const db = await getDb();
  await db.delete(sharedSkills);
  await db.delete(sessions);
  await db.delete(users);
  // Clean up filesystem
  const dir = mindDir(testMindName);
  if (existsSync(dir)) rmSync(dir, { recursive: true });
  const skillsDir = join(voluteHome(), "skills");
  if (existsSync(skillsDir)) rmSync(skillsDir, { recursive: true });
  const tmpDir = join(voluteHome(), "tmp-skill-src");
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
}

function createSharedSkillDir(name: string): string {
  const dir = join(voluteHome(), "tmp-skill-src", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: Test skill\n---\n\n# ${name}\n`,
  );
  return dir;
}

describe("web skills API — shared skills", () => {
  beforeEach(setup);
  afterEach(cleanup);

  it("GET /skills returns empty list initially", async () => {
    const app = createApp();
    const res = await app.request("/skills", { headers: { Cookie: adminCookie } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, []);
  });

  it("GET /skills returns imported skills", async () => {
    const source = createSharedSkillDir("test-skill");
    await importSkillFromDir(source, "author");

    const app = createApp();
    const res = await app.request("/skills", { headers: { Cookie: adminCookie } });
    assert.equal(res.status, 200);
    const body = (await res.json()) as Array<{ id: string }>;
    assert.equal(body.length, 1);
    assert.equal(body[0].id, "test-skill");
  });

  it("GET /skills/:id returns skill with files", async () => {
    const source = createSharedSkillDir("test-skill");
    await importSkillFromDir(source, "author");

    const app = createApp();
    const res = await app.request("/skills/test-skill", { headers: { Cookie: adminCookie } });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { id: string; files: string[] };
    assert.equal(body.id, "test-skill");
    assert.ok(body.files.includes("SKILL.md"));
  });

  it("GET /skills/:id returns 404 for missing", async () => {
    const app = createApp();
    const res = await app.request("/skills/nonexistent", { headers: { Cookie: adminCookie } });
    assert.equal(res.status, 404);
  });

  it("DELETE /skills/:id removes a skill", async () => {
    const source = createSharedSkillDir("test-skill");
    await importSkillFromDir(source, "author");

    const app = createApp();
    const res = await app.request("/skills/test-skill", {
      method: "DELETE",
      headers: { Cookie: adminCookie },
    });
    assert.equal(res.status, 200);

    // Verify gone
    const getRes = await app.request("/skills/test-skill", { headers: { Cookie: adminCookie } });
    assert.equal(getRes.status, 404);
  });

  it("POST /skills/upload handles zip upload", async () => {
    // Create a zip with a skill directory
    const zip = new AdmZip();
    zip.addFile(
      "my-skill/SKILL.md",
      Buffer.from("---\nname: Uploaded Skill\ndescription: From zip\n---\n\n# Content\n"),
    );
    const zipBuffer = zip.toBuffer();

    const formData = new FormData();
    formData.append(
      "file",
      new File([new Uint8Array(zipBuffer)], "skill.zip", { type: "application/zip" }),
    );

    const app = createApp();
    const res = await app.request("/skills/upload", {
      method: "POST",
      headers: { Cookie: adminCookie },
      body: formData,
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { id: string; name: string };
    assert.equal(body.id, "my-skill");
    assert.equal(body.name, "Uploaded Skill");
  });

  it("POST /skills/upload rejects zip without SKILL.md", async () => {
    const zip = new AdmZip();
    zip.addFile("README.md", Buffer.from("No skill here"));
    const zipBuffer = zip.toBuffer();

    const formData = new FormData();
    formData.append(
      "file",
      new File([new Uint8Array(zipBuffer)], "bad.zip", { type: "application/zip" }),
    );

    const app = createApp();
    const res = await app.request("/skills/upload", {
      method: "POST",
      headers: { Cookie: adminCookie },
      body: formData,
    });
    assert.equal(res.status, 400);
  });

  it("unauthenticated requests return 401", async () => {
    const app = createApp();
    const res = await app.request("/skills");
    assert.equal(res.status, 401);
  });
});

describe("web skills API — mind skills", () => {
  beforeEach(setup);
  afterEach(cleanup);

  it("GET /minds/:name/skills returns installed skills", async () => {
    const app = createApp();
    const res = await app.request(`/minds/${testMindName}/skills`, {
      headers: { Cookie: adminCookie },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body));
  });

  it("GET /minds/:name/skills returns 404 for unknown mind", async () => {
    const app = createApp();
    const res = await app.request("/minds/nonexistent/skills", {
      headers: { Cookie: adminCookie },
    });
    assert.equal(res.status, 404);
  });

  it("POST /minds/:name/skills/install installs a skill", async () => {
    const source = createSharedSkillDir("installable");
    await importSkillFromDir(source, "author");

    const app = createApp();
    const res = await app.request(`/minds/${testMindName}/skills/install`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: adminCookie },
      body: JSON.stringify({ skillId: "installable" }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean };
    assert.equal(body.ok, true);

    // Verify installed
    const skillMd = join(
      mindDir(testMindName),
      "home",
      ".claude",
      "skills",
      "installable",
      "SKILL.md",
    );
    assert.ok(existsSync(skillMd));
  });

  it("POST /minds/:name/skills/publish publishes a skill", async () => {
    // Create a skill in the mind
    const skillDir = join(mindDir(testMindName), "home", ".claude", "skills", "custom");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      "---\nname: Custom\ndescription: A custom skill\n---\n\nContent\n",
    );

    const app = createApp();
    const res = await app.request(`/minds/${testMindName}/skills/publish`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: adminCookie },
      body: JSON.stringify({ skillId: "custom" }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { id: string };
    assert.equal(body.id, "custom");
  });

  it("DELETE /minds/:name/skills/:skill uninstalls a skill", async () => {
    const source = createSharedSkillDir("removable");
    await importSkillFromDir(source, "author");

    const app = createApp();

    // Install first
    await app.request(`/minds/${testMindName}/skills/install`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: adminCookie },
      body: JSON.stringify({ skillId: "removable" }),
    });

    // Then uninstall
    const res = await app.request(`/minds/${testMindName}/skills/removable`, {
      method: "DELETE",
      headers: { Cookie: adminCookie },
    });
    assert.equal(res.status, 200);

    const skillDir = join(mindDir(testMindName), "home", ".claude", "skills", "removable");
    assert.ok(!existsSync(skillDir));
  });

  it("non-admin POST returns 403", async () => {
    const db = await getDb();
    const [viewer] = await db
      .insert(users)
      .values({ username: "viewer", password_hash: "x", role: "viewer" })
      .returning();
    const viewerSessionId = crypto.randomUUID();
    await db
      .insert(sessions)
      .values({ id: viewerSessionId, userId: viewer.id, createdAt: Date.now() });

    const app = createApp();
    const res = await app.request(`/minds/${testMindName}/skills/install`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `volute_session=${viewerSessionId}`,
      },
      body: JSON.stringify({ skillId: "test" }),
    });
    assert.equal(res.status, 403);
  });
});
