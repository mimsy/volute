import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { createUser } from "../packages/daemon/src/lib/auth.js";
import {
  initMindManager,
  tryGetMindManager,
} from "../packages/daemon/src/lib/daemon/mind-manager.js";
import { getDb } from "../packages/daemon/src/lib/db.js";
import { addMind, mindDir } from "../packages/daemon/src/lib/mind/registry.js";
import { minds, users } from "../packages/daemon/src/lib/schema.js";
import { createSession } from "../packages/daemon/src/web/middleware/auth.js";

// The HTTP server binds before initMindManager() runs (#1050), so mind routes are
// reachable while the manager is still absent. They used to throw through as an
// "unhandled error" 500; they now answer 503 {"error":"starting"}.
//
// This file must NOT initialize the mind manager before the first test — node:test
// runs each file in its own process, so the uninitialized window is reproducible
// here and nowhere else.

const ADMIN = "not-ready-admin";
const MIND = "not-ready-mind";

let cookie: string;

async function cleanup() {
  const db = await getDb();
  await db.delete(users).where(eq(users.username, ADMIN));
  await db.delete(minds).where(eq(minds.name, MIND));
}

describe("mind routes before initMindManager (#1050)", () => {
  before(async () => {
    await cleanup();
    const admin = await createUser(ADMIN, "pass");
    cookie = await createSession(admin.id);
    await addMind(MIND, 4997);
    mkdirSync(mindDir(MIND), { recursive: true });
  });

  after(async () => {
    await cleanup();
    rmSync(mindDir(MIND), { recursive: true, force: true });
  });

  it("answers 503 starting, with no unhandled-error log", async () => {
    assert.equal(tryGetMindManager(), null, "manager must be uninitialized for this test");
    const { default: app } = await import("../packages/daemon/src/web/app.js");
    const { default: log } = await import("../packages/daemon/src/lib/util/logger.js");

    const lines: string[] = [];
    log.setOutput((line) => lines.push(line));
    let res: Response;
    try {
      res = await app.request(`http://localhost/api/v1/minds/${MIND}`, {
        headers: { Cookie: `volute_session=${cookie}` },
      });
    } finally {
      log.setOutput((line) => process.stderr.write(`${line}\n`));
    }

    assert.equal(res.status, 503, `unexpected status: ${await res.clone().text()}`);
    assert.deepEqual(await res.json(), { error: "starting" });
    assert.equal(res.headers.get("Retry-After"), "1");
    assert.ok(
      !lines.some((l) => l.includes("unhandled error")),
      `startup-window request logged an unhandled error: ${lines.join("\n")}`,
    );
  });

  it("serves the mind normally once the manager is initialized", async () => {
    initMindManager();
    const { default: app } = await import("../packages/daemon/src/web/app.js");

    const res = await app.request(`http://localhost/api/v1/minds/${MIND}`, {
      headers: { Cookie: `volute_session=${cookie}` },
    });

    assert.equal(res.status, 200, `unexpected status: ${await res.clone().text()}`);
    const body = (await res.json()) as { name?: string; status?: string };
    assert.equal(body.name, MIND);
    assert.equal(body.status, "stopped");
  });
});
