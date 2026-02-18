import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Hono } from "hono";
import { approveUser, createUser } from "../src/lib/auth.js";
import {
  addMessage,
  type ContentBlock,
  createConversation,
  deleteConversation,
  getMessages,
  getParticipants,
} from "../src/lib/conversations.js";
import { getDb } from "../src/lib/db.js";
import {
  conversationParticipants,
  conversations,
  messages,
  sessions,
  users,
} from "../src/lib/schema.js";
import { authMiddleware, createSession, deleteSession } from "../src/web/middleware/auth.js";
import conversationsRoute from "../src/web/routes/volute/conversations.js";

let sessionId: string;
let userId: number;

function createApp() {
  const app = new Hono();
  app.use("/api/minds/*", authMiddleware);
  app.route("/api/minds", conversationsRoute);
  return app;
}

async function cleanup() {
  const db = await getDb();
  await db.delete(sessions);
  await db.delete(messages);
  await db.delete(conversationParticipants);
  await db.delete(conversations);
  await db.delete(users);
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
    const conv = await createConversation("test-agent", "volute", {
      participantIds: [userId],
    });
    await addMessage(conv.id, "user", "conv-admin", [{ type: "text", text: "Hello" }]);

    const res = await app.request("/api/minds/test-agent/conversations", {
      headers: { Cookie: `volute_session=${cookie}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body));
    assert.equal(body.length, 1);
    assert.equal(body[0].mind_name, "test-agent");

    await deleteConversation(conv.id);
  });

  it("GET /:name/conversations/:id/messages — returns messages", async () => {
    const cookie = await setupAuth();
    const app = createApp();

    const conv = await createConversation("test-agent", "volute", {
      participantIds: [userId],
    });
    const blocks: ContentBlock[] = [{ type: "text", text: "Test message" }];
    await addMessage(conv.id, "user", "conv-admin", blocks);
    await addMessage(conv.id, "assistant", "test-agent", [{ type: "text", text: "Response" }]);

    const res = await app.request(`/api/minds/test-agent/conversations/${conv.id}/messages`, {
      headers: { Cookie: `volute_session=${cookie}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body));
    assert.equal(body.length, 2);
    assert.equal(body[0].role, "user");
    assert.equal(body[1].role, "assistant");

    await deleteConversation(conv.id);
  });

  it("DELETE /:name/conversations/:id — deletes conversation", async () => {
    const cookie = await setupAuth();
    const app = createApp();

    const conv = await createConversation("test-agent", "volute", {
      participantIds: [userId],
    });
    await addMessage(conv.id, "user", "conv-admin", [{ type: "text", text: "To delete" }]);

    const res = await app.request(`/api/minds/test-agent/conversations/${conv.id}`, {
      method: "DELETE",
      headers: { Cookie: `volute_session=${cookie}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.ok);

    // Verify conversation is gone (returns 404)
    const msgsRes = await app.request(`/api/minds/test-agent/conversations/${conv.id}/messages`, {
      headers: { Cookie: `volute_session=${cookie}` },
    });
    assert.equal(msgsRes.status, 404);
  });

  it("GET /:name/conversations — requires auth", async () => {
    const app = createApp();
    const res = await app.request("/api/minds/test-agent/conversations");
    assert.equal(res.status, 401);
  });

  it("GET /:name/conversations/:id/messages — 404 for non-participant", async () => {
    const cookie = await setupAuth();
    const app = createApp();

    // Create a conversation with the first user as participant
    const conv = await createConversation("test-agent", "volute", {
      participantIds: [userId],
    });

    // Create and approve a second user
    const user2 = await createUser("other-user", "pass");
    await approveUser(user2.id);
    const cookie2 = await createSession(user2.id);

    // Second user should not see the first user's conversation
    const res = await app.request(`/api/minds/test-agent/conversations/${conv.id}/messages`, {
      headers: { Cookie: `volute_session=${cookie2}` },
    });
    assert.equal(res.status, 404);

    // First user can still see it
    const res2 = await app.request(`/api/minds/test-agent/conversations/${conv.id}/messages`, {
      headers: { Cookie: `volute_session=${cookie}` },
    });
    assert.equal(res2.status, 200);

    await deleteSession(cookie2);
    await deleteConversation(conv.id);
  });

  it("DELETE /:name/conversations/:id — 404 for non-participant", async () => {
    const cookie = await setupAuth();
    const app = createApp();

    const conv = await createConversation("test-agent", "volute", {
      participantIds: [userId],
    });

    const user2 = await createUser("other-user2", "pass");
    await approveUser(user2.id);
    const cookie2 = await createSession(user2.id);

    // Second user cannot delete
    const res = await app.request(`/api/minds/test-agent/conversations/${conv.id}`, {
      method: "DELETE",
      headers: { Cookie: `volute_session=${cookie2}` },
    });
    assert.equal(res.status, 404);

    // First user can still delete
    const res2 = await app.request(`/api/minds/test-agent/conversations/${conv.id}`, {
      method: "DELETE",
      headers: { Cookie: `volute_session=${cookie}` },
    });
    assert.equal(res2.status, 200);

    await deleteSession(cookie2);
  });

  it("GET /:name/conversations/:id/participants — returns participant list", async () => {
    const cookie = await setupAuth();
    const app = createApp();

    const conv = await createConversation("test-agent", "volute", {
      participantIds: [userId],
    });

    const res = await app.request(`/api/minds/test-agent/conversations/${conv.id}/participants`, {
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

    const conv = await createConversation("test-agent", "volute", {
      participantIds: [userId],
    });

    const user2 = await createUser("other-user3", "pass");
    await approveUser(user2.id);
    const cookie2 = await createSession(user2.id);

    const res = await app.request(`/api/minds/test-agent/conversations/${conv.id}/participants`, {
      headers: { Cookie: `volute_session=${cookie2}` },
    });
    assert.equal(res.status, 404);

    await deleteSession(cookie2);
    await deleteConversation(conv.id);
  });

  it("POST /:name/conversations — creates group conversation", async () => {
    const cookie = await setupAuth();
    const app = createApp();

    // Create another user to add as participant
    const user2 = await createUser("group-member", "pass");
    await approveUser(user2.id);

    const res = await app.request("/api/minds/test-agent/conversations", {
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
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.ok(body.id);
    assert.equal(body.title, "Test Group");

    // Verify participants include current user, agent user, and specified user
    const participants = await getParticipants(body.id);
    assert.ok(participants.length >= 3);
    assert.ok(participants.some((p) => p.username === "conv-admin"));
    assert.ok(participants.some((p) => p.username === "test-agent"));
    assert.ok(participants.some((p) => p.username === "group-member"));

    await deleteConversation(body.id);
  });

  it("POST /:name/conversations — validates participant IDs", async () => {
    const cookie = await setupAuth();
    const app = createApp();

    const res = await app.request("/api/minds/test-agent/conversations", {
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

    const res = await app.request("/api/minds/test-agent/conversations", {
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

    const conv = await createConversation("test-agent", "volute", {
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
