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
  mindDir,
  removeMind,
} from "../packages/daemon/src/lib/mind/registry.js";
import { sessions, users } from "../packages/daemon/src/lib/schema.js";
import { exec } from "../packages/daemon/src/lib/util/exec.js";
import variantsApp from "../packages/daemon/src/web/api/variants.js";
import { type AuthEnv, authMiddleware } from "../packages/daemon/src/web/middleware/auth.js";
import { cleanGitEnv } from "./helpers/test-git-env.js";

// Runs in its own file so flipping VOLUTE_ISOLATION only affects this process
// (node runs each test file in a separate process). The `mind-<name>` OS user
// intentionally does not exist, so chownMindDir's real `chown` fails — that
// failure is the observable proving the failed-merge recovery path now hands
// ownership of the parent worktree back to the mind under user isolation
// (without it, the git ops leave the parent's files root-owned).

const parentName = `vjoin-iso-${Date.now()}`;
const variantName = `${parentName}-var`;
const branch = variantName;

let adminCookie: string;
let parentDir: string;
let variantDir: string;

const originalIsolation = process.env.VOLUTE_ISOLATION;

function createApp() {
  const app = new Hono<AuthEnv>();
  app.use("/*", authMiddleware);
  app.route("/minds", variantsApp);
  return app;
}

describe("failed variant join restores parent ownership under user isolation", () => {
  before(async () => {
    process.env.VOLUTE_ISOLATION = "user";
    const env = cleanGitEnv();

    parentDir = mindDir(parentName);
    variantDir = resolve(parentDir, ".variants", variantName);
    if (existsSync(parentDir)) rmSync(parentDir, { recursive: true, force: true });
    mkdirSync(parentDir, { recursive: true });

    // Parent repo with a tracked file that both sides will edit conflictingly.
    await exec("git", ["init"], { cwd: parentDir, env });
    await exec("git", ["config", "user.email", "test@test.com"], { cwd: parentDir, env });
    await exec("git", ["config", "user.name", "Test"], { cwd: parentDir, env });
    writeFileSync(resolve(parentDir, "MEMORY.md"), "base\n");
    await exec("git", ["add", "-A"], { cwd: parentDir, env });
    await exec("git", ["commit", "-m", "init"], { cwd: parentDir, env });

    // Variant worktree on its own branch, with a conflicting edit.
    await exec("git", ["worktree", "add", "-b", branch, variantDir], { cwd: parentDir, env });
    writeFileSync(resolve(variantDir, "MEMORY.md"), "variant version\n");
    await exec("git", ["commit", "-am", "variant edit"], { cwd: variantDir, env });

    // Parent (main) makes a conflicting edit to the same file.
    writeFileSync(resolve(parentDir, "MEMORY.md"), "parent version\n");
    await exec("git", ["commit", "-am", "parent edit"], { cwd: parentDir, env });

    await addMind(parentName, 4196);
    await addVariant(variantName, parentName, 4197, variantDir, branch);

    const db = await getDb();
    const [user] = await db
      .insert(users)
      .values({ username: "vjoin-iso-admin", password_hash: "x", role: "admin" })
      .returning();
    const sessionId = crypto.randomUUID();
    await db.insert(sessions).values({ id: sessionId, userId: user.id, createdAt: Date.now() });
    adminCookie = `volute_session=${sessionId}`;
  });

  after(async () => {
    if (originalIsolation === undefined) delete process.env.VOLUTE_ISOLATION;
    else process.env.VOLUTE_ISOLATION = originalIsolation;
    if (existsSync(variantDir)) rmSync(variantDir, { recursive: true, force: true });
    if (existsSync(parentDir)) rmSync(parentDir, { recursive: true, force: true });
    await removeMind(variantName);
    await removeMind(parentName);
    const db = await getDb();
    await db.delete(users).where(eq(users.username, "vjoin-iso-admin"));
  });

  it("aborts the conflicting merge and triggers chownMindDir (fails against the absent mind user)", async () => {
    const app = createApp();
    const res = await app.request(`/minds/${parentName}/variants/${variantName}/merge`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: adminCookie },
      body: JSON.stringify({ skipVerify: true }),
    });

    // The merge conflicts and is aborted, then chownMindDir runs to hand the
    // parent worktree back to the mind user. That chown fails because the
    // `mind-<name>` OS user does not exist here — proving ownership restore is
    // wired into the failed-join path. Its conflict list still surfaces.
    assert.equal(res.status, 500);
    const body = (await res.json()) as { error: string; conflicts?: string[] };
    assert.match(body.error, /chown/i);
    assert.ok(
      body.conflicts?.includes("MEMORY.md"),
      `expected MEMORY.md in conflicts: ${JSON.stringify(body.conflicts)}`,
    );
  });
});
