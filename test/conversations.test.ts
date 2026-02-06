import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  addMessage,
  type ContentBlock,
  createConversation,
  deleteConversation,
  getMessages,
} from "../src/lib/conversations.js";
import { getDb } from "../src/lib/db.js";
import { messages } from "../src/lib/schema.js";

describe("conversations", () => {
  it("round-trips ContentBlock[] through addMessage/getMessages", async () => {
    const conv = await createConversation("test-agent", "test");
    try {
      const blocks: ContentBlock[] = [
        { type: "text", text: "Hello" },
        { type: "tool_use", name: "read_file", input: { path: "/tmp/x" } },
        { type: "tool_result", output: "file contents" },
        { type: "text", text: "Here is the file." },
      ];
      await addMessage(conv.id, "assistant", "test-agent", blocks);

      const msgs = await getMessages(conv.id);
      assert.equal(msgs.length, 1);
      assert.deepEqual(msgs[0].content, blocks);
    } finally {
      await deleteConversation(conv.id);
    }
  });

  it("reads legacy plain-string messages as [{ type: 'text', text }]", async () => {
    const conv = await createConversation("test-agent", "test-legacy");
    try {
      // Manually insert a plain string (simulating legacy data)
      const db = await getDb();
      await db.insert(messages).values({
        conversation_id: conv.id,
        role: "assistant",
        sender_name: "agent",
        content: "plain text response",
      });

      const msgs = await getMessages(conv.id);
      assert.equal(msgs.length, 1);
      assert.deepEqual(msgs[0].content, [{ type: "text", text: "plain text response" }]);
    } finally {
      await deleteConversation(conv.id);
    }
  });

  it("stores user message and extracts title from first text block", async () => {
    const conv = await createConversation("test-agent", "test-title");
    try {
      const blocks: ContentBlock[] = [
        { type: "image", media_type: "image/png", data: "abc123" },
        { type: "text", text: "What is in this image?" },
      ];
      await addMessage(conv.id, "user", "user1", blocks);

      const msgs = await getMessages(conv.id);
      assert.equal(msgs.length, 1);
      assert.equal(msgs[0].role, "user");
      assert.deepEqual(msgs[0].content, blocks);
    } finally {
      await deleteConversation(conv.id);
    }
  });

  it("handles tool_result with is_error flag", async () => {
    const conv = await createConversation("test-agent", "test-error");
    try {
      const blocks: ContentBlock[] = [
        { type: "tool_use", name: "bash", input: { command: "exit 1" } },
        { type: "tool_result", output: "command failed", is_error: true },
      ];
      await addMessage(conv.id, "assistant", "agent", blocks);

      const msgs = await getMessages(conv.id);
      assert.equal(msgs.length, 1);
      const result = msgs[0].content[1];
      assert.equal(result.type, "tool_result");
      if (result.type === "tool_result") {
        assert.equal(result.is_error, true);
        assert.equal(result.output, "command failed");
      }
    } finally {
      await deleteConversation(conv.id);
    }
  });
});
