import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { createUser } from "../packages/daemon/src/lib/auth.js";
import { getDb } from "../packages/daemon/src/lib/db.js";
import {
  addMessage,
  createConversation,
  deleteConversation,
} from "../packages/daemon/src/lib/events/conversations.js";
import { users } from "../packages/daemon/src/lib/schema.js";
import { parseIntParam } from "../packages/daemon/src/lib/util/query-params.js";
import conversationsRoute from "../packages/daemon/src/web/api/v1/conversations.js";
import { createSession } from "../packages/daemon/src/web/middleware/auth.js";

describe("parseIntParam (#868)", () => {
  it("returns undefined for an absent param", () => {
    assert.equal(parseIntParam(undefined), undefined);
  });

  it("parses a base-10 integer", () => {
    assert.equal(parseIntParam("4000"), 4000);
    assert.equal(parseIntParam("0"), 0);
  });

  it("rejects an ISO timestamp instead of salvaging its leading digits", () => {
    // parseInt("2026-07-18T00:00:00Z", 10) === 2026 — a plausible message id. That
    // coercion served a wrong page of history with a 200 and a mind published a false
    // finding off it. It must be an error, not a number.
    assert.equal(parseIntParam("2026-07-18T00:00:00Z"), null);
  });

  it("rejects other non-integer shapes that parseInt would salvage or Number would widen", () => {
    for (const bad of ["50.5", "1e2", "-5", "12abc", "abc", "", " 12", "0x10", "Infinity"]) {
      assert.equal(parseIntParam(bad), null, `${JSON.stringify(bad)} should be rejected`);
    }
  });

  it("rejects a digit run too large to round-trip as an id", () => {
    assert.equal(parseIntParam("99999999999999999999999"), null);
  });
});

describe("GET /api/v1/conversations/:id/messages — cursor validation (#868)", () => {
  const TEST_USERNAME = "cursor-tester";
  let cookie: string;
  let convId: string;
  let messageIds: number[];

  function createApp() {
    const app = new Hono();
    app.route("/api/v1/conversations", conversationsRoute);
    return app;
  }

  beforeEach(async () => {
    const db = await getDb();
    await db.delete(users).where(eq(users.username, TEST_USERNAME));
    const user = await createUser(TEST_USERNAME, "pass");
    cookie = await createSession(user.id);

    const conv = await createConversation({ userId: user.id });
    convId = conv.id;
    messageIds = [];
    for (const text of ["one", "two", "three"]) {
      const msg = await addMessage(convId, "user", TEST_USERNAME, [{ type: "text", text }]);
      messageIds.push(msg.id);
    }
  });

  afterEach(async () => {
    await deleteConversation(convId);
    const db = await getDb();
    await db.delete(users).where(eq(users.username, TEST_USERNAME));
  });

  const get = (query: string) =>
    createApp().request(`/api/v1/conversations/${convId}/messages${query}`, {
      headers: { Cookie: `volute_session=${cookie}` },
    });

  it("serves the newest page with no cursor", async () => {
    const res = await get("");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.items.length, 3);
  });

  it("honours an integer cursor", async () => {
    // Control: the endpoint really does paginate, so a 400 below is a rejection and
    // not a dead instrument.
    const res = await get(`?before=${messageIds[2]}&limit=2`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(
      body.items.map((m: { id: number }) => m.id),
      [messageIds[0], messageIds[1]],
    );
  });

  it("400s on an ISO timestamp cursor instead of coercing it to a message id", async () => {
    const res = await get("?before=2026-07-18T00:00:00Z&limit=2");
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /integers/);
  });

  it("400s on a non-integer limit", async () => {
    const res = await get("?limit=2.5");
    assert.equal(res.status, 400);
  });
});
