import assert from "node:assert/strict";
import { afterEach, before, beforeEach, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { resolveApiToken } from "../packages/daemon/src/lib/api-tokens.js";
import {
  createUser,
  getOrCreateMindUser,
  getUserByUsername,
} from "../packages/daemon/src/lib/auth.js";
import {
  type GlobalConfig,
  readGlobalConfig,
  writeGlobalConfig,
} from "../packages/daemon/src/lib/config/setup.js";
import { getDb } from "../packages/daemon/src/lib/db.js";
import { addMind, addVariant } from "../packages/daemon/src/lib/mind/registry.js";
import { minds, users } from "../packages/daemon/src/lib/schema.js";
import { createSession, deleteSession } from "../packages/daemon/src/web/middleware/auth.js";

const ADMIN = "r2-reg-admin";
const SYSTEM_CALLER = "r2-reg-system";
const PLAIN = "r2-reg-plain";
const PENDING = "r2-reg-pending";
const TAKEN = "r2-reg-taken";
const NEW_MIND = "r2-reg-external";
const NEW_MIND_2 = "r2-reg-external-two";
const NEW_MIND_3 = "r2-reg-external-three";
const LOCAL_MIND = "r2-reg-local";
const LOCAL_VARIANT = "r2-reg-local-variant";

const TEST_USERNAMES = [
  ADMIN,
  SYSTEM_CALLER,
  PLAIN,
  PENDING,
  TAKEN,
  NEW_MIND,
  NEW_MIND_2,
  NEW_MIND_3,
  LOCAL_MIND,
  LOCAL_VARIANT,
];

/** Registry rows the external-flag tests create; dropped alongside their users. */
const TEST_MIND_ROWS = [LOCAL_MIND, LOCAL_VARIANT];

const sessions: string[] = [];
let savedConfig: GlobalConfig;

async function cleanup() {
  const db = await getDb();
  for (const username of TEST_USERNAMES) {
    // FK cascade drops any api_tokens rows with the user.
    await db.delete(users).where(eq(users.username, username));
  }
  // `minds.port` is UNIQUE, so a leaked row would collide with the next run's
  // addMind rather than fail visibly here.
  for (const name of TEST_MIND_ROWS) {
    await db.delete(minds).where(eq(minds.name, name));
  }
  for (const id of sessions.splice(0)) await deleteSession(id);
  writeGlobalConfig(savedConfig);
}

/**
 * `createUser` only auto-admins the FIRST human user in the DB, which isn't
 * reliable in a shared test DB — set the role explicitly. Written straight to the
 * row rather than via `setUserRole`, whose contract is only "admin" | "user";
 * the gate has to be provable against "spirit" and "pending" callers too.
 */
async function makeUser(username: string, role: "admin" | "user" | "spirit" | "pending") {
  const user = await createUser(username, "pw-123456");
  const db = await getDb();
  await db.update(users).set({ role }).where(eq(users.id, user.id));
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
    // Cloned: readGlobalConfig() hands back the live cache object on a miss, so
    // holding the reference would let a later in-place mutation rewrite the very
    // baseline we restore from.
    savedConfig = structuredClone(readGlobalConfig());
  });
  beforeEach(cleanup);
  afterEach(cleanup);

  it("an admin creates a mind USER with no registry row, token returned once", async () => {
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

  it("refuses a role:user caller, and creates nothing", async () => {
    const { sessionId } = await makeUser(PLAIN, "user");
    const res = await register(sessionId, { name: NEW_MIND });
    assert.equal(res.status, 403);
    assert.equal(await getUserByUsername(NEW_MIND), null);
  });

  // The gate that matters: registration mints a durable credential, so it is
  // requireAdmin — human-gated — exactly like the R1 token routes. The injectable
  // `spirit` principal must NOT be able to mint one for itself. This test fails if
  // anyone re-widens the route to admit "spirit".
  it("refuses a role:spirit caller, and creates nothing", async () => {
    const { sessionId } = await makeUser(SYSTEM_CALLER, "spirit");
    const res = await register(sessionId, { name: NEW_MIND });
    assert.equal(res.status, 403, "the spirit must not mint durable credentials without a human");
    assert.equal(await getUserByUsername(NEW_MIND), null);
  });

  it("refuses a pending caller, and creates nothing", async () => {
    const { sessionId } = await makeUser(PENDING, "pending");
    const res = await register(sessionId, { name: NEW_MIND });
    assert.equal(res.status, 403);
    assert.equal(await getUserByUsername(NEW_MIND), null);
  });

  it("rejects reserved and malformed names with 400", async () => {
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
    const { sessionId } = await makeUser(ADMIN, "admin");
    await makeUser(TAKEN, "user"); // a human holds the name

    const res = await register(sessionId, { name: TAKEN });
    assert.equal(res.status, 409);

    // ...and a second registration of a fresh name collides with itself.
    assert.equal((await register(sessionId, { name: NEW_MIND_2 })).status, 201);
    assert.equal((await register(sessionId, { name: NEW_MIND_2 })).status, 409);
  });

  it("resolves a concurrent same-name race to 409, not an unhandled 500", async () => {
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
    const { sessionId } = await makeUser(ADMIN, "admin");
    const config = readGlobalConfig();
    config.maxMinds = 0; // no native mind could be created at all
    writeGlobalConfig(config);

    const res = await register(sessionId, { name: NEW_MIND_3 });
    assert.equal(res.status, 201, "an external mind has no minds row, so the cap cannot apply");
  });
});

/**
 * `GET /api/auth/users` tags mind users with `external`. This has to be computed
 * daemon-side: the flag means "no `minds` row", and the mind list a client can
 * see (`GET /api/v1/minds` → readRegistry) omits variants, so a client comparing
 * against it would read every live variant as external.
 */
