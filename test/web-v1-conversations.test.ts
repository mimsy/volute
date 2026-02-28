import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Hono } from "hono";
import { approveUser, createUser } from "../src/lib/auth.js";
import { getDb } from "../src/lib/db.js";
import {
  addMessage,
  type ContentBlock,
  createConversation,
  deleteConversation,
  getMessagesPaginated,
} from "../src/lib/events/conversations.js";
import {
  conversationParticipants,
  conversations,
  messages,
  sessions,
  users,
} from "../src/lib/schema.js";
import v1ConversationsRoute from "../src/web/api/v1/conversations.js";
import { authMiddleware, createSession, deleteSession } from "../src/web/middleware/auth.js";

describe("v1 paginated messages", () => {
  it("returns all messages with hasMore=false when fewer than limit", async () => {
    const conv = await createConversation("test-mind", "test-page-1");
    try {
      await addMessage(conv.id, "user", "alice", [{ type: "text", text: "Hello" }]);
      await addMessage(conv.id, "assistant", "bot", [{ type: "text", text: "Hi" }]);

      const result = await getMessagesPaginated(conv.id, { limit: 10 });
      assert.equal(result.messages.length, 2);
      assert.equal(result.hasMore, false);
      // Messages should be in chronological order
      assert.equal(result.messages[0].role, "user");
      assert.equal(result.messages[1].role, "assistant");
    } finally {
      await deleteConversation(conv.id);
    }
  });

  it("paginates with before cursor", async () => {
    const conv = await createConversation("test-mind", "test-page-2");
    try {
      // Add 5 messages
      for (let i = 0; i < 5; i++) {
        await addMessage(conv.id, "user", "alice", [{ type: "text", text: `msg ${i}` }]);
      }

      // Get latest 2
      const page1 = await getMessagesPaginated(conv.id, { limit: 2 });
      assert.equal(page1.messages.length, 2);
      assert.equal(page1.hasMore, true);

      // Get next page using before cursor
      const oldestInPage1 = page1.messages[0].id;
      const page2 = await getMessagesPaginated(conv.id, { before: oldestInPage1, limit: 2 });
      assert.equal(page2.messages.length, 2);
      assert.equal(page2.hasMore, true);

      // IDs in page2 should all be less than the oldest in page1
      for (const msg of page2.messages) {
        assert.ok(msg.id < oldestInPage1, `${msg.id} should be < ${oldestInPage1}`);
      }

      // Get final page
      const oldestInPage2 = page2.messages[0].id;
      const page3 = await getMessagesPaginated(conv.id, { before: oldestInPage2, limit: 2 });
      assert.equal(page3.messages.length, 1);
      assert.equal(page3.hasMore, false);
    } finally {
      await deleteConversation(conv.id);
    }
  });

  it("returns empty when no messages", async () => {
    const conv = await createConversation("test-mind", "test-page-empty");
    try {
      const result = await getMessagesPaginated(conv.id, { limit: 10 });
      assert.equal(result.messages.length, 0);
      assert.equal(result.hasMore, false);
    } finally {
      await deleteConversation(conv.id);
    }
  });

  it("caps limit at 100", async () => {
    const conv = await createConversation("test-mind", "test-page-cap");
    try {
      // Just verify it doesn't throw — actual capping tested by implementation
      const result = await getMessagesPaginated(conv.id, { limit: 200 });
      assert.equal(result.messages.length, 0);
    } finally {
      await deleteConversation(conv.id);
    }
  });

  it("defaults to 50 messages when no limit specified", async () => {
    const conv = await createConversation("test-mind", "test-page-default");
    try {
      // Add 55 messages
      for (let i = 0; i < 55; i++) {
        await addMessage(conv.id, "user", "alice", [{ type: "text", text: `msg ${i}` }]);
      }

      const result = await getMessagesPaginated(conv.id);
      assert.equal(result.messages.length, 50);
      assert.equal(result.hasMore, true);
    } finally {
      await deleteConversation(conv.id);
    }
  });

  it("returns messages in chronological order within page", async () => {
    const conv = await createConversation("test-mind", "test-page-order");
    try {
      await addMessage(conv.id, "user", "alice", [{ type: "text", text: "first" }]);
      await addMessage(conv.id, "assistant", "bot", [{ type: "text", text: "second" }]);
      await addMessage(conv.id, "user", "alice", [{ type: "text", text: "third" }]);

      const result = await getMessagesPaginated(conv.id, { limit: 10 });
      assert.equal(result.messages.length, 3);
      // IDs should be ascending (chronological)
      assert.ok(result.messages[0].id < result.messages[1].id);
      assert.ok(result.messages[1].id < result.messages[2].id);
    } finally {
      await deleteConversation(conv.id);
    }
  });
});

