import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { createUser, getOrCreateMindUser } from "../packages/daemon/src/lib/auth.js";
import { getDb } from "../packages/daemon/src/lib/db.js";
import {
  addMessage,
  createConversation,
  deleteConversation,
} from "../packages/daemon/src/lib/events/conversations.js";
import { minds, users } from "../packages/daemon/src/lib/schema.js";
import { parseIntParam } from "../packages/daemon/src/lib/util/query-params.js";
import v1ConversationsRoute from "../packages/daemon/src/web/api/v1/conversations.js";
import voluteConversationsRoute from "../packages/daemon/src/web/api/volute/conversations.js";
import { authMiddleware, createSession } from "../packages/daemon/src/web/middleware/auth.js";

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
    for (const bad of ["50.5", "1e2", "-5", "12abc", "abc", " 12", "0x10", "Infinity"]) {
      assert.equal(parseIntParam(bad), null, `${JSON.stringify(bad)} should be rejected`);
    }
  });

  it("treats an empty value as absence, not malformation", () => {
    // `?before=` carries no value to be wrong about. Deciding this in the helper is what
    // keeps the three routes uniform — see the empty-cursor route tests below.
    assert.equal(parseIntParam(""), undefined);
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
    app.route("/api/v1/conversations", v1ConversationsRoute);
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
    // The shared cursor validator (zValidator) rejects it with a structured zod error
    // rather than salvaging the leading "2026" as a message id (#868).
    assert.match(JSON.stringify(await res.json()), /non-negative integer/);
  });

  it("400s on a non-integer limit", async () => {
    const res = await get("?limit=2.5");
    assert.equal(res.status, 400);
  });
});

// All three routes feed getMessagesPaginated and must agree on what a cursor is. The
// trap they share: minds.ts and volute/conversations.ts short-circuit to unpaginated
// history when *both* params are falsy, so validating per-call-site would make the
// verdict on `?before=` depend on whether `limit` happened to be present too. Deciding
// empty-is-absent inside parseIntParam is what removes that coupling — these tests pin
// it end-to-end rather than trusting the helper's unit test to imply it.
describe("message cursor validation is uniform across all three routes (#868)", () => {
  const TEST_USERNAME = "cursor-uniform";
  const MIND_NAME = "cursor-uniform-mind";
  let cookie: string;
  let convId: string;

  async function cleanup() {
    const db = await getDb();
    await db.delete(users).where(eq(users.username, TEST_USERNAME));
    await db.delete(users).where(eq(users.username, MIND_NAME));
    await db.delete(minds).where(eq(minds.name, MIND_NAME));
  }

  beforeEach(async () => {
    await cleanup();
    const user = await createUser(TEST_USERNAME, "pass");
    cookie = await createSession(user.id);

    // minds.ts additionally requires a registry row and the mind as a participant.
    const db = await getDb();
    await db.insert(minds).values({ name: MIND_NAME, port: 4392, dir: `/tmp/${MIND_NAME}` });
    const mindUser = await getOrCreateMindUser(MIND_NAME);

    const conv = await createConversation({ participantIds: [user.id, mindUser.id] });
    convId = conv.id;
    await addMessage(convId, "user", TEST_USERNAME, [{ type: "text", text: "hi" }]);
  });

  afterEach(async () => {
    await deleteConversation(convId);
    await cleanup();
  });

  // The composed app is how minds.ts is reached (it shadows the volute route there);
  // the other two are mounted standalone so each is genuinely the route under test.
  const routes = [
    {
      name: "v1/conversations.ts",
      request: async (query: string) => {
        const app = new Hono().route("/api/v1/conversations", v1ConversationsRoute);
        return app.request(`/api/v1/conversations/${convId}/messages${query}`, {
          headers: { Cookie: `volute_session=${cookie}` },
        });
      },
    },
    {
      name: "volute/conversations.ts",
      request: async (query: string) => {
        const app = new Hono();
        app.use("/api/minds/*", authMiddleware);
        app.route("/api/minds", voluteConversationsRoute);
        return app.request(`/api/minds/${MIND_NAME}/conversations/${convId}/messages${query}`, {
          headers: { Cookie: `volute_session=${cookie}` },
        });
      },
    },
    {
      name: "minds.ts",
      request: async (query: string) => {
        const { default: app } = await import("../packages/daemon/src/web/app.js");
        return app.request(`/api/v1/minds/${MIND_NAME}/conversations/${convId}/messages${query}`, {
          headers: { Cookie: `volute_session=${cookie}` },
        });
      },
    },
  ];

  for (const route of routes) {
    it(`${route.name} — an empty cursor reads as absent, with or without limit`, async () => {
      assert.equal((await route.request("?before=")).status, 200);
      assert.equal((await route.request("?before=&limit=5")).status, 200);
      assert.equal((await route.request("?limit=")).status, 200);
    });

    it(`${route.name} — a malformed cursor 400s, with or without limit`, async () => {
      assert.equal((await route.request("?before=2026-07-18T00:00:00Z")).status, 400);
      assert.equal((await route.request("?before=2026-07-18T00:00:00Z&limit=5")).status, 400);
    });

    it(`${route.name} — an integer cursor still works`, async () => {
      // Positive control: proves the 400s above are rejections, not a broken route.
      assert.equal((await route.request("?before=999999&limit=5")).status, 200);
    });
  }
});
