import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { approveUser, createUser } from "../packages/daemon/src/lib/auth.js";
import { getDb } from "../packages/daemon/src/lib/db.js";
import {
  addMessage,
  type ContentBlock,
  createConversation,
  deleteConversation,
  getConversation,
  getMessages,
} from "../packages/daemon/src/lib/events/conversations.js";
import { users } from "../packages/daemon/src/lib/schema.js";
import v1ConversationsRoute from "../packages/daemon/src/web/api/v1/conversations.js";
import conversationsRoute from "../packages/daemon/src/web/api/volute/conversations.js";
import {
  authMiddleware,
  createSession,
  deleteSession,
} from "../packages/daemon/src/web/middleware/auth.js";

let sessionId: string;
let userId: number;

function createApp() {
  const app = new Hono();
  app.use("/api/minds/*", authMiddleware);
  app.route("/api/minds", conversationsRoute);
  return app;
}

const TEST_USERNAMES = [
  "conv-admin",
  "other-user",
  "other-user2",
  "other-user3",
  "group-member",
  "privacy-outsider",
];

async function cleanup() {
  const db = await getDb();
  for (const username of TEST_USERNAMES) {
    await db.delete(users).where(eq(users.username, username));
  }
}

async function setupAuth() {
  const user = await createUser("conv-admin", "pass");
  userId = user.id;
  sessionId = await createSession(user.id);
  return sessionId;
}

