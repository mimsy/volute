import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { getOrCreateMindUser, getOrCreateSystemUser } from "../packages/daemon/src/lib/auth.js";
import { resetSystemDMCache } from "../packages/daemon/src/lib/chat/system-chat.js";
import {
  initMindManager,
  tryGetMindManager,
} from "../packages/daemon/src/lib/daemon/mind-manager.js";
import {
  generateMindToken,
  revokeMindToken,
} from "../packages/daemon/src/lib/daemon/mind-tokens.js";
import { clearMind, createTurn } from "../packages/daemon/src/lib/daemon/turn-tracker.js";
import { getDb } from "../packages/daemon/src/lib/db.js";
import { createConversation } from "../packages/daemon/src/lib/events/conversations.js";
import { addMind, addSpirit } from "../packages/daemon/src/lib/mind/registry.js";
import {
  conversations,
  messages,
  mindHistory,
  minds,
  turns,
  users,
} from "../packages/daemon/src/lib/schema.js";
import { invalidateMindUserCache } from "../packages/daemon/src/web/middleware/auth.js";

const TARGET_MIND = "chat-spirit-target";
const TEST_USERNAMES = ["volute", TARGET_MIND];

let convId: string;

async function cleanup() {
  resetSystemDMCache();
  revokeMindToken("volute");
  // Drop any in-memory active turn so a prior test can't leak turn attribution.
  await clearMind("volute");
  const db = await getDb();
  if (convId) {
    await db.delete(messages).where(eq(messages.conversation_id, convId));
    await db.delete(conversations).where(eq(conversations.id, convId));
  }
  await db.delete(mindHistory).where(eq(mindHistory.mind, "volute"));
  await db.delete(turns).where(eq(turns.mind, "volute"));
  for (const username of TEST_USERNAMES) {
    await db.delete(users).where(eq(users.username, username));
  }
  await db.delete(minds).where(eq(minds.name, "volute"));
  await db.delete(minds).where(eq(minds.name, TARGET_MIND));
}

/**
 * Set up the spirit ("volute", which reuses the shared system user), a target
 * mind, and a two-party DM conversation between them. Returns the spirit's mind
 * token for authenticating a send.
 */
async function setupSpiritDM(): Promise<{ token: string; conversationId: string }> {
  // fan-out (invoked by the chat handler) needs a MindManager instance.
  if (!tryGetMindManager()) initMindManager();

  const systemUser = await getOrCreateSystemUser();
  await addSpirit("volute", 4099, "claude", "/tmp/volute-spirit-sender-test");

  const targetUser = await getOrCreateMindUser(TARGET_MIND);
  await addMind(TARGET_MIND, 4177);

  // Drop any cached "volute" user from a prior test so auth resolves the freshly
  // created system user (its id must match the conversation participant).
  invalidateMindUserCache("volute");

  const conv = await createConversation({
    participantIds: [systemUser.id, targetUser.id],
  });
  convId = conv.id;

  const token = generateMindToken("volute");
  return { token, conversationId: conv.id };
}

function spiritSend(app: { request: typeof fetch }, token: string, body: unknown) {
  return app.request("http://localhost/api/v1/chat", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Origin: "http://localhost",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  } as RequestInit);
}

describe("spirit as a mind sender via POST /api/v1/chat", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("records the spirit's outbound in its own mind_history", async () => {
    const { token, conversationId } = await setupSpiritDM();
    const { default: app } = await import("../packages/daemon/src/web/app.js");

    const res = await spiritSend(app as never, token, {
      conversationId,
      message: "hello from the spirit",
    });
    assert.equal(res.status, 200);

    const db = await getDb();
    const rows = await db.select().from(mindHistory).where(eq(mindHistory.mind, "volute")).all();
    const outbound = rows.find(
      (r) => r.type === "outbound" && r.content?.includes("hello from the spirit"),
    );
    assert.ok(outbound, "spirit send should be recorded as an outbound in mind_history");
  });

  it("runs the mind-sender escape fix on the spirit's message", async () => {
    const { token, conversationId } = await setupSpiritDM();
    const { default: app } = await import("../packages/daemon/src/web/app.js");

    // fixModelEscapes turns "\!" into "!" for mind senders only. If the spirit
    // were still misclassified as a non-mind sender, this fix would be skipped.
    const res = await spiritSend(app as never, token, {
      conversationId,
      message: "warning\\! done",
    });
    assert.equal(res.status, 200);

    const db = await getDb();
    const msgs = await db
      .select()
      .from(messages)
      .where(eq(messages.conversation_id, conversationId))
      .all();
    const send = msgs.find((m) => m.sender_name === "volute");
    assert.ok(send, "the spirit's message should be persisted");
    assert.ok(send!.content.includes("warning! done"), "escape fix should have run");
    assert.ok(!send!.content.includes("warning\\! done"), "raw escape should not survive");
  });

  it("attributes the spirit's outbound to its active turn", async () => {
    const { token, conversationId } = await setupSpiritDM();
    const { default: app } = await import("../packages/daemon/src/web/app.js");

    // Open a sessionless turn for the spirit (keyed `volute:*`). getActiveTurnId
    // falls back to it when the send carries no X-Volute-Session header, so the
    // outbound must be tagged with this turn — the attribution that was skipped
    // entirely while the spirit was misclassified as a non-mind sender.
    const turnId = await createTurn("volute");
    assert.ok(turnId, "createTurn should return a turn id");

    const res = await spiritSend(app as never, token, {
      conversationId,
      message: "tagged reply",
    });
    assert.equal(res.status, 200);

    const db = await getDb();
    const rows = await db.select().from(mindHistory).where(eq(mindHistory.mind, "volute")).all();
    const outbound = rows.find((r) => r.type === "outbound" && r.content?.includes("tagged reply"));
    assert.ok(outbound, "spirit send should be recorded as an outbound");
    assert.equal(outbound!.turn_id, turnId, "outbound should carry the active turn's id");

    // Exactly one reply — the send itself, no fallback loop even with a turn active.
    const msgs = await db
      .select()
      .from(messages)
      .where(eq(messages.conversation_id, conversationId))
      .all();
    const voluteMsgs = msgs.filter((m) => m.sender_name === "volute");
    assert.equal(
      voluteMsgs.length,
      1,
      "only the spirit's send should exist — no fallback even with a turn open",
    );
  });

  it("does not trigger a system self-reply loop on the spirit's own send", async () => {
    const { token, conversationId } = await setupSpiritDM();
    const { default: app } = await import("../packages/daemon/src/web/app.js");

    const res = await spiritSend(app as never, token, {
      conversationId,
      message: "anyone there?",
    });
    assert.equal(res.status, 200);

    // The spirit shares the system user, so the DM has a system-user participant.
    // The self-reply guard (senderIsNotSpirit) must keep generateSystemFallbackReply
    // from firing — otherwise the system would "reply" to the spirit as itself,
    // and the spirit would answer forever.
    const db = await getDb();
    const msgs = await db
      .select()
      .from(messages)
      .where(eq(messages.conversation_id, conversationId))
      .all();
    const voluteMsgs = msgs.filter((m) => m.sender_name === "volute");
    assert.equal(voluteMsgs.length, 1, "only the spirit's send should exist — no fallback reply");
    assert.equal(voluteMsgs[0].role, "user", "the single volute message is the send, not a reply");
  });
});
