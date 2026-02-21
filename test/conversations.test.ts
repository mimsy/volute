import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { getOrCreateMindUser } from "../src/lib/auth.js";
import {
  addMessage,
  addParticipant,
  type ContentBlock,
  createChannel,
  createConversation,
  deleteConversation,
  findDMConversation,
  getChannelByName,
  getMessages,
  getParticipants,
  isParticipant,
  joinChannel,
  leaveChannel,
  listChannels,
  listConversationsForUser,
  removeParticipant,
} from "../src/lib/conversations.js";
import { getDb } from "../src/lib/db.js";
import { messages, users } from "../src/lib/schema.js";

describe("conversations", () => {
  it("round-trips ContentBlock[] through addMessage/getMessages", async () => {
    const conv = await createConversation("test-mind", "test");
    try {
      const blocks: ContentBlock[] = [
        { type: "text", text: "Hello" },
        { type: "tool_use", name: "read_file", input: { path: "/tmp/x" } },
        { type: "tool_result", output: "file contents" },
        { type: "text", text: "Here is the file." },
      ];
      await addMessage(conv.id, "assistant", "test-mind", blocks);

      const msgs = await getMessages(conv.id);
      assert.equal(msgs.length, 1);
      assert.deepEqual(msgs[0].content, blocks);
    } finally {
      await deleteConversation(conv.id);
    }
  });

  it("reads legacy plain-string messages as [{ type: 'text', text }]", async () => {
    const conv = await createConversation("test-mind", "test-legacy");
    try {
      // Manually insert a plain string (simulating legacy data)
      const db = await getDb();
      await db.insert(messages).values({
        conversation_id: conv.id,
        role: "assistant",
        sender_name: "mind",
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
    const conv = await createConversation("test-mind", "test-title");
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
    const conv = await createConversation("test-mind", "test-error");
    try {
      const blocks: ContentBlock[] = [
        { type: "tool_use", name: "bash", input: { command: "exit 1" } },
        { type: "tool_result", output: "command failed", is_error: true },
      ];
      await addMessage(conv.id, "assistant", "mind", blocks);

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
    const mindUser = await getOrCreateMindUser("test-mind-p");
    const [humanUser] = await db
      .insert(users)
      .values({ username: "test-human-p", password_hash: "!test", role: "user" })
      .returning({ id: users.id });

    try {
      const conv = await createConversation("test-mind-p", "volute", {
        participantIds: [humanUser.id, mindUser.id],
      });

      const participants = await getParticipants(conv.id);
      assert.equal(participants.length, 2);
      assert.ok(participants.some((p) => p.username === "test-human-p"));
      assert.ok(participants.some((p) => p.username === "test-mind-p"));

      // First participant gets "owner" role
      const owner = participants.find((p) => p.userId === humanUser.id);
      assert.equal(owner?.role, "owner");

      await deleteConversation(conv.id);
    } finally {
      await db.delete(users).where(eq(users.id, humanUser.id));
      await db.delete(users).where(eq(users.id, mindUser.id));
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
      const conv = await createConversation("test-mind", "volute");

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
      const conv = await createConversation("test-mind", "volute", {
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
    const mindUser = await getOrCreateMindUser("mind-type-test");
    const db = await getDb();

    try {
      const conv = await createConversation("mind-type-test", "volute", {
        participantIds: [mindUser.id],
      });

      const participants = await getParticipants(conv.id);
      assert.equal(participants.length, 1);
      assert.equal(participants[0].userType, "mind");

      await deleteConversation(conv.id);
    } finally {
      await db.delete(users).where(eq(users.id, mindUser.id));
    }
  });

  it("findDMConversation finds existing 2-person conversation", async () => {
    const db = await getDb();
    const mindUser = await getOrCreateMindUser("dm-test-mind");
    const [humanUser] = await db
      .insert(users)
      .values({ username: "dm-test-human", password_hash: "!test", role: "user" })
      .returning({ id: users.id });

    try {
      const conv = await createConversation("dm-test-mind", "volute", {
        participantIds: [humanUser.id, mindUser.id],
      });

      const found = await findDMConversation("dm-test-mind", [humanUser.id, mindUser.id]);
      assert.equal(found, conv.id);

      // Reversed order should also find it
      const found2 = await findDMConversation("dm-test-mind", [mindUser.id, humanUser.id]);
      assert.equal(found2, conv.id);

      await deleteConversation(conv.id);
    } finally {
      await db.delete(users).where(eq(users.id, humanUser.id));
      await db.delete(users).where(eq(users.id, mindUser.id));
    }
  });

  it("findDMConversation returns null when no match", async () => {
    const result = await findDMConversation("nonexistent-mind", [999, 998]);
    assert.equal(result, null);
  });

  it("findDMConversation ignores 3+ person conversations", async () => {
    const db = await getDb();
    const mindUser = await getOrCreateMindUser("dm-skip-mind");
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
      const conv = await createConversation("dm-skip-mind", "volute", {
        participantIds: [user1.id, mindUser.id, user2.id],
      });

      // Should not find it as a DM between user1 and mind
      const found = await findDMConversation("dm-skip-mind", [user1.id, mindUser.id]);
      assert.equal(found, null);

      await deleteConversation(conv.id);
    } finally {
      await db.delete(users).where(eq(users.id, user1.id));
      await db.delete(users).where(eq(users.id, user2.id));
      await db.delete(users).where(eq(users.id, mindUser.id));
    }
  });
});

describe("channels", () => {
  it("creates a channel with type and name", async () => {
    const db = await getDb();
    const [user] = await db
      .insert(users)
      .values({ username: "ch-creator", password_hash: "!test", role: "user" })
      .returning({ id: users.id });

    try {
      const ch = await createChannel("general", user.id);
      assert.equal(ch.type, "channel");
      assert.equal(ch.name, "general");
      assert.equal(ch.mind_name, null);
      assert.equal(ch.channel, "volute");

      // Creator is a participant
      const parts = await getParticipants(ch.id);
      assert.equal(parts.length, 1);
      assert.equal(parts[0].username, "ch-creator");
      assert.equal(parts[0].role, "owner");

      await deleteConversation(ch.id);
    } finally {
      await db.delete(users).where(eq(users.id, user.id));
    }
  });

  it("getChannelByName finds channel", async () => {
    const ch = await createChannel("dev");
    try {
      const found = await getChannelByName("dev");
      assert.ok(found);
      assert.equal(found!.id, ch.id);
      assert.equal(found!.type, "channel");
    } finally {
      await deleteConversation(ch.id);
    }
  });

  it("getChannelByName returns null for nonexistent", async () => {
    const found = await getChannelByName("nonexistent-ch");
    assert.equal(found, null);
  });

  it("listChannels returns only channels", async () => {
    const ch1 = await createChannel("alpha");
    const ch2 = await createChannel("beta");
    const dm = await createConversation("test-mind", "volute");
    try {
      const channels = await listChannels();
      const names = channels.map((c) => c.name);
      assert.ok(names.includes("alpha"));
      assert.ok(names.includes("beta"));
      // DM should not appear
      assert.ok(!channels.some((c) => c.id === dm.id));
    } finally {
      await deleteConversation(ch1.id);
      await deleteConversation(ch2.id);
      await deleteConversation(dm.id);
    }
  });

  it("joinChannel is idempotent", async () => {
    const db = await getDb();
    const [user] = await db
      .insert(users)
      .values({ username: "ch-joiner", password_hash: "!test", role: "user" })
      .returning({ id: users.id });

    try {
      const ch = await createChannel("join-test");
      await joinChannel(ch.id, user.id);
      await joinChannel(ch.id, user.id); // second call should not throw
      const parts = await getParticipants(ch.id);
      assert.equal(parts.filter((p) => p.userId === user.id).length, 1);
      await deleteConversation(ch.id);
    } finally {
      await db.delete(users).where(eq(users.id, user.id));
    }
  });

  it("leaveChannel removes participant", async () => {
    const db = await getDb();
    const [user] = await db
      .insert(users)
      .values({ username: "ch-leaver", password_hash: "!test", role: "user" })
      .returning({ id: users.id });

    try {
      const ch = await createChannel("leave-test", user.id);
      assert.equal(await isParticipant(ch.id, user.id), true);
      await leaveChannel(ch.id, user.id);
      assert.equal(await isParticipant(ch.id, user.id), false);
      await deleteConversation(ch.id);
    } finally {
      await db.delete(users).where(eq(users.id, user.id));
    }
  });

  it("channel name must be unique", async () => {
    const ch = await createChannel("unique-ch");
    try {
      await assert.rejects(() => createChannel("unique-ch"));
    } finally {
      await deleteConversation(ch.id);
    }
  });

  it("findDMConversation does not match channels", async () => {
    const db = await getDb();
    const mindUser = await getOrCreateMindUser("ch-dm-mind");
    const [human] = await db
      .insert(users)
      .values({ username: "ch-dm-human", password_hash: "!test", role: "user" })
      .returning({ id: users.id });

    try {
      // Create a channel with both as participants
      const ch = await createChannel("dm-test-ch");
      await joinChannel(ch.id, mindUser.id);
      await joinChannel(ch.id, human.id);

      // findDMConversation should not find it
      const found = await findDMConversation("ch-dm-mind", [human.id, mindUser.id]);
      assert.equal(found, null);

      await deleteConversation(ch.id);
    } finally {
      await db.delete(users).where(eq(users.id, human.id));
      await db.delete(users).where(eq(users.id, mindUser.id));
    }
  });
});
