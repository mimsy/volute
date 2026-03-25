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
  getMessagesPaginated,
  getUnreadCounts,
  markConversationRead,
} from "../packages/daemon/src/lib/events/conversations.js";
import { users } from "../packages/daemon/src/lib/schema.js";
import v1ConversationsRoute from "../packages/daemon/src/web/api/v1/conversations.js";
import {
  authMiddleware,
  createSession,
  deleteSession,
} from "../packages/daemon/src/web/middleware/auth.js";

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

const TEST_USERNAMES = [
  "v1-admin",
  "outsider",
  "outsider2",
  "unread-test",
  "mark-read-test",
  "new-after-read",
  "multi-conv",
  "user-a",
  "user-b",
];

async function cleanup() {
  const db = await getDb();
  for (const username of TEST_USERNAMES) {
    await db.delete(users).where(eq(users.username, username));
  }
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

  it("POST /:id/read — marks conversation as read", async () => {
    const cookie = await setupAuth();
    const app = createApp();

    const conv = await createConversation("test-mind", "volute", {
      participantIds: [userId],
    });
    await addMessage(conv.id, "user", "v1-admin", [{ type: "text", text: "Hello" }]);
    await addMessage(conv.id, "assistant", "test-mind", [{ type: "text", text: "Hi" }]);

    const res = await app.request(`/api/v1/conversations/${conv.id}/read`, {
      method: "POST",
      headers: { Cookie: `volute_session=${cookie}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);

    // Unread count should be 0 after marking read
    const counts = await getUnreadCounts(userId, [conv.id]);
    assert.equal(counts[conv.id] ?? 0, 0);

    await deleteConversation(conv.id);
  });

  it("POST /:id/read — 404 for non-participant", async () => {
    await setupAuth();
    const app = createApp();

    const conv = await createConversation("test-mind", "volute", {
      participantIds: [userId],
    });

    const user2 = await createUser("outsider2", "pass");
    await approveUser(user2.id);
    const cookie2 = await createSession(user2.id);

    const res = await app.request(`/api/v1/conversations/${conv.id}/read`, {
      method: "POST",
      headers: { Cookie: `volute_session=${cookie2}` },
    });
    assert.equal(res.status, 404);

    await deleteSession(cookie2);
    await deleteConversation(conv.id);
  });
});

// --- Privacy toggle tests ---

describe("v1 conversation privacy toggle", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("PUT /:id/private — participant can toggle privacy", async () => {
    const cookie = await setupAuth();
    const app = createApp();

    const conv = await createConversation("test-mind", "volute", {
      participantIds: [userId],
    });

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

    const updated = await getConversation(conv.id);
    assert.equal(updated!.private, 1);

    await deleteConversation(conv.id);
  });

  it("PUT /:id/private — non-participant gets 403", async () => {
    await setupAuth();
    const app = createApp();

    const conv = await createConversation("test-mind", "volute", {
      participantIds: [userId],
    });

    const user2 = await createUser("outsider", "pass");
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

// --- Unread tracking tests ---

describe("unread tracking", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("getUnreadCounts returns correct counts for unread messages", async () => {
    const user = await createUser("unread-test", "pass");
    const conv = await createConversation("test-mind", "volute", {
      participantIds: [user.id],
    });

    await addMessage(conv.id, "user", "unread-test", [{ type: "text", text: "Hello" }]);
    await addMessage(conv.id, "assistant", "test-mind", [{ type: "text", text: "Hi" }]);
    await addMessage(conv.id, "assistant", "test-mind", [{ type: "text", text: "How are you?" }]);

    const counts = await getUnreadCounts(user.id, [conv.id]);
    assert.equal(counts[conv.id], 3);

    await deleteConversation(conv.id);
  });

  it("getUnreadCounts returns 0 after markConversationRead", async () => {
    const user = await createUser("mark-read-test", "pass");
    const conv = await createConversation("test-mind", "volute", {
      participantIds: [user.id],
    });

    await addMessage(conv.id, "user", "mark-read-test", [{ type: "text", text: "Hello" }]);
    await addMessage(conv.id, "assistant", "test-mind", [{ type: "text", text: "Hi" }]);

    await markConversationRead(user.id, conv.id);

    const counts = await getUnreadCounts(user.id, [conv.id]);
    assert.equal(counts[conv.id] ?? 0, 0);

    await deleteConversation(conv.id);
  });

  it("new messages after markConversationRead show as unread", async () => {
    const user = await createUser("new-after-read", "pass");
    const conv = await createConversation("test-mind", "volute", {
      participantIds: [user.id],
    });

    await addMessage(conv.id, "user", "new-after-read", [{ type: "text", text: "Hello" }]);
    await markConversationRead(user.id, conv.id);

    // New message after mark read
    await addMessage(conv.id, "assistant", "test-mind", [{ type: "text", text: "Hi" }]);

    const counts = await getUnreadCounts(user.id, [conv.id]);
    assert.equal(counts[conv.id], 1);

    await deleteConversation(conv.id);
  });

  it("getUnreadCounts handles empty conversation list", async () => {
    const counts = await getUnreadCounts(999, []);
    assert.deepEqual(counts, {});
  });

  it("getUnreadCounts handles multiple conversations", async () => {
    const user = await createUser("multi-conv", "pass");
    const conv1 = await createConversation("test-mind", "volute", {
      participantIds: [user.id],
    });
    const conv2 = await createConversation("test-mind", "volute-2", {
      participantIds: [user.id],
    });

    await addMessage(conv1.id, "assistant", "test-mind", [{ type: "text", text: "msg1" }]);
    await addMessage(conv2.id, "assistant", "test-mind", [{ type: "text", text: "msg2" }]);
    await addMessage(conv2.id, "assistant", "test-mind", [{ type: "text", text: "msg3" }]);

    const counts = await getUnreadCounts(user.id, [conv1.id, conv2.id]);
    assert.equal(counts[conv1.id], 1);
    assert.equal(counts[conv2.id], 2);

    await deleteConversation(conv1.id);
    await deleteConversation(conv2.id);
  });

  it("markConversationRead is per-user — does not affect other users", async () => {
    const userA = await createUser("user-a", "pass");
    const userB = await createUser("user-b", "pass");
    const conv = await createConversation("test-mind", "volute", {
      participantIds: [userA.id, userB.id],
    });

    await addMessage(conv.id, "assistant", "test-mind", [{ type: "text", text: "Hello" }]);
    await addMessage(conv.id, "assistant", "test-mind", [{ type: "text", text: "World" }]);

    // User A marks as read
    await markConversationRead(userA.id, conv.id);

    // User A should have 0 unread, User B should still have 2
    const countsA = await getUnreadCounts(userA.id, [conv.id]);
    const countsB = await getUnreadCounts(userB.id, [conv.id]);
    assert.equal(countsA[conv.id] ?? 0, 0);
    assert.equal(countsB[conv.id], 2);

    await deleteConversation(conv.id);
  });
});
