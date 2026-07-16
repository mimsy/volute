import assert from "node:assert/strict";
import { afterEach, before, beforeEach, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { resolveApiToken } from "../packages/daemon/src/lib/api-tokens.js";
import { createUser, getUserByUsername, setUserRole } from "../packages/daemon/src/lib/auth.js";
import {
  type GlobalConfig,
  readGlobalConfig,
  writeGlobalConfig,
} from "../packages/daemon/src/lib/config/setup.js";
import { getDb } from "../packages/daemon/src/lib/db.js";
import { minds, users } from "../packages/daemon/src/lib/schema.js";
import { createSession, deleteSession } from "../packages/daemon/src/web/middleware/auth.js";

const ADMIN = "r2-reg-admin";
const SYSTEM_CALLER = "r2-reg-system";
const PLAIN = "r2-reg-plain";
const TAKEN = "r2-reg-taken";
const NEW_MIND = "r2-reg-external";
const NEW_MIND_2 = "r2-reg-external-two";
const NEW_MIND_3 = "r2-reg-external-three";

const TEST_USERNAMES = [ADMIN, SYSTEM_CALLER, PLAIN, TAKEN, NEW_MIND, NEW_MIND_2, NEW_MIND_3];

const sessions: string[] = [];
let savedConfig: GlobalConfig;

async function cleanup() {
  const db = await getDb();
  for (const username of TEST_USERNAMES) {
    // FK cascade drops any api_tokens rows with the user.
    await db.delete(users).where(eq(users.username, username));
  }
  for (const id of sessions.splice(0)) await deleteSession(id);
  writeGlobalConfig(savedConfig);
}

/** Set (or clear, when policy is undefined) the registration policy. */
function setPolicy(policy?: "closed" | "admin-only" | "open") {
  const config = readGlobalConfig();
  if (policy) config.externalRegistration = policy;
  else delete config.externalRegistration;
  writeGlobalConfig(config);
}

/**
 * `createUser` only auto-admins the FIRST human user in the DB, which isn't
 * reliable in a shared test DB — set the role explicitly.
 */
async function makeUser(username: string, role: "admin" | "user" | "system") {
  const user = await createUser(username, "pw-123456");
  await setUserRole(user.id, role);
  const sessionId = await createSession(user.id);
  sessions.push(sessionId);
  return { user, sessionId };
}

function postHeaders(cookie: string) {
  return {
    Cookie: `volute_session=${cookie}`,
    Origin: "http://localhost",
    "Content-Type": "application/json",
  };
}

async function register(cookie: string, body: Record<string, unknown>) {
  const { default: app } = await import("../packages/daemon/src/web/app.js");
  return app.request("http://localhost/api/auth/minds", {
    method: "POST",
    headers: postHeaders(cookie),
    body: JSON.stringify(body),
  });
}

describe("external mind registration", () => {
  before(() => {
    savedConfig = readGlobalConfig();
  });
  beforeEach(cleanup);
  afterEach(cleanup);

  it("admin under admin-only creates a mind USER with no registry row, token returned once", async () => {
    setPolicy("admin-only");
    const { sessionId } = await makeUser(ADMIN, "admin");

    const res = await register(sessionId, {
      name: NEW_MIND,
      displayName: "External One",
      description: "lives elsewhere",
      tokenLabel: "laptop",
    });
    assert.equal(res.status, 201, await res.clone().text());
    const body = (await res.json()) as {
      name: string;
      user: { id: number; username: string; user_type: string; role: string; display_name: string };
      token: string;
      tokenId: number;
    };

    // The account is a users row: mind-typed but NON-admin.
    assert.equal(body.name, NEW_MIND);
    assert.equal(body.user.username, NEW_MIND);
    assert.equal(body.user.user_type, "mind");
    assert.equal(body.user.role, "user");
    assert.equal(body.user.display_name, "External One");

    const row = await getUserByUsername(NEW_MIND);
    assert.equal(row?.user_type, "mind");
    assert.equal(row?.role, "user");
    assert.equal(row?.description, "lives elsewhere");

    // The defining property of an external mind: NO minds registry row — no port,
    // no process, never spawned.
    const db = await getDb();
    const mindRow = await db.select().from(minds).where(eq(minds.name, NEW_MIND)).get();
    assert.equal(mindRow, undefined, "external mind must not get a minds registry row");

    // The token is a working R1 credential, returned exactly once.
    assert.ok(body.token.startsWith("vmt_"));
    assert.equal(await resolveApiToken(body.token), body.user.id);
    assert.equal(typeof body.tokenId, "number");
  });

  it("a role:system caller may register under admin-only", async () => {
    setPolicy("admin-only");
    const { sessionId } = await makeUser(SYSTEM_CALLER, "system");
    const res = await register(sessionId, { name: NEW_MIND });
    assert.equal(res.status, 201, await res.clone().text());
  });

  it("a role:user caller is refused under admin-only, and creates nothing", async () => {
    setPolicy("admin-only");
    const { sessionId } = await makeUser(PLAIN, "user");
    const res = await register(sessionId, { name: NEW_MIND });
    assert.equal(res.status, 403);
    assert.equal(await getUserByUsername(NEW_MIND), null);
  });

  it("defaults to admin-only when the policy is unset", async () => {
    setPolicy(undefined);
    const { sessionId } = await makeUser(PLAIN, "user");
    const res = await register(sessionId, { name: NEW_MIND });
    assert.equal(res.status, 403, "unset policy must not fall open");
    assert.equal(await getUserByUsername(NEW_MIND), null);
  });

  it("under open, a role:user caller may self-register (still landing role:user)", async () => {
    setPolicy("open");
    const { sessionId } = await makeUser(PLAIN, "user");
    const res = await register(sessionId, { name: NEW_MIND });
    assert.equal(res.status, 201, await res.clone().text());
    const body = (await res.json()) as { user: { role: string; user_type: string } };
    // Self-registration must not be an escalation path.
    assert.equal(body.user.role, "user");
    assert.equal(body.user.user_type, "mind");
  });

  it("under closed, even an admin is refused", async () => {
    setPolicy("closed");
    const { sessionId } = await makeUser(ADMIN, "admin");
    const res = await register(sessionId, { name: NEW_MIND });
    assert.equal(res.status, 403);
    assert.equal(await getUserByUsername(NEW_MIND), null);
  });

  it("rejects reserved and malformed names with 400", async () => {
    setPolicy("admin-only");
    const { sessionId } = await makeUser(ADMIN, "admin");

    for (const name of ["volute", "system"]) {
      const res = await register(sessionId, { name });
      assert.equal(res.status, 400, `reserved name "${name}" must be refused`);
    }
    // Charset matters: sender_name attribution depends on the slug shape.
    for (const name of ["has space", "bad!char", "-leading-dash"]) {
      const res = await register(sessionId, { name });
      assert.equal(res.status, 400, `malformed name "${name}" must be refused`);
    }
  });

  it("returns 409 when the username is taken by any user, mind or human", async () => {
    setPolicy("admin-only");
    const { sessionId } = await makeUser(ADMIN, "admin");
    await makeUser(TAKEN, "user"); // a human holds the name

    const res = await register(sessionId, { name: TAKEN });
    assert.equal(res.status, 409);

    // ...and a second registration of a fresh name collides with itself.
    assert.equal((await register(sessionId, { name: NEW_MIND_2 })).status, 201);
    assert.equal((await register(sessionId, { name: NEW_MIND_2 })).status, 409);
  });

  it("resolves a concurrent same-name race to 409, not an unhandled 500", async () => {
    setPolicy("admin-only");
    const { sessionId } = await makeUser(ADMIN, "admin");

    // Both requests clear the getUserByUsername check before either inserts; the
    // UNIQUE constraint stops the duplicate row and the loser must read as 409.
    const [a, b] = await Promise.all([
      register(sessionId, { name: NEW_MIND_3 }),
      register(sessionId, { name: NEW_MIND_3 }),
    ]);
    const statuses = [a.status, b.status].sort();
    assert.deepEqual(statuses, [201, 409], `expected one win + one collision, got ${statuses}`);

    // Exactly one user row exists either way.
    const db = await getDb();
    const rows = await db.select().from(users).where(eq(users.username, NEW_MIND_3)).all();
    assert.equal(rows.length, 1);
  });

  it("is exempt from the maxMinds cap by construction (the cap counts registry rows)", async () => {
    setPolicy("admin-only");
    const { sessionId } = await makeUser(ADMIN, "admin");
    const config = readGlobalConfig();
    config.externalRegistration = "admin-only";
    config.maxMinds = 0; // no native mind could be created at all
    writeGlobalConfig(config);

    const res = await register(sessionId, { name: NEW_MIND_3 });
    assert.equal(res.status, 201, "an external mind has no minds row, so the cap cannot apply");
  });
});

describe("external-registration policy route", () => {
  before(() => {
    savedConfig = readGlobalConfig();
  });
  beforeEach(cleanup);
  afterEach(cleanup);

  it("GET/PUT roundtrips the policy for an admin", async () => {
    const { sessionId } = await makeUser(ADMIN, "admin");
    const { default: app } = await import("../packages/daemon/src/web/app.js");

    setPolicy(undefined);
    const initial = await app.request("http://localhost/api/system/external-registration", {
      headers: { Cookie: `volute_session=${sessionId}` },
    });
    assert.equal(initial.status, 200);
    assert.equal(((await initial.json()) as { policy: string }).policy, "admin-only");

    for (const policy of ["open", "closed", "admin-only"] as const) {
      const put = await app.request("http://localhost/api/system/external-registration", {
        method: "PUT",
        headers: postHeaders(sessionId),
        body: JSON.stringify({ policy }),
      });
      assert.equal(put.status, 200, await put.clone().text());
      assert.equal(((await put.json()) as { policy: string }).policy, policy);

      const get = await app.request("http://localhost/api/system/external-registration", {
        headers: { Cookie: `volute_session=${sessionId}` },
      });
      assert.equal(((await get.json()) as { policy: string }).policy, policy);
      assert.equal(readGlobalConfig().externalRegistration, policy);
    }
  });

  it("refuses a non-admin on both GET and PUT", async () => {
    const { sessionId } = await makeUser(PLAIN, "user");
    const { default: app } = await import("../packages/daemon/src/web/app.js");

    const get = await app.request("http://localhost/api/system/external-registration", {
      headers: { Cookie: `volute_session=${sessionId}` },
    });
    assert.equal(get.status, 403);

    const put = await app.request("http://localhost/api/system/external-registration", {
      method: "PUT",
      headers: postHeaders(sessionId),
      body: JSON.stringify({ policy: "open" }),
    });
    assert.equal(put.status, 403);
    assert.notEqual(readGlobalConfig().externalRegistration, "open");
  });

  it("rejects a policy outside the enum", async () => {
    const { sessionId } = await makeUser(ADMIN, "admin");
    const { default: app } = await import("../packages/daemon/src/web/app.js");

    const res = await app.request("http://localhost/api/system/external-registration", {
      method: "PUT",
      headers: postHeaders(sessionId),
      body: JSON.stringify({ policy: "everyone" }),
    });
    assert.equal(res.status, 400);
    assert.notEqual(readGlobalConfig().externalRegistration, "everyone");
  });
});
