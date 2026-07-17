import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { getDb } from "../packages/daemon/src/lib/db.js";
import {
  addMind,
  addVariant,
  findMind,
  mindDir,
  removeMind,
} from "../packages/daemon/src/lib/mind/registry.js";
import { sessions, users } from "../packages/daemon/src/lib/schema.js";
import { exec, gitExec } from "../packages/daemon/src/lib/util/exec.js";
import mindsApp from "../packages/daemon/src/web/api/minds.js";
import { type AuthEnv, authMiddleware } from "../packages/daemon/src/web/middleware/auth.js";
import { cleanGitEnv } from "./helpers/test-git-env.js";

// Regression test for #650: `DELETE /api/minds/:name` on a variant name used to
// stop the process and drop the DB row without ever calling cleanupVariant,
// stranding the git worktree and branch. This exercises the real route (not
// just cleanupVariant directly) so it catches a regression in the routing
// decision itself, not just the cleanup helper.

const parentName = `vdel-${Date.now()}`;
const variantName = `${parentName}-var`;
const branch = variantName;

let adminCookie: string;
let parentDir: string;
let variantDir: string;
let gitEnv: NodeJS.ProcessEnv;

function createApp() {
  const app = new Hono<AuthEnv>();
  app.use("/*", authMiddleware);
  app.route("/minds", mindsApp);
  return app;
}

describe("DELETE /:name on a variant (#650)", () => {
  before(async () => {
    const { initMindManager, tryGetMindManager } = await import(
      "../packages/daemon/src/lib/daemon/mind-manager.js"
    );
    if (!tryGetMindManager()) initMindManager();

    const env = cleanGitEnv();
    gitEnv = env;

    parentDir = mindDir(parentName);
    variantDir = resolve(parentDir, ".variants", variantName);
    if (existsSync(parentDir)) rmSync(parentDir, { recursive: true, force: true });
    mkdirSync(parentDir, { recursive: true });

    await exec("git", ["init"], { cwd: parentDir, env });
    await exec("git", ["config", "user.email", "test@test.com"], { cwd: parentDir, env });
    await exec("git", ["config", "user.name", "Test"], { cwd: parentDir, env });
    writeFileSync(resolve(parentDir, "MEMORY.md"), "base\n");
    await exec("git", ["add", "-A"], { cwd: parentDir, env });
    await exec("git", ["commit", "-m", "init"], { cwd: parentDir, env });

    await exec("git", ["worktree", "add", "-b", branch, variantDir], { cwd: parentDir, env });

    await addMind(parentName, 4390);
    await addVariant(variantName, parentName, 4391, variantDir, branch);

    const db = await getDb();
    const [user] = await db
      .insert(users)
      .values({ username: "vdel-admin", password_hash: "x", role: "admin" })
      .returning();
    const sessionId = crypto.randomUUID();
    await db.insert(sessions).values({ id: sessionId, userId: user.id, createdAt: Date.now() });
    adminCookie = `volute_session=${sessionId}`;
  });

  after(async () => {
    if (existsSync(variantDir)) rmSync(variantDir, { recursive: true, force: true });
    if (existsSync(parentDir)) rmSync(parentDir, { recursive: true, force: true });
    await removeMind(variantName).catch(() => {});
    await removeMind(parentName).catch(() => {});
    const db = await getDb();
    await db.delete(users).where(eq(users.username, "vdel-admin"));
  });

  it("cleans up the variant's worktree, branch, and DB row instead of stranding them", async () => {
    const app = createApp();
    const res = await app.request(`/minds/${variantName}`, {
      method: "DELETE",
      headers: { Cookie: adminCookie },
    });

    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok?: boolean; variant?: boolean };
    assert.equal(body.ok, true);
    assert.equal(body.variant, true, "response flags the deletion as a variant");

    assert.equal(await findMind(variantName), undefined, "variant row removed from registry");
    assert.ok(!existsSync(variantDir), "variant worktree removed from disk");

    const branches = await gitExec(["branch", "--list", branch], { cwd: parentDir, env: gitEnv });
    assert.equal(branches.trim(), "", "variant branch deleted");

    // The parent mind itself is untouched.
    assert.ok(await findMind(parentName), "parent mind still registered");
    assert.ok(existsSync(parentDir), "parent directory untouched");
  });
});