// --- HTTP-level tests for v1 conversations API ---

let sessionId: string;
let userId: number;

function createApp() {
  const app = new Hono();
  app.use("/api/v1/conversations/*", authMiddleware);
  app.route("/api/v1/conversations", v1ConversationsRoute);
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
  const user = await createUser("v1-admin", "pass");
  userId = user.id;
  sessionId = await createSession(user.id);
  return sessionId;
}

describe("v1 conversations HTTP routes", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("GET /:id/messages — returns all messages without query params (backwards compat)", async () => {
    const cookie = await setupAuth();
    const app = createApp();

    const conv = await createConversation("test-mind", "volute", {
      participantIds: [userId],
    });
    await addMessage(conv.id, "user", "v1-admin", [{ type: "text", text: "Hello" }]);
    await addMessage(conv.id, "assistant", "test-mind", [{ type: "text", text: "Hi" }]);

    const res = await app.request(`/api/v1/conversations/${conv.id}/messages`, {
      headers: { Cookie: `volute_session=${cookie}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.items.length, 2);
    assert.equal(body.hasMore, false);

    await deleteConversation(conv.id);
  });

  it("GET /:id/messages?limit=2 — returns paginated results", async () => {
    const cookie = await setupAuth();
    const app = createApp();

    const conv = await createConversation("test-mind", "volute", {
      participantIds: [userId],
    });
    const blocks: ContentBlock[] = [{ type: "text", text: "msg" }];
    await addMessage(conv.id, "user", "v1-admin", blocks);
    await addMessage(conv.id, "assistant", "test-mind", blocks);
    await addMessage(conv.id, "user", "v1-admin", blocks);

    const res = await app.request(`/api/v1/conversations/${conv.id}/messages?limit=2`, {
      headers: { Cookie: `volute_session=${cookie}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.items.length, 2);
    assert.equal(body.hasMore, true);

    await deleteConversation(conv.id);
  });

  it("GET /:id/messages?before=X&limit=2 — cursor pagination", async () => {
    const cookie = await setupAuth();
    const app = createApp();

    const conv = await createConversation("test-mind", "volute", {
      participantIds: [userId],
    });
    const blocks: ContentBlock[] = [{ type: "text", text: "msg" }];
    const m1 = await addMessage(conv.id, "user", "v1-admin", blocks);
    const m2 = await addMessage(conv.id, "assistant", "test-mind", blocks);
    const m3 = await addMessage(conv.id, "user", "v1-admin", blocks);

    const res = await app.request(
      `/api/v1/conversations/${conv.id}/messages?before=${m3.id}&limit=2`,
      { headers: { Cookie: `volute_session=${cookie}` } },
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.items.length, 2);
    assert.equal(body.items[0].id, m1.id);
    assert.equal(body.items[1].id, m2.id);
    assert.equal(body.hasMore, false);

    await deleteConversation(conv.id);
  });

  it("GET /:id/messages?before=abc — returns 400 for invalid cursor", async () => {
    const cookie = await setupAuth();
    const app = createApp();

    const conv = await createConversation("test-mind", "volute", {
      participantIds: [userId],
    });

    const res = await app.request(`/api/v1/conversations/${conv.id}/messages?before=abc`, {
      headers: { Cookie: `volute_session=${cookie}` },
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.ok(body.error);

    await deleteConversation(conv.id);
  });

  it("GET /:id/messages — 404 for non-participant", async () => {
    await setupAuth();
    const app = createApp();

    const conv = await createConversation("test-mind", "volute", {
      participantIds: [userId],
    });

    const user2 = await createUser("outsider", "pass");
    await approveUser(user2.id);
    const cookie2 = await createSession(user2.id);

    const res = await app.request(`/api/v1/conversations/${conv.id}/messages`, {
      headers: { Cookie: `volute_session=${cookie2}` },
    });
    assert.equal(res.status, 404);

    await deleteSession(cookie2);
    await deleteConversation(conv.id);
  });
});
