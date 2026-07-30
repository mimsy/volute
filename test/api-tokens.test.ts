import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import {
  hashToken,
  issueApiToken,
  listApiTokens,
  resolveApiToken,
} from "../packages/daemon/src/lib/api-tokens.js";
import { createUser, getOrCreateMindUser, setUserRole } from "../packages/daemon/src/lib/auth.js";
import {
  generateMindToken,
  resolveMindToken,
  revokeMindToken,
} from "../packages/daemon/src/lib/daemon/mind-tokens.js";
import { getDb } from "../packages/daemon/src/lib/db.js";
import { apiTokens, users } from "../packages/daemon/src/lib/schema.js";
import authApp from "../packages/daemon/src/web/api/auth.js";
import {
  authMiddleware,
  createSession,
  requireSelf,
} from "../packages/daemon/src/web/middleware/auth.js";

const EXTERNAL_MIND = "api-token-external-mind";
const OTHER_MIND = "api-token-other-mind";
const ADMIN_USER = "api-token-admin";
const PLAIN_USER = "api-token-plain";

const TEST_USERNAMES = [EXTERNAL_MIND, OTHER_MIND, ADMIN_USER, PLAIN_USER];

async function cleanup() {
  const db = await getDb();
  for (const username of TEST_USERNAMES) {
    // FK cascade drops any api_tokens rows with the user.
    await db.delete(users).where(eq(users.username, username));
  }
}

/** A minimal app exposing a requireSelf-guarded route, mirroring mind-scoped routes. */
function createApp() {
  const app = new Hono();
  app.use("/api/minds/*", authMiddleware);
  app.get("/api/minds/:name/info", requireSelf(), (c) =>
    c.json({ ok: true, name: c.req.param("name"), caller: c.get("user").username }),
  );
  return app;
}

/**
 * Create an admin explicitly. `createUser` only auto-admins the FIRST human user,
 * and `approveUser` grants role "user" — neither is reliable in a shared test DB.
 */
async function makeAdmin() {
  const user = await createUser(ADMIN_USER, "pw-123456");
  await setUserRole(user.id, "admin");
  const db = await getDb();
  const row = await db.select().from(users).where(eq(users.id, user.id)).get();
  assert.equal(row?.role, "admin");
  return user;
}

