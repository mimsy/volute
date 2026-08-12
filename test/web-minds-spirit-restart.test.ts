import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { createUser } from "../packages/daemon/src/lib/auth.js";
import { getDb } from "../packages/daemon/src/lib/db.js";
import { addSpirit, mindDir } from "../packages/daemon/src/lib/mind/registry.js";
import { minds, users } from "../packages/daemon/src/lib/schema.js";
import { createSession } from "../packages/daemon/src/web/middleware/auth.js";

// The spirit lives at ~/.volute/system/spirit (stored in the minds table's `dir`
// column), not at mindDir("volute"). The start/restart routes used to gate on
// existsSync(mindDir(name)), so the spirit always 404'd "Mind directory missing"
// and (for restart) its identity reload never happened (#620). These tests pin the
// dir gate to the DB-recorded dir for both routes.
//
// The mind manager isn't initialized in this test context, so a request that
// clears the gate throws when it reaches getMindManager() and Hono turns that into
// a 500 — which is exactly what lets us assert "gate passed" without spawning a
// real mind process. We pin that 500 so a 500-from-elsewhere can't masquerade as a
// cleared gate.
const GATE_CLEARED_STATUS = 500;

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

describe("spirit start/restart directory gate (#620)", () => {
  let spiritDir: string;

  beforeEach(async () => {
    await cleanup();
    spiritDir = mkdtempSync(join(tmpdir(), "spirit-restart-"));
  });

  afterEach(async () => {
    await cleanup();
    rmSync(spiritDir, { recursive: true, force: true });
    // Remove the decoy mindDir created by the negative test, if any.
    rmSync(mindDir(SPIRIT_MISSING), { recursive: true, force: true });
  });

  for (const route of ["restart", "start"] as const) {
    it(`${route}: clears the gate when the spirit's recorded dir exists`, async () => {
      const admin = await createUser(ADMIN, "pass");
      const cookie = await createSession(admin.id);
      await addSpirit(SPIRIT_OK, 4999, "claude", spiritDir);
      const { default: app } = await import("../packages/daemon/src/web/app.js");

      const res = await app.request(`http://localhost/api/v1/minds/${SPIRIT_OK}/${route}`, {
        method: "POST",
        headers: postHeaders(cookie),
      });

      // Gate cleared: not the "Mind directory missing" 404. It then fails at
      // getMindManager() (uninitialized here) → 500, rather than spawning a process.
      assert.equal(
        res.status,
        GATE_CLEARED_STATUS,
        `unexpected status: ${await res.clone().text()}`,
      );
    });
  }

  it("restart: 404s on the DB-recorded dir, not mindDir(name)", async () => {
    const admin = await createUser(ADMIN, "pass");
    const cookie = await createSession(admin.id);
    // Make mindDir(name) EXIST but point the DB `dir` at a missing path. The old
    // code gated on mindDir(name) and would have passed here; the fix gates on the
    // recorded dir, so this must 404 — pinning that the gate reads the DB dir.
    mkdirSync(mindDir(SPIRIT_MISSING), { recursive: true });
    await addSpirit(SPIRIT_MISSING, 4998, "claude", join(spiritDir, "does-not-exist"));
    const { default: app } = await import("../packages/daemon/src/web/app.js");

    const res = await app.request(`http://localhost/api/v1/minds/${SPIRIT_MISSING}/restart`, {
      method: "POST",
      headers: postHeaders(cookie),
    });

    assert.equal(res.status, 404);
    const body = (await res.json()) as { error?: string };
    assert.match(body.error ?? "", /Mind directory missing/);
  });
});
