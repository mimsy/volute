import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Hono } from "hono";
import { createUser } from "../src/lib/auth.js";
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
      headers: { Cookie: `molt_session=${cookie}` },
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
      headers: { Cookie: `molt_session=${cookie}` },
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
      headers: { Cookie: `molt_session=${cookie}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.ok);

    // Verify messages are gone (cascade delete)
    const msgsRes = await app.request(`/api/agents/test-agent/conversations/${conv.id}/messages`, {
      headers: { Cookie: `molt_session=${cookie}` },
    });
    const msgs = await msgsRes.json();
    assert.equal(msgs.length, 0);
  });

  it("GET /:name/conversations — requires auth", async () => {
    const app = createApp();
    const res = await app.request("/api/agents/test-agent/conversations");
    assert.equal(res.status, 401);
  });
});
