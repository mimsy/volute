import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { and, eq, like } from "drizzle-orm";
import { getOrCreateMindUser } from "../packages/daemon/src/lib/auth.js";
import { initMindManager } from "../packages/daemon/src/lib/daemon/mind-manager.js";
import { getDb } from "../packages/daemon/src/lib/db.js";
import {
  fanOutToMinds,
  MAX_CONSECUTIVE_MIND_TURNS,
  resetLoopCounter,
} from "../packages/daemon/src/lib/delivery/fan-out.js";
import { createConversation } from "../packages/daemon/src/lib/events/conversations.js";
import { messages } from "../packages/daemon/src/lib/schema.js";

// A fresh test-runner process per file, so this singleton is isolated.
try {
  initMindManager();
} catch {
  // already initialized in this process
}

async function makeMindDM(a: string, b: string): Promise<string> {
  const ua = await getOrCreateMindUser(a);
  const ub = await getOrCreateMindUser(b);
  const conv = await createConversation({ participantIds: [ua.id, ub.id] });
  return conv.id;
}

async function noticeCount(conversationId: string): Promise<number> {
  const db = await getDb();
  const rows = await db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.conversation_id, conversationId),
        like(messages.content, "%automated turns%"),
      ),
    );
  return rows.length;
}

async function mindTurn(conversationId: string, sender: string): Promise<void> {
  await fanOutToMinds({
    conversationId,
    contentBlocks: [{ type: "text", text: "ping" }],
    senderName: sender,
    senderIsMind: true,
  });
}

describe("fan-out loop protection", () => {
  it("pauses mind→mind fan-out and emits a notice after N consecutive mind turns", async () => {
    const conv = await makeMindDM("loopA", "loopB");

    // N allowed exchanges, then the (N+1)th pauses and posts a single notice.
    for (let i = 0; i < MAX_CONSECUTIVE_MIND_TURNS; i++) {
      await mindTurn(conv, i % 2 === 0 ? "loopA" : "loopB");
    }
    assert.equal(await noticeCount(conv), 0, "no notice while under the limit");

    await mindTurn(conv, "loopA"); // crosses the threshold
    assert.equal(await noticeCount(conv), 1, "one pause notice emitted at the threshold");

    // Still paused — further mind turns don't spam additional notices.
    await mindTurn(conv, "loopB");
    assert.equal(await noticeCount(conv), 1, "no duplicate notices while paused");
  });

  it("resets the loop counter on human (non-mind) input", async () => {
    const conv = await makeMindDM("loopC", "loopD");

    for (let i = 0; i <= MAX_CONSECUTIVE_MIND_TURNS; i++) {
      await mindTurn(conv, i % 2 === 0 ? "loopC" : "loopD");
    }
    assert.equal(await noticeCount(conv), 1, "paused after the limit");

    // A human message resets the chain...
    await fanOutToMinds({
      conversationId: conv,
      contentBlocks: [{ type: "text", text: "hello minds" }],
      senderName: "human",
      senderIsMind: false,
    });

    // ...so the next batch of mind turns runs again without immediately re-pausing.
    for (let i = 0; i < MAX_CONSECUTIVE_MIND_TURNS; i++) {
      await mindTurn(conv, i % 2 === 0 ? "loopC" : "loopD");
    }
    assert.equal(await noticeCount(conv), 1, "counter reset — no second notice yet");
  });

  it("resetLoopCounter clears a conversation's counter", async () => {
    const conv = await makeMindDM("loopE", "loopF");
    for (let i = 0; i <= MAX_CONSECUTIVE_MIND_TURNS; i++) {
      await mindTurn(conv, "loopE");
    }
    assert.equal(await noticeCount(conv), 1);

    resetLoopCounter(conv);
    for (let i = 0; i < MAX_CONSECUTIVE_MIND_TURNS; i++) {
      await mindTurn(conv, "loopE");
    }
    assert.equal(await noticeCount(conv), 1, "explicit reset prevented a new pause notice");
  });
});