describe("api tokens", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("authenticates as the token's user on a requireSelf route", async () => {
    const mindUser = await getOrCreateMindUser(EXTERNAL_MIND);
    await getOrCreateMindUser(OTHER_MIND);
    const { token } = await issueApiToken(mindUser.id, "external heartbeat");

    const app = createApp();

    const ok = await app.request(`/api/minds/${EXTERNAL_MIND}/info`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(ok.status, 200, await ok.clone().text());
    const body = (await ok.json()) as { caller: string };
    assert.equal(body.caller, EXTERNAL_MIND);

    // The principal is the mind user itself: user_type "mind", non-admin role.
    assert.equal(mindUser.user_type, "mind");
    assert.equal(mindUser.role, "user");

    // ...and it cannot reach another mind's route.
    const forbidden = await app.request(`/api/minds/${OTHER_MIND}/info`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(forbidden.status, 403);
  });

  it("skips the DB for non-vmt_ bearers and falls through to session resolution", async () => {
    const user = await makeAdmin();
    const sessionId = await createSession(user.id);

    // A bare-UUID session id is not vmt_-prefixed, so resolveApiToken short-circuits...
    assert.equal(await resolveApiToken(sessionId), null);

    // ...and the request still authenticates via the session-Bearer branch.
    const app = createApp();
    const res = await app.request(`/api/minds/${EXTERNAL_MIND}/info`, {
      headers: { Authorization: `Bearer ${sessionId}` },
    });
    assert.equal(res.status, 200, await res.clone().text());

    // An unknown non-prefixed bearer resolves to nothing at all.
    assert.equal(await resolveApiToken("not-a-vmt-token"), null);
  });

  it("stores only a sha256 hash at rest, never the plaintext", async () => {
    const mindUser = await getOrCreateMindUser(EXTERNAL_MIND);
    const { id, token } = await issueApiToken(mindUser.id, "at-rest");

    const db = await getDb();
    const row = await db.select().from(apiTokens).where(eq(apiTokens.id, id)).get();
    assert.ok(row);
    assert.notEqual(row.token_hash, token);
    assert.equal(row.token_hash, createHash("sha256").update(token).digest("hex"));
    assert.equal(row.token_hash, hashToken(token));
    assert.ok(token.startsWith("vmt_"));

    // listApiTokens exposes neither the hash nor the token.
    const listed = await listApiTokens(mindUser.id);
    const serialized = JSON.stringify(listed);
    assert.ok(!serialized.includes(row.token_hash), "list must not leak the hash");
    assert.ok(!serialized.includes(token), "list must not leak the token");
    assert.deepEqual(Object.keys(listed[0]).sort(), ["created_at", "id", "label"]);
  });

  it("stops resolving a token once revoked via the API", async () => {
    const adminSession = await createSession((await makeAdmin()).id);
    const mindUser = await getOrCreateMindUser(EXTERNAL_MIND);

    const issueRes = await authApp.request(`/users/${mindUser.id}/tokens`, {
      method: "POST",
      headers: { Authorization: `Bearer ${adminSession}`, "Content-Type": "application/json" },
      body: JSON.stringify({ label: "revoke-me" }),
    });
    assert.equal(issueRes.status, 201, await issueRes.clone().text());
    const issued = (await issueRes.json()) as { id: number; token: string };
    assert.ok(issued.token.startsWith("vmt_"));

    const app = createApp();
    const before = await app.request(`/api/minds/${EXTERNAL_MIND}/info`, {
      headers: { Authorization: `Bearer ${issued.token}` },
    });
    assert.equal(before.status, 200);

    const del = await authApp.request(`/users/${mindUser.id}/tokens/${issued.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${adminSession}` },
    });
    assert.equal(del.status, 200, await del.clone().text());

    // Revoked: the token no longer resolves and the request is unauthenticated.
    assert.equal(await resolveApiToken(issued.token), null);
    const after = await app.request(`/api/minds/${EXTERNAL_MIND}/info`, {
      headers: { Authorization: `Bearer ${issued.token}` },
    });
    assert.equal(after.status, 401);
  });

  it("restricts issuance to admins only (not user or system principals)", async () => {
    const mindUser = await getOrCreateMindUser(EXTERNAL_MIND);

    // A role:"user" principal (what every mind token resolves to) cannot mint.
    const { token: userToken } = await issueApiToken(mindUser.id, "non-admin");
    const forbidden = await authApp.request(`/users/${mindUser.id}/tokens`, {
      method: "POST",
      headers: { Authorization: `Bearer ${userToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(forbidden.status, 403);

    // Nor list, nor revoke.
    const listForbidden = await authApp.request(`/users/${mindUser.id}/tokens`, {
      headers: { Authorization: `Bearer ${userToken}` },
    });
    assert.equal(listForbidden.status, 403);

    // Nor the spirit principal: durable issuance is human-gated, so even
    // role:"spirit" is rejected — closing the prompt-injection path where
    // untrusted text could talk the spirit into minting a credential.
    const systemUser = await getOrCreateMindUser(OTHER_MIND);
    await setUserRole(systemUser.id, "spirit");
    const { token: systemToken } = await issueApiToken(systemUser.id, "system-principal");
    const systemForbidden = await authApp.request(`/users/${mindUser.id}/tokens`, {
      method: "POST",
      headers: { Authorization: `Bearer ${systemToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(systemForbidden.status, 403);

    // Unauthenticated requests are rejected before authz.
    const unauth = await authApp.request(`/users/${mindUser.id}/tokens`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(unauth.status, 401);
  });

  it("returns 404 for an unknown user id", async () => {
    const adminSession = await createSession((await makeAdmin()).id);

    const res = await authApp.request("/users/99999999/tokens", {
      method: "POST",
      headers: { Authorization: `Bearer ${adminSession}`, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 404);
  });

  it("lists a user's tokens without hash or token", async () => {
    const adminSession = await createSession((await makeAdmin()).id);
    const mindUser = await getOrCreateMindUser(EXTERNAL_MIND);
    await issueApiToken(mindUser.id, "first");
    await issueApiToken(mindUser.id, "second");

    const res = await authApp.request(`/users/${mindUser.id}/tokens`, {
      headers: { Authorization: `Bearer ${adminSession}` },
    });
    assert.equal(res.status, 200);
    const listed = (await res.json()) as Record<string, unknown>[];
    assert.equal(listed.length, 2);
    for (const t of listed) {
      assert.deepEqual(Object.keys(t).sort(), ["createdAt", "id", "label"]);
    }
  });

  it("refuses to revoke a token belonging to a different user", async () => {
    const adminSession = await createSession((await makeAdmin()).id);
    const mindUser = await getOrCreateMindUser(EXTERNAL_MIND);
    const otherUser = await getOrCreateMindUser(OTHER_MIND);
    const { id: otherTokenId, token: otherToken } = await issueApiToken(otherUser.id);

    // Token id is real, but it isn't :id's token — the path must not delete it.
    const res = await authApp.request(`/users/${mindUser.id}/tokens/${otherTokenId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${adminSession}` },
    });
    assert.equal(res.status, 404);
    assert.equal(await resolveApiToken(otherToken), otherUser.id, "token must still resolve");
  });

  it("is orthogonal to the in-memory native-mind token map", async () => {
    const mindUser = await getOrCreateMindUser(EXTERNAL_MIND);
    const { token: apiToken } = await issueApiToken(mindUser.id, "durable");

    // Native in-memory token: separate path, separate value space.
    const nativeToken = generateMindToken(EXTERNAL_MIND);
    assert.equal(resolveMindToken(nativeToken), EXTERNAL_MIND);
    assert.ok(!nativeToken.startsWith("vmt_"));

    // resolveMindToken stays synchronous — it returns a value, not a promise.
    assert.ok(!(resolveMindToken(nativeToken) instanceof Promise));

    // Revoking the in-memory token leaves the durable row untouched.
    revokeMindToken(EXTERNAL_MIND);
    assert.equal(resolveMindToken(nativeToken), null);
    assert.equal(await resolveApiToken(apiToken), mindUser.id);

    // ...and the api token never resolves through the native map.
    assert.equal(resolveMindToken(apiToken), null);

    const db = await getDb();
    const rows = await db.select().from(apiTokens).where(eq(apiTokens.user_id, mindUser.id)).all();
    assert.equal(rows.length, 1, "in-memory token churn must not touch api_tokens rows");
  });

  it("drops a user's tokens when the user is deleted (FK cascade)", async () => {
    const mindUser = await getOrCreateMindUser(EXTERNAL_MIND);
    const { token } = await issueApiToken(mindUser.id);
    assert.equal(await resolveApiToken(token), mindUser.id);

    const db = await getDb();
    await db.delete(users).where(eq(users.id, mindUser.id));
    assert.equal(await resolveApiToken(token), null);
  });

  it("rejects a pending user's token", async () => {
    const user = await createUser(PLAIN_USER, "pw-123456");
    // Force "pending" explicitly: createUser only auto-admins the first human,
    // so its default role depends on what else is in the shared test DB.
    const db = await getDb();
    await db.update(users).set({ role: "pending" }).where(eq(users.id, user.id));
    const { token } = await issueApiToken(user.id, "pending-user");

    const app = createApp();
    const res = await app.request(`/api/minds/${EXTERNAL_MIND}/info`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 403);
  });
});
