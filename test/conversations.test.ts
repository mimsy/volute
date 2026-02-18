import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { getOrCreateMindUser } from "../src/lib/auth.js";
import {
  addMessage,
  addParticipant,
  type ContentBlock,
  createConversation,
  deleteConversation,
  findDMConversation,
  getMessages,
  getParticipants,
  isParticipant,
  listConversationsForUser,
  removeParticipant,
} from "../src/lib/conversations.js";
import { getDb } from "../src/lib/db.js";
import { messages, users } from "../src/lib/schema.js";

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

describe("conversation participants", () => {
  it("creates conversation with participants", async () => {
    const db = await getDb();
    // Create test users
    const agentUser = await getOrCreateMindUser("test-agent-p");
    const [humanUser] = await db
      .insert(users)
      .values({ username: "test-human-p", password_hash: "!test", role: "user" })
      .returning({ id: users.id });

    try {
      const conv = await createConversation("test-agent-p", "volute", {
        participantIds: [humanUser.id, agentUser.id],
      });

      const participants = await getParticipants(conv.id);
      assert.equal(participants.length, 2);
      assert.ok(participants.some((p) => p.username === "test-human-p"));
      assert.ok(participants.some((p) => p.username === "test-agent-p"));

      // First participant gets "owner" role
      const owner = participants.find((p) => p.userId === humanUser.id);
      assert.equal(owner?.role, "owner");

      await deleteConversation(conv.id);
    } finally {
      await db.delete(users).where(eq(users.id, humanUser.id));
      await db.delete(users).where(eq(users.id, agentUser.id));
    }
  });

  it("addParticipant / removeParticipant / isParticipant", async () => {
    const db = await getDb();
    const [user1] = await db
      .insert(users)
      .values({ username: "part-test-1", password_hash: "!test", role: "user" })
      .returning({ id: users.id });
    const [user2] = await db
      .insert(users)
      .values({ username: "part-test-2", password_hash: "!test", role: "user" })
      .returning({ id: users.id });

    try {
      const conv = await createConversation("test-agent", "volute");

      // Initially no participants
      assert.equal(await isParticipant(conv.id, user1.id), false);

      // Add participant
      await addParticipant(conv.id, user1.id, "owner");
      assert.equal(await isParticipant(conv.id, user1.id), true);

      // Add another
      await addParticipant(conv.id, user2.id);
      const participants = await getParticipants(conv.id);
      assert.equal(participants.length, 2);

      // Remove one
      await removeParticipant(conv.id, user2.id);
      assert.equal(await isParticipant(conv.id, user2.id), false);
      assert.equal(await isParticipant(conv.id, user1.id), true);

      await deleteConversation(conv.id);
    } finally {
      await db.delete(users).where(eq(users.id, user1.id));
      await db.delete(users).where(eq(users.id, user2.id));
    }
  });

  it("listConversationsForUser returns participant conversations", async () => {
    const db = await getDb();
    const [user1] = await db
      .insert(users)
      .values({ username: "list-test-1", password_hash: "!test", role: "user" })
      .returning({ id: users.id });

    try {
      const conv = await createConversation("test-agent", "volute", {
        participantIds: [user1.id],
      });

      const convs = await listConversationsForUser(user1.id);
      assert.equal(convs.length, 1);
      assert.equal(convs[0].id, conv.id);

      await deleteConversation(conv.id);
    } finally {
      await db.delete(users).where(eq(users.id, user1.id));
    }
  });

  it("getParticipants returns user_type info", async () => {
    const agentUser = await getOrCreateMindUser("agent-type-test");
    const db = await getDb();

    try {
      const conv = await createConversation("agent-type-test", "volute", {
        participantIds: [agentUser.id],
      });

      const participants = await getParticipants(conv.id);
      assert.equal(participants.length, 1);
      assert.equal(participants[0].userType, "mind");

      await deleteConversation(conv.id);
    } finally {
      await db.delete(users).where(eq(users.id, agentUser.id));
    }
  });

  it("findDMConversation finds existing 2-person conversation", async () => {
    const db = await getDb();
    const agentUser = await getOrCreateMindUser("dm-test-agent");
    const [humanUser] = await db
      .insert(users)
      .values({ username: "dm-test-human", password_hash: "!test", role: "user" })
      .returning({ id: users.id });

    try {
      const conv = await createConversation("dm-test-agent", "volute", {
        participantIds: [humanUser.id, agentUser.id],
      });

      const found = await findDMConversation("dm-test-agent", [humanUser.id, agentUser.id]);
      assert.equal(found, conv.id);

      // Reversed order should also find it
      const found2 = await findDMConversation("dm-test-agent", [agentUser.id, humanUser.id]);
      assert.equal(found2, conv.id);

      await deleteConversation(conv.id);
    } finally {
      await db.delete(users).where(eq(users.id, humanUser.id));
      await db.delete(users).where(eq(users.id, agentUser.id));
    }
  });

  it("findDMConversation returns null when no match", async () => {
    const result = await findDMConversation("nonexistent-agent", [999, 998]);
    assert.equal(result, null);
  });

  it("findDMConversation ignores 3+ person conversations", async () => {
    const db = await getDb();
    const agentUser = await getOrCreateMindUser("dm-skip-agent");
    const [user1] = await db
      .insert(users)
      .values({ username: "dm-skip-1", password_hash: "!test", role: "user" })
      .returning({ id: users.id });
    const [user2] = await db
      .insert(users)
      .values({ username: "dm-skip-2", password_hash: "!test", role: "user" })
      .returning({ id: users.id });

    try {
      // Create a 3-person conversation
      const conv = await createConversation("dm-skip-agent", "volute", {
        participantIds: [user1.id, agentUser.id, user2.id],
      });

      // Should not find it as a DM between user1 and agent
      const found = await findDMConversation("dm-skip-agent", [user1.id, agentUser.id]);
      assert.equal(found, null);

      await deleteConversation(conv.id);
    } finally {
      await db.delete(users).where(eq(users.id, user1.id));
      await db.delete(users).where(eq(users.id, user2.id));
      await db.delete(users).where(eq(users.id, agentUser.id));
    }
  });
});
