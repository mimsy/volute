import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { createUser } from "../packages/daemon/src/lib/auth.js";
import { getBackupManager } from "../packages/daemon/src/lib/daemon/backup-manager.js";
import { getBridgeManager } from "../packages/daemon/src/lib/daemon/bridge-manager.js";
import { getMailPoller } from "../packages/daemon/src/lib/daemon/mail-poller.js";
import { ManagerNotReadyError } from "../packages/daemon/src/lib/daemon/manager-not-ready.js";
import { getMindManager } from "../packages/daemon/src/lib/daemon/mind-manager.js";
import { getScheduler } from "../packages/daemon/src/lib/daemon/scheduler.js";
import { getSleepManager } from "../packages/daemon/src/lib/daemon/sleep-manager.js";
import { getSpendBudget } from "../packages/daemon/src/lib/daemon/spend-budget.js";
import { getDb } from "../packages/daemon/src/lib/db.js";
import { getDeliveryManager } from "../packages/daemon/src/lib/delivery/delivery-manager.js";
import { addMind, mindDir } from "../packages/daemon/src/lib/mind/registry.js";
import { minds, users } from "../packages/daemon/src/lib/schema.js";
import log from "../packages/daemon/src/lib/util/logger.js";
import { createSession } from "../packages/daemon/src/web/middleware/auth.js";

// The HTTP server binds before any manager is initialised (#1050), so every route that
// reaches a manager getter is reachable in that window. #1052 made the MindManager's
// getter answer 503 "starting"; #1067 extends that to every manager by giving them one
// shared error class, which the app-wide onError converts.
//
// This file must NOT initialise any manager — node:test runs each file in its own
// process, so the uninitialised window is reproducible here.

const ADMIN = "managers-not-ready-admin";
const MIND = "managers-not-ready-mind";

let cookie: string;

async function cleanup() {
  const db = await getDb();
  await db.delete(users).where(eq(users.username, ADMIN));
  await db.delete(minds).where(eq(minds.name, MIND));
}

/** Run a request with the logger captured, so tests can assert on what it logged. */
async function request(path: string, init: RequestInit = {}) {
  const { default: app } = await import("../packages/daemon/src/web/app.js");
  const lines: string[] = [];
  log.setOutput((line) => lines.push(line));
  try {
    const res = await app.request(`http://localhost${path}`, {
      ...init,
      headers: {
        Cookie: `volute_session=${cookie}`,
        Origin: "http://localhost",
        ...(init.headers as Record<string, string> | undefined),
      },
    });
    return { res, lines };
  } finally {
    log.setOutput((line) => process.stderr.write(`${line}\n`));
  }
}

function assertStarting(res: Response, lines: string[], body: unknown) {
  assert.equal(res.status, 503, `unexpected response: ${JSON.stringify(body)}`);
  assert.deepEqual(body, { error: "starting" });
  assert.equal(res.headers.get("Retry-After"), "1");
  assert.ok(
    !lines.some((l) => l.includes("unhandled error")),
    `startup-window request logged an unhandled error: ${lines.join("\n")}`,
  );
}

describe("manager getters before init (#1067)", () => {
  const getters = {
    getMindManager,
    getDeliveryManager,
    getScheduler,
    getSleepManager,
    getSpendBudget,
    getBridgeManager,
    getBackupManager,
    getMailPoller,
  };

  for (const [name, getter] of Object.entries(getters)) {
    it(`${name} throws ManagerNotReadyError`, () => {
      assert.throws(() => getter(), ManagerNotReadyError);
    });
  }
});

describe("manager-backed routes before init (#1067)", () => {
  before(async () => {
    await cleanup();
    const admin = await createUser(ADMIN, "pass");
    cookie = await createSession(admin.id);
    await addMind(MIND, 4996);
    mkdirSync(mindDir(MIND), { recursive: true });
  });

  after(async () => {
    await cleanup();
    rmSync(mindDir(MIND), { recursive: true, force: true });
  });

  it("SpendBudget: GET /minds/:name/budget answers 503 starting", async () => {
    const { res, lines } = await request(`/api/v1/minds/${MIND}/budget`);
    assertStarting(res, lines, await res.json());
  });

  it("BridgeManager: GET /bridges answers 503 starting", async () => {
    const { res, lines } = await request("/api/v1/bridges");
    assertStarting(res, lines, await res.json());
  });

  it("DeliveryManager: gates/peek still answers its own 503", async () => {
    const { res } = await request(`/api/v1/minds/${MIND}/gates/peek?channel=general`);
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { error: "Delivery manager not available" });
  });
});

// #1098: a restart with a JSON content-type and no body is a restart with no context.
// The route stops at getMindManager() here (503), after the body has been handled.
describe("restart body parsing (#1098)", () => {
  before(async () => {
    await cleanup();
    const admin = await createUser(ADMIN, "pass");
    cookie = await createSession(admin.id);
    await addMind(MIND, 4996);
    mkdirSync(mindDir(MIND), { recursive: true });
  });

  after(async () => {
    await cleanup();
    rmSync(mindDir(MIND), { recursive: true, force: true });
  });

  function parseLines(lines: string[]) {
    return lines
      .map((l) => JSON.parse(l) as { level: string; msg: string })
      .filter((l) => l.msg.includes("failed to parse restart context"));
  }

  it("logs nothing for an empty body with a JSON content-type", async () => {
    const { res, lines } = await request(`/api/v1/minds/${MIND}/restart`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    assertStarting(res, lines, await res.json());
    assert.deepEqual(parseLines(lines), []);
  });

  it("warns (not errors) on a malformed body", async () => {
    const { res, lines } = await request(`/api/v1/minds/${MIND}/restart`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    assertStarting(res, lines, await res.json());
    const parsed = parseLines(lines);
    assert.equal(parsed.length, 1, lines.join("\n"));
    assert.equal(parsed[0].level, "warn");
  });
});