describe("web conversations routes", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("GET /:name/conversations — lists user conversations", async () => {
    const cookie = await setupAuth();
    const app = createApp();

    // Create a conversation with the user as participant
    const conv = await createConversation("volute", {
      participantIds: [userId],
    });
    await addMessage(conv.id, "user", "conv-admin", [{ type: "text", text: "Hello" }]);

    const res = await app.request("/api/minds/test-mind/conversations", {
      headers: { Cookie: `volute_session=${cookie}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body));
    assert.equal(body.length, 1);
    assert.equal(body[0].type, "dm");

    await deleteConversation(conv.id);
  });

  it("GET /:name/conversations/:id/messages — returns messages", async () => {
    const cookie = await setupAuth();
    const app = createApp();

    const conv = await createConversation("volute", {
      participantIds: [userId],
    });
    const blocks: ContentBlock[] = [{ type: "text", text: "Test message" }];
    await addMessage(conv.id, "user", "conv-admin", blocks);
    await addMessage(conv.id, "assistant", "test-mind", [{ type: "text", text: "Response" }]);

    const res = await app.request(`/api/minds/test-mind/conversations/${conv.id}/messages`, {
      headers: { Cookie: `volute_session=${cookie}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.items);
    assert.equal(body.hasMore, false);
    assert.equal(body.items.length, 2);
    assert.equal(body.items[0].role, "user");
    assert.equal(body.items[1].role, "assistant");

    await deleteConversation(conv.id);
  });

  it("GET /:name/conversations/:id/messages?limit=N — paginates messages", async () => {
    const cookie = await setupAuth();
    const app = createApp();

    const conv = await createConversation("volute", {
      participantIds: [userId],
    });
    for (let i = 0; i < 5; i++) {
      await addMessage(conv.id, "user", "conv-admin", [{ type: "text", text: `msg ${i}` }]);
    }

    const res = await app.request(
      `/api/minds/test-mind/conversations/${conv.id}/messages?limit=2`,
      { headers: { Cookie: `volute_session=${cookie}` } },
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.items.length, 2);
    assert.equal(body.hasMore, true);

    await deleteConversation(conv.id);
  });

  it("GET /:name/conversations/:id/messages?before=N — returns older messages", async () => {
    const cookie = await setupAuth();
    const app = createApp();

    const conv = await createConversation("volute", {
      participantIds: [userId],
    });
    const ids: number[] = [];
    for (let i = 0; i < 5; i++) {
      const msg = await addMessage(conv.id, "user", "conv-admin", [
        { type: "text", text: `msg ${i}` },
      ]);
      ids.push(msg.id);
    }

    const res = await app.request(
      `/api/minds/test-mind/conversations/${conv.id}/messages?before=${ids[3]}&limit=10`,
      { headers: { Cookie: `volute_session=${cookie}` } },
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.items.length, 3);
    assert.equal(body.hasMore, false);

    await deleteConversation(conv.id);
  });

  it("GET /:name/conversations/:id/messages?limit=abc — returns 400", async () => {
    const cookie = await setupAuth();
    const app = createApp();

    const conv = await createConversation("volute", {
      participantIds: [userId],
    });

    const res = await app.request(
      `/api/minds/test-mind/conversations/${conv.id}/messages?limit=abc`,
      { headers: { Cookie: `volute_session=${cookie}` } },
    );
    assert.equal(res.status, 400);

    await deleteConversation(conv.id);
  });

  it("DELETE /:name/conversations/:id — deletes conversation", async () => {
    const cookie = await setupAuth();
    const app = createApp();

    const conv = await createConversation("volute", {
      participantIds: [userId],
    });
    await addMessage(conv.id, "user", "conv-admin", [{ type: "text", text: "To delete" }]);

    const res = await app.request(`/api/minds/test-mind/conversations/${conv.id}`, {
      method: "DELETE",
      headers: { Cookie: `volute_session=${cookie}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.ok);

    // Verify conversation is gone (returns 404)
    const msgsRes = await app.request(`/api/minds/test-mind/conversations/${conv.id}/messages`, {
      headers: { Cookie: `volute_session=${cookie}` },
    });
    assert.equal(msgsRes.status, 404);
  });

  it("GET /:name/conversations — requires auth", async () => {
    const app = createApp();
    const res = await app.request("/api/minds/test-mind/conversations");
    assert.equal(res.status, 401);
  });

  it("GET /:name/conversations/:id/messages — 404 for non-participant", async () => {
    const cookie = await setupAuth();
    const app = createApp();

    // Create a conversation with the first user as participant
    const conv = await createConversation("volute", {
      participantIds: [userId],
    });

    // Create and approve a second user
    const user2 = await createUser("other-user", "pass");
    await approveUser(user2.id);
    const cookie2 = await createSession(user2.id);

    // Second user should not see the first user's conversation
    const res = await app.request(`/api/minds/test-mind/conversations/${conv.id}/messages`, {
      headers: { Cookie: `volute_session=${cookie2}` },
    });
    assert.equal(res.status, 404);

    // First user can still see it
    const res2 = await app.request(`/api/minds/test-mind/conversations/${conv.id}/messages`, {
      headers: { Cookie: `volute_session=${cookie}` },
    });
    assert.equal(res2.status, 200);

    await deleteSession(cookie2);
    await deleteConversation(conv.id);
  });

  it("DELETE /:name/conversations/:id — 404 for non-participant", async () => {
    const cookie = await setupAuth();
    const app = createApp();

    const conv = await createConversation("volute", {
      participantIds: [userId],
    });

    const user2 = await createUser("other-user2", "pass");
    await approveUser(user2.id);
    const cookie2 = await createSession(user2.id);

    // Second user cannot delete
    const res = await app.request(`/api/minds/test-mind/conversations/${conv.id}`, {
      method: "DELETE",
      headers: { Cookie: `volute_session=${cookie2}` },
    });
    assert.equal(res.status, 404);

    // First user can still delete
    const res2 = await app.request(`/api/minds/test-mind/conversations/${conv.id}`, {
      method: "DELETE",
      headers: { Cookie: `volute_session=${cookie}` },
    });
    assert.equal(res2.status, 200);

    await deleteSession(cookie2);
  });

  it("GET /:name/conversations/:id/participants — returns participant list", async () => {
    const cookie = await setupAuth();
    const app = createApp();

    const conv = await createConversation("volute", {
      participantIds: [userId],
    });

    const res = await app.request(`/api/minds/test-mind/conversations/${conv.id}/participants`, {
      headers: { Cookie: `volute_session=${cookie}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body));
    assert.equal(body.length, 1);
    assert.equal(body[0].username, "conv-admin");

    await deleteConversation(conv.id);
  });

  it("GET /:name/conversations/:id/participants — 404 for non-participant", async () => {
    await setupAuth();
    const app = createApp();

    const conv = await createConversation("volute", {
      participantIds: [userId],
    });

    const user2 = await createUser("other-user3", "pass");
    await approveUser(user2.id);
    const cookie2 = await createSession(user2.id);

    const res = await app.request(`/api/minds/test-mind/conversations/${conv.id}/participants`, {
      headers: { Cookie: `volute_session=${cookie2}` },
    });
    assert.equal(res.status, 404);

    await deleteSession(cookie2);
    await deleteConversation(conv.id);
  });

  it("POST /:name/conversations — rejects group conversations (3+ participants)", async () => {
    const cookie = await setupAuth();
    const app = createApp();

    // Create another user to add as participant
    const user2 = await createUser("group-member", "pass");
    await approveUser(user2.id);

    const res = await app.request("/api/minds/test-mind/conversations", {
      method: "POST",
      headers: {
        Cookie: `volute_session=${cookie}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        participantIds: [user2.id],
        title: "Test Group",
      }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.ok(body.error.includes("channels"));
  });

  it("POST /:name/conversations — validates participant IDs", async () => {
    const cookie = await setupAuth();
    const app = createApp();

    const res = await app.request("/api/minds/test-mind/conversations", {
      method: "POST",
      headers: {
        Cookie: `volute_session=${cookie}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        participantIds: [99999],
      }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.ok(body.error);
  });

  it("POST /:name/conversations — requires participantIds", async () => {
    const cookie = await setupAuth();
    const app = createApp();

    const res = await app.request("/api/minds/test-mind/conversations", {
      method: "POST",
      headers: {
        Cookie: `volute_session=${cookie}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
  });

  it("addMessage — system sprouted message appears in conversation", async () => {
    await setupAuth();

    const conv = await createConversation("volute", {
      participantIds: [userId],
    });
    await addMessage(conv.id, "user", "conv-admin", [{ type: "text", text: "Hello" }]);
    await addMessage(conv.id, "assistant", "system", [
      { type: "text", text: "[seed has sprouted]" },
    ]);

    const msgs = await getMessages(conv.id);
    assert.equal(msgs.length, 2);
    assert.equal(msgs[1].role, "assistant");
    assert.equal(msgs[1].sender_name, "system");
    assert.equal(msgs[1].content[0].type, "text");
    assert.equal((msgs[1].content[0] as { text: string }).text, "[seed has sprouted]");

    await deleteConversation(conv.id);
  });
});

describe("conversation privacy toggle", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  function createUserConvApp() {
    const app = new Hono();
    app.use("/api/v1/conversations/*", authMiddleware);
    app.route("/api/v1/conversations", v1ConversationsRoute);
    return app;
  }

  it("PUT /:id/private — participant can toggle privacy", async () => {
    const cookie = await setupAuth();
    const app = createUserConvApp();

    const conv = await createConversation("volute", {
      participantIds: [userId],
    });

    // Set to private
    const res = await app.request(`/api/v1/conversations/${conv.id}/private`, {
      method: "PUT",
      headers: {
        Cookie: `volute_session=${cookie}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ private: true }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.ok);

    // Verify it persisted
    const updated = await getConversation(conv.id);
    assert.equal(updated!.private, 1);

    // Set back to public
    const res2 = await app.request(`/api/v1/conversations/${conv.id}/private`, {
      method: "PUT",
      headers: {
        Cookie: `volute_session=${cookie}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ private: false }),
    });
    assert.equal(res2.status, 200);

    const updated2 = await getConversation(conv.id);
    assert.equal(updated2!.private, 0);

    await deleteConversation(conv.id);
  });

  it("PUT /:id/private — non-participant gets 403", async () => {
    await setupAuth();
    const app = createUserConvApp();

    const conv = await createConversation("volute", {
      participantIds: [userId],
    });

    // Create a second user who is not a participant
    const user2 = await createUser("privacy-outsider", "pass");
    await approveUser(user2.id);
    const cookie2 = await createSession(user2.id);

    const res = await app.request(`/api/v1/conversations/${conv.id}/private`, {
      method: "PUT",
      headers: {
        Cookie: `volute_session=${cookie2}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ private: true }),
    });
    assert.equal(res.status, 403);

    await deleteSession(cookie2);
    await deleteConversation(conv.id);
  });
});