describe("users list — external flag", () => {
  before(() => {
    savedConfig = structuredClone(readGlobalConfig());
  });
  beforeEach(cleanup);
  afterEach(cleanup);

  async function listUsers(cookie: string) {
    const { default: app } = await import("../packages/daemon/src/web/app.js");
    const res = await app.request("http://localhost/api/auth/users", {
      headers: { Cookie: `volute_session=${cookie}` },
    });
    assert.equal(res.status, 200, await res.clone().text());
    const body = (await res.json()) as {
      username: string;
      user_type: string;
      external?: boolean;
    }[];
    return new Map(body.map((u) => [u.username, u]));
  }

  it("flags a registered external mind, and not a local one", async () => {
    const { sessionId } = await makeUser(ADMIN, "admin");
    await register(sessionId, { name: NEW_MIND });
    await addMind(LOCAL_MIND, 4977);

    const byName = await listUsers(sessionId);

    assert.equal(byName.get(NEW_MIND)?.external, true, "no minds row ⇒ external");
    assert.equal(byName.get(LOCAL_MIND)?.external, false, "has a minds row ⇒ local");
  });

  // A variant gets its users row at split and keeps a minds row naming its parent,
  // which readRegistry filters out. It is local whether or not it is running.
  it("does not flag a variant as external", async () => {
    const { sessionId } = await makeUser(ADMIN, "admin");
    await addMind(LOCAL_MIND, 4977);
    await addVariant(LOCAL_VARIANT, LOCAL_MIND, 4978, "/tmp/variant", "variant-branch");
    await getOrCreateMindUser(LOCAL_VARIANT);

    const byName = await listUsers(sessionId);

    assert.equal(byName.get(LOCAL_VARIANT)?.user_type, "mind");
    assert.equal(
      byName.get(LOCAL_VARIANT)?.external,
      false,
      "a variant is spawned here — readAllMinds must be the source, not readRegistry",
    );
  });

  it("leaves human users untagged", async () => {
    const { sessionId } = await makeUser(ADMIN, "admin");

    const byName = await listUsers(sessionId);

    assert.equal(byName.get(ADMIN)?.user_type, "human");
    assert.equal(byName.get(ADMIN)?.external, undefined, "external is a mind-only concept");
  });

  it("tags mind users on the ?type=mind branch too", async () => {
    const { sessionId } = await makeUser(ADMIN, "admin");
    await register(sessionId, { name: NEW_MIND });
    await addMind(LOCAL_MIND, 4977);

    const { default: app } = await import("../packages/daemon/src/web/app.js");
    const res = await app.request("http://localhost/api/auth/users?type=mind", {
      headers: { Cookie: `volute_session=${sessionId}` },
    });
    assert.equal(res.status, 200);
    const byName = new Map(
      ((await res.json()) as { username: string; external?: boolean }[]).map((u) => [
        u.username,
        u,
      ]),
    );

    assert.equal(byName.get(NEW_MIND)?.external, true);
    assert.equal(byName.get(LOCAL_MIND)?.external, false);
  });
});

/**
 * Deleting an external mind is deleting its account: there is no process to stop
 * and no directory to remove, and the mind-deletion API would 404 on it. The guard
 * that sends minds to that API must therefore key on having a registry row, not on
 * being mind-typed — otherwise a registered external mind can never be removed.
 */
describe("external mind deletion", () => {
  before(() => {
    savedConfig = structuredClone(readGlobalConfig());
  });
  beforeEach(cleanup);
  afterEach(cleanup);

  async function del(cookie: string, id: number) {
    const { default: app } = await import("../packages/daemon/src/web/app.js");
    return app.request(`http://localhost/api/auth/users/${id}`, {
      method: "DELETE",
      headers: { Cookie: `volute_session=${cookie}`, Origin: "http://localhost" },
    });
  }

  it("deletes an external mind's account, taking its tokens with it", async () => {
    const { sessionId } = await makeUser(ADMIN, "admin");
    const res = await register(sessionId, { name: NEW_MIND });
    const { user, token } = (await res.json()) as { user: { id: number }; token: string };
    assert.equal(await resolveApiToken(token), user.id, "token works before deletion");

    const delRes = await del(sessionId, user.id);
    assert.equal(delRes.status, 200, await delRes.clone().text());

    assert.equal(await getUserByUsername(NEW_MIND), null, "account is gone");
    // FK cascade on api_tokens.user_id — revoking access is the point of the delete.
    assert.equal(await resolveApiToken(token), null, "its token no longer authenticates");
  });

  it("still refuses to delete a local mind through the users API", async () => {
    const { sessionId } = await makeUser(ADMIN, "admin");
    await addMind(LOCAL_MIND, 4977);
    const mindUser = await getOrCreateMindUser(LOCAL_MIND);

    const delRes = await del(sessionId, mindUser.id);
    assert.equal(delRes.status, 400, "a mind with a registry row has a process and a directory");
    assert.ok(await getUserByUsername(LOCAL_MIND), "and its account survives");
  });

  it("still refuses to delete a variant through the users API", async () => {
    const { sessionId } = await makeUser(ADMIN, "admin");
    await addMind(LOCAL_MIND, 4977);
    await addVariant(LOCAL_VARIANT, LOCAL_MIND, 4978, "/tmp/variant", "variant-branch");
    const variantUser = await getOrCreateMindUser(LOCAL_VARIANT);

    const delRes = await del(sessionId, variantUser.id);
    assert.equal(delRes.status, 400, "a variant has a worktree to tear down");
    assert.ok(await getUserByUsername(LOCAL_VARIANT), "and its account survives");
  });
});
