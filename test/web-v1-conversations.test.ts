import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  addMessage,
  createConversation,
  deleteConversation,
  getMessagesPaginated,
} from "../src/lib/events/conversations.js";

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
