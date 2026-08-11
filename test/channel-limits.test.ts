import assert from "node:assert/strict";
import { afterEach, before, beforeEach, describe, it } from "node:test";
import { eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { createUser, getOrCreateMindUser } from "../packages/daemon/src/lib/auth.js";
import { checkChannelLimits } from "../packages/daemon/src/lib/chat/channel-limits.js";
import { listPending as listPendingFiles } from "../packages/daemon/src/lib/chat/file-sharing.js";
import {
  initMindManager,
  tryGetMindManager,
} from "../packages/daemon/src/lib/daemon/mind-manager.js";
import { getDb } from "../packages/daemon/src/lib/db.js";
import {
  addMessage,
  createChannel,
  createConversation,
  deleteConversation,
  getMessages,
  joinChannel,
  updateChannelSettings,
} from "../packages/daemon/src/lib/events/conversations.js";
import { addMind, removeMind } from "../packages/daemon/src/lib/mind/registry.js";
import { messages, users } from "../packages/daemon/src/lib/schema.js";
import { chatApp } from "../packages/daemon/src/web/api/chat.js";
import { authMiddleware, createSession } from "../packages/daemon/src/web/middleware/auth.js";

const TEST_USERNAMES = ["limits-host", "limits-file-mind"];
const CHANNEL = "limits-test";
const FILE_MIND = "limits-file-mind";

let convId: string;

async function cleanup() {
  const db = await getDb();
  if (convId) await deleteConversation(convId).catch(() => {});
  convId = "";
  await removeMind(FILE_MIND).catch(() => {});
  for (const username of TEST_USERNAMES) {
    await db.delete(users).where(eq(users.username, username));
  }
}

/** Post `count` ordinary messages into the channel, as senders would. */
async function postMessages(count: number, sender = "limits-host") {
  for (let i = 0; i < count; i++) {
    await addMessage(convId, "user", sender, [{ type: "text", text: `msg ${i}` }]);
  }
}

/** Backdate every message in the channel by `seconds`, so a window can be aged out. */
async function ageMessages(seconds: number) {
  const db = await getDb();
  await db
    .update(messages)
    .set({ created_at: sql`datetime('now', ${`-${seconds} seconds`})` })
    .where(eq(messages.conversation_id, convId));
}

describe("channel limits", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  describe("checkChannelLimits", () => {
    it("allows anything when the channel sets no limits", async () => {
      const ch = await createChannel(CHANNEL);
      convId = ch.id;
      await postMessages(50);

      const result = await checkChannelLimits({
        conversationId: convId,
        channelName: CHANNEL,
        text: "x".repeat(10_000),
      });
      assert.equal(result, null);
    });

    it("rejects a message longer than the character limit, naming the limit", async () => {
      const ch = await createChannel(CHANNEL, undefined, { charLimit: 20 });
      convId = ch.id;

      assert.equal(
        await checkChannelLimits({
          conversationId: convId,
          channelName: CHANNEL,
          text: "x".repeat(20),
        }),
        null,
        "a message exactly at the limit is allowed",
      );

      const rejected = await checkChannelLimits({
        conversationId: convId,
        channelName: CHANNEL,
        text: "x".repeat(21),
      });
      assert.equal(rejected?.status, 400);
      assert.match(rejected?.error ?? "", /21 characters/);
      assert.match(rejected?.error ?? "", /20 character limit/);
    });

    it("rejects once the window is full, and reports when it frees up", async () => {
      const ch = await createChannel(CHANNEL, undefined, { rateLimit: 3, rateWindow: 60 });
      convId = ch.id;

      await postMessages(2);
      assert.equal(
        await checkChannelLimits({ conversationId: convId, channelName: CHANNEL, text: "hi" }),
        null,
        "under the limit, the send is allowed",
      );

      await postMessages(1); // now 3 in the window
      const rejected = await checkChannelLimits({
        conversationId: convId,
        channelName: CHANNEL,
        text: "hi",
      });
      assert.equal(rejected?.status, 429);
      assert.match(rejected?.error ?? "", /3 messages per 60s/);
      // The retry hint is bounded by the window and never reads as "0s".
      const retry = Number(/Try again in (\d+)s/.exec(rejected?.error ?? "")?.[1]);
      assert.ok(retry >= 1 && retry <= 60, `retry-after ${retry} should be within the window`);
    });

    it("counts the channel as a whole, not per sender", async () => {
      const ch = await createChannel(CHANNEL, undefined, { rateLimit: 2, rateWindow: 60 });
      convId = ch.id;

      await postMessages(1, "alice");
      await postMessages(1, "bob");

      const rejected = await checkChannelLimits({
        conversationId: convId,
        channelName: CHANNEL,
        text: "hi",
      });
      assert.equal(rejected?.status, 429, "a third sender is still blocked by the pooled budget");
    });

    it("lets messages older than the window fall out of it", async () => {
      const ch = await createChannel(CHANNEL, undefined, { rateLimit: 2, rateWindow: 30 });
      convId = ch.id;

      await postMessages(2);
      assert.equal(
        (await checkChannelLimits({ conversationId: convId, channelName: CHANNEL, text: "hi" }))
          ?.status,
        429,
      );

      // Age them past the window: the budget is free again.
      await ageMessages(31);
      assert.equal(
        await checkChannelLimits({ conversationId: convId, channelName: CHANNEL, text: "hi" }),
        null,
      );
    });

    it("does not spend the budget on anything the environment wrote", async () => {
      const ch = await createChannel(CHANNEL, undefined, { rateLimit: 2, rateWindow: 60 });
      convId = ch.id;

      // Invite notices use role "system" (channels.ts) and commons announcements use role
      // "event" (commons-channel.ts). Neither was said by anyone, so neither may spend a
      // budget meant for speech — otherwise a channel rate-limits itself into silence.
      await addMessage(convId, "system", "system", [{ type: "text", text: "a joined" }]);
      await addMessage(convId, "system", "system", [{ type: "text", text: "b joined" }]);
      await addMessage(convId, "event", null, [{ type: "text", text: "mimsy published a page" }]);
      await addMessage(convId, "event", null, [{ type: "text", text: "bardo joined the commons" }]);
      await addMessage(convId, "event", null, [{ type: "text", text: "a page was archived" }]);

      assert.equal(
        await checkChannelLimits({ conversationId: convId, channelName: CHANNEL, text: "hi" }),
        null,
      );

      // One real message still counts, and the second fills the window.
      await postMessages(2);
      assert.equal(
        (await checkChannelLimits({ conversationId: convId, channelName: CHANNEL, text: "hi" }))
          ?.status,
        429,
      );
    });

    it("reads timestamps as UTC, not local time", async () => {
      const ch = await createChannel(CHANNEL, undefined, { rateLimit: 1, rateWindow: 60 });
      convId = ch.id;
      await postMessages(1);

      // datetime('now') stores zone-less UTC. Parsed as local time, a host west of UTC
      // would see the message as hours in the future (never rejected — the elapsed time is
      // negative) and one east of UTC would see it as hours old (never rejected either).
      // Either way the limit would quietly stop working; it must reject here.
      const rejected = await checkChannelLimits({
        conversationId: convId,
        channelName: CHANNEL,
        text: "hi",
      });
      assert.equal(rejected?.status, 429, "a just-posted message must count as inside the window");
    });

    it("allows the send when the channel has no settings row", async () => {
      const ch = await createChannel(CHANNEL, undefined, { charLimit: 5 });
      convId = ch.id;

      // Nothing is known about a channel by this name — fail open rather than
      // letting a lookup miss silence a channel.
      const result = await checkChannelLimits({
        conversationId: convId,
        channelName: "no-such-channel",
        text: "x".repeat(500),
      });
      assert.equal(result, null);
    });

    it("ignores a rate limit whose window is missing", async () => {
      const ch = await createChannel(CHANNEL);
      convId = ch.id;
      // The API refuses a half-set pair, but a row could still be reached this way; a
      // count with no window has no meaning, so it must not block anything.
      await updateChannelSettings(CHANNEL, { rateLimit: 1 });
      await postMessages(5);

      assert.equal(
        await checkChannelLimits({ conversationId: convId, channelName: CHANNEL, text: "hi" }),
        null,
      );
    });
  });

  describe("POST /api/v1/chat enforcement", () => {
    // An allowed send fans out to mind participants, which needs the manager to exist.
    // There are no minds in these channels, so it has nothing to do beyond being present.
    before(() => {
      if (!tryGetMindManager()) initMindManager();
    });

    function createApp() {
      const app = new Hono();
      app.use("/api/v1/*", authMiddleware);
      app.route("/api/v1/chat", chatApp);
      return app;
    }

    async function send(cookie: string, message: string) {
      return createApp().request("/api/v1/chat", {
        method: "POST",
        headers: { Cookie: `volute_session=${cookie}`, "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId: convId, message }),
      });
    }

    it("holds a human sender to the channel's character limit", async () => {
      const host = await createUser("limits-host", "pass");
      const cookie = await createSession(host.id);
      const ch = await createChannel(CHANNEL, host.id, { charLimit: 10 });
      convId = ch.id;

      const rejected = await send(cookie, "x".repeat(11));
      assert.equal(rejected.status, 400, "the limit is not mind-only — it applies to everyone");
      assert.match((await rejected.json()).error, /10 character limit/);
      assert.equal((await getMessages(convId)).length, 0, "nothing was persisted");

      const ok = await send(cookie, "x".repeat(10));
      assert.equal(ok.status, 200);
      assert.equal((await getMessages(convId)).length, 1);
    });

    it("holds a human sender to the channel's rate limit", async () => {
      const host = await createUser("limits-host", "pass");
      const cookie = await createSession(host.id);
      const ch = await createChannel(CHANNEL, host.id, { rateLimit: 2, rateWindow: 60 });
      convId = ch.id;

      assert.equal((await send(cookie, "one")).status, 200);
      assert.equal((await send(cookie, "two")).status, 200);

      const rejected = await send(cookie, "three");
      assert.equal(rejected.status, 429);
      assert.match((await rejected.json()).error, /rate limited/);
      assert.equal((await getMessages(convId)).length, 2, "the third was not persisted");
    });

    it("does not stage attached files for a message the limit refuses", async () => {
      const host = await createUser("limits-host", "pass");
      const cookie = await createSession(host.id);
      await addMind(FILE_MIND, 4399);
      const mindUser = await getOrCreateMindUser(FILE_MIND);
      const ch = await createChannel(CHANNEL, host.id, { charLimit: 10 });
      convId = ch.id;
      await joinChannel(convId, mindUser.id);

      const res = await createApp().request("/api/v1/chat", {
        method: "POST",
        headers: { Cookie: `volute_session=${cookie}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          conversationId: convId,
          message: "x".repeat(50),
          files: [{ filename: "notes.txt", data: Buffer.from("hello").toString("base64") }],
        }),
      });

      assert.equal(res.status, 400);
      // Staging runs per recipient mind and persists a pending offer. Checking the limit after
      // it would leave the mind holding an offer for a message that was never sent — and each
      // retry would stage another copy.
      assert.equal(listPendingFiles(FILE_MIND).length, 0, "a refused message must not stage files");
      assert.equal((await getMessages(convId)).length, 0);
    });

    it("leaves DMs unlimited", async () => {
      const host = await createUser("limits-host", "pass");
      const cookie = await createSession(host.id);

      // A strict channel exists, but this send goes to a DM — a conversation with no channel
      // row, so no channel's limits apply to it.
      const ch = await createChannel(CHANNEL, host.id, { charLimit: 5, rateLimit: 1 });
      const dm = await createConversation({ participantIds: [host.id] });
      convId = dm.id;

      const res = await send(cookie, "x".repeat(500));
      assert.equal(res.status, 200);

      await deleteConversation(ch.id);
    });
  });
});
