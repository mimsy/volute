import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { createUser } from "../packages/daemon/src/lib/auth.js";
import { getDb } from "../packages/daemon/src/lib/db.js";
import { addSpirit } from "../packages/daemon/src/lib/mind/registry.js";
import { minds, users } from "../packages/daemon/src/lib/schema.js";
import { createSession } from "../packages/daemon/src/web/middleware/auth.js";

// The spirit lives at ~/.volute/system/spirit (stored in the minds table's `dir`
// column), not at mindDir("volute"). The restart route used to gate on
// existsSync(mindDir(name)), so the spirit always 404'd "Mind directory missing"
// and its identity reload never happened (#620). These tests pin the dir gate to
// the DB-recorded dir. The manager isn't initialized in this test context, so a
// restart that clears the gate fails later (non-404) instead of spawning a process.

const ADMIN = "spirit-restart-admin";
const SPIRIT_OK = "test-spirit-ok";
const SPIRIT_MISSING = "test-spirit-missing";

async function cleanup() {
  const db = await getDb();
  await db.delete(users).where(eq(users.username, ADMIN));
  await db.delete(minds).where(eq(minds.name, SPIRIT_OK));
  await db.delete(minds).where(eq(minds.name, SPIRIT_MISSING));
}

function postHeaders(cookie: string) {
  return { Cookie: `volute_session=${cookie}`, Origin: "http://localhost" };
}

describe("spirit restart directory gate (#620)", () => {
  let spiritDir: string;

  beforeEach(async () => {
    await cleanup();
    spiritDir = mkdtempSync(join(tmpdir(), "spirit-restart-"));
  });

  afterEach(async () => {
    await cleanup();
    rmSync(spiritDir, { recursive: true, force: true });
  });

  it("does not 404 when the spirit's recorded dir exists", async () => {
    const admin = await createUser(ADMIN, "pass");
    const cookie = await createSession(admin.id);
    await addSpirit(SPIRIT_OK, 4999, "claude", spiritDir);
    const { default: app } = await import("../packages/daemon/src/web/app.js");

    const res = await app.request(`http://localhost/api/minds/${SPIRIT_OK}/restart`, {
      method: "POST",
      headers: postHeaders(cookie),
    });

    // Gate cleared: it must not be the "Mind directory missing" 404. (It fails later
    // because the mind manager isn't initialized in this test context.)
    assert.notEqual(res.status, 404, `unexpected 404: ${await res.clone().text()}`);
  });

  it("404s when the spirit's recorded dir is missing", async () => {
    const admin = await createUser(ADMIN, "pass");
    const cookie = await createSession(admin.id);
    await addSpirit(SPIRIT_MISSING, 4998, "claude", join(spiritDir, "does-not-exist"));
    const { default: app } = await import("../packages/daemon/src/web/app.js");

    const res = await app.request(`http://localhost/api/minds/${SPIRIT_MISSING}/restart`, {
      method: "POST",
      headers: postHeaders(cookie),
    });

    assert.equal(res.status, 404);
    const body = (await res.json()) as { error?: string };
    assert.match(body.error ?? "", /Mind directory missing/);
  });
});
