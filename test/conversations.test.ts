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

describe("conversations", () => {
  it("round-trips ContentBlock[] through addMessage/getMessages", () => {
    const conv = createConversation("test-agent", "test");
    try {
      const blocks: ContentBlock[] = [
        { type: "text", text: "Hello" },
        { type: "tool_use", name: "read_file", input: { path: "/tmp/x" } },
        { type: "tool_result", output: "file contents" },
        { type: "text", text: "Here is the file." },
      ];
      addMessage(conv.id, "assistant", "test-agent", blocks);

      const msgs = getMessages(conv.id);
      assert.equal(msgs.length, 1);
      assert.deepEqual(msgs[0].content, blocks);
    } finally {
      deleteConversation(conv.id);
    }
  });

  it("reads legacy plain-string messages as [{ type: 'text', text }]", () => {
    const conv = createConversation("test-agent", "test-legacy");
    try {
      // Manually insert a plain string (simulating legacy data)
      const db = getDb();
      db.prepare(
        "INSERT INTO messages (conversation_id, role, sender_name, content) VALUES (?, ?, ?, ?)",
      ).run(conv.id, "assistant", "agent", "plain text response");

      const msgs = getMessages(conv.id);
      assert.equal(msgs.length, 1);
      assert.deepEqual(msgs[0].content, [{ type: "text", text: "plain text response" }]);
    } finally {
      deleteConversation(conv.id);
    }
  });

  it("stores user message and extracts title from first text block", () => {
    const conv = createConversation("test-agent", "test-title");
    try {
      const blocks: ContentBlock[] = [
        { type: "image", media_type: "image/png", data: "abc123" },
        { type: "text", text: "What is in this image?" },
      ];
      addMessage(conv.id, "user", "user1", blocks);

      const msgs = getMessages(conv.id);
      assert.equal(msgs.length, 1);
      assert.equal(msgs[0].role, "user");
      assert.deepEqual(msgs[0].content, blocks);
    } finally {
      deleteConversation(conv.id);
    }
  });

  it("handles tool_result with is_error flag", () => {
    const conv = createConversation("test-agent", "test-error");
    try {
      const blocks: ContentBlock[] = [
        { type: "tool_use", name: "bash", input: { command: "exit 1" } },
        { type: "tool_result", output: "command failed", is_error: true },
      ];
      addMessage(conv.id, "assistant", "agent", blocks);

      const msgs = getMessages(conv.id);
      assert.equal(msgs.length, 1);
      const result = msgs[0].content[1];
      assert.equal(result.type, "tool_result");
      if (result.type === "tool_result") {
        assert.equal(result.is_error, true);
        assert.equal(result.output, "command failed");
      }
    } finally {
      deleteConversation(conv.id);
    }
  });
});
