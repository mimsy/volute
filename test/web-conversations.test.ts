import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Hono } from "hono";
import { approveUser, createUser } from "../src/lib/auth.js";
import {
  addMessage,
  type ContentBlock,
  createConversation,
  deleteConversation,
} from "../src/lib/conversations.js";
import { getDb } from "../src/lib/db.js";
import { conversations, messages, users } from "../src/lib/schema.js";
import { authMiddleware, createSession, deleteSession } from "../src/web/middleware/auth.js";
import conversationsRoute from "../src/web/routes/conversations.js";

let sessionId: string;
let userId: number;

function createApp() {
  const app = new Hono();
  app.use("/api/agents/*", authMiddleware);
  app.route("/api/agents", conversationsRoute);
  return app;
}

async function cleanup() {
  const db = await getDb();
  await db.delete(messages);
  await db.delete(conversations);
  await db.delete(users);
  if (sessionId) deleteSession(sessionId);
}

async function setupAuth() {
  const user = await createUser("conv-admin", "pass");
  userId = user.id;
  sessionId = createSession(user.id);
  return sessionId;
}

describe("web conversations routes", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("GET /:name/conversations — lists user conversations", async () => {
    const cookie = await setupAuth();
    const app = createApp();

    // Create a conversation for this user
    const conv = await createConversation("test-agent", "web", { userId });
    await addMessage(conv.id, "user", "conv-admin", [{ type: "text", text: "Hello" }]);

    const res = await app.request("/api/agents/test-agent/conversations", {
      headers: { Cookie: `volute_session=${cookie}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body));
    assert.equal(body.length, 1);
    assert.equal(body[0].agent_name, "test-agent");

    await deleteConversation(conv.id);
  });

  it("GET /:name/conversations/:id/messages — returns messages", async () => {
    const cookie = await setupAuth();
    const app = createApp();

    const conv = await createConversation("test-agent", "web", { userId });
    const blocks: ContentBlock[] = [{ type: "text", text: "Test message" }];
    await addMessage(conv.id, "user", "conv-admin", blocks);
    await addMessage(conv.id, "assistant", "test-agent", [{ type: "text", text: "Response" }]);

    const res = await app.request(`/api/agents/test-agent/conversations/${conv.id}/messages`, {
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

    const conv = await createConversation("test-agent", "web", { userId });
    await addMessage(conv.id, "user", "conv-admin", [{ type: "text", text: "To delete" }]);

    const res = await app.request(`/api/agents/test-agent/conversations/${conv.id}`, {
      method: "DELETE",
      headers: { Cookie: `volute_session=${cookie}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.ok);

    // Verify conversation is gone (returns 404)
    const msgsRes = await app.request(`/api/agents/test-agent/conversations/${conv.id}/messages`, {
      headers: { Cookie: `volute_session=${cookie}` },
    });
    assert.equal(msgsRes.status, 404);
  });

  it("GET /:name/conversations — requires auth", async () => {
    const app = createApp();
    const res = await app.request("/api/agents/test-agent/conversations");
    assert.equal(res.status, 401);
  });

  it("GET /:name/conversations/:id/messages — 404 for other user's conversation", async () => {
    const cookie = await setupAuth();
    const app = createApp();

    // Create a conversation owned by the first user
    const conv = await createConversation("test-agent", "web", { userId });

    // Create and approve a second user
    const user2 = await createUser("other-user", "pass");
    await approveUser(user2.id);
    const cookie2 = createSession(user2.id);

    // Second user should not see the first user's conversation
    const res = await app.request(`/api/agents/test-agent/conversations/${conv.id}/messages`, {
      headers: { Cookie: `volute_session=${cookie2}` },
    });
    assert.equal(res.status, 404);

    // First user can still see it
    const res2 = await app.request(`/api/agents/test-agent/conversations/${conv.id}/messages`, {
      headers: { Cookie: `volute_session=${cookie}` },
    });
    assert.equal(res2.status, 200);

    deleteSession(cookie2);
    await deleteConversation(conv.id);
  });

  it("DELETE /:name/conversations/:id — 404 for other user's conversation", async () => {
    const cookie = await setupAuth();
    const app = createApp();

    const conv = await createConversation("test-agent", "web", { userId });

    const user2 = await createUser("other-user2", "pass");
    await approveUser(user2.id);
    const cookie2 = createSession(user2.id);

    // Second user cannot delete
    const res = await app.request(`/api/agents/test-agent/conversations/${conv.id}`, {
      method: "DELETE",
      headers: { Cookie: `volute_session=${cookie2}` },
    });
    assert.equal(res.status, 404);

    // First user can still delete
    const res2 = await app.request(`/api/agents/test-agent/conversations/${conv.id}`, {
      method: "DELETE",
      headers: { Cookie: `volute_session=${cookie}` },
    });
    assert.equal(res2.status, 200);

    deleteSession(cookie2);
  });
});
