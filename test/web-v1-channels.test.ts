import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { createUser, getOrCreateMindUser } from "../packages/daemon/src/lib/auth.js";
import { getDb } from "../packages/daemon/src/lib/db.js";
import {
  createChannel,
  deleteConversation,
  getChannelSettings,
  getMessages,
  getParticipants,
} from "../packages/daemon/src/lib/events/conversations.js";
import { users } from "../packages/daemon/src/lib/schema.js";
import channelsRoute from "../packages/daemon/src/web/api/volute/channels.js";
import { authMiddleware, createSession } from "../packages/daemon/src/web/middleware/auth.js";

const TEST_USERNAMES = ["ch-admin", "bob", "test-mind"];

let sessionId: string;
let userId: number;

function createApp() {
  const app = new Hono();
  app.use("/api/v1/channels/*", authMiddleware);
  app.route("/api/v1/channels", channelsRoute);
  return app;
}

async function cleanup() {
  const db = await getDb();
  for (const username of TEST_USERNAMES) {
    await db.delete(users).where(eq(users.username, username));
  }
}

async function setupAuth() {
  const user = await createUser("ch-admin", "pass");
  userId = user.id;
  sessionId = await createSession(user.id);
  return sessionId;
}

describe("web v1 channels routes", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("GET /api/v1/channels — lists channels with isMember and participantCount", async () => {
    const cookie = await setupAuth();
    const app = createApp();

    // Create a channel with the user as creator (auto-joined)
    const ch = await createChannel("general", userId);

    const res = await app.request("/api/v1/channels", {
      headers: { Cookie: `volute_session=${cookie}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body));
    assert.equal(body.length, 1);
    assert.equal(body[0].channel_name, "general");
    assert.equal(body[0].participantCount, 1);
    assert.equal(body[0].isMember, true);

    await deleteConversation(ch.id);
  });

  it("GET /api/v1/channels — isMember false when not joined", async () => {
    const cookie = await setupAuth();
    const app = createApp();

    // Create a channel without the current user
    const ch = await createChannel("private");

    const res = await app.request("/api/v1/channels", {
      headers: { Cookie: `volute_session=${cookie}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.length, 1);
    assert.equal(body[0].isMember, false);
    assert.equal(body[0].participantCount, 0);

    await deleteConversation(ch.id);
  });

  it("POST /api/v1/channels — creates channel (201)", async () => {
    const cookie = await setupAuth();
    const app = createApp();

    const res = await app.request("/api/v1/channels", {
      method: "POST",
      headers: {
        Cookie: `volute_session=${cookie}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "dev" }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.type, "channel");
    assert.equal(body.channel_name, "dev");

    await deleteConversation(body.id);
  });

  it("POST /api/v1/channels — 409 for duplicate name", async () => {
    const cookie = await setupAuth();
    const app = createApp();

    await createChannel("duped", userId);

    const res = await app.request("/api/v1/channels", {
      method: "POST",
      headers: {
        Cookie: `volute_session=${cookie}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "duped" }),
    });
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.ok(body.error);
  });

  it("POST /api/v1/channels — 400 for invalid name", async () => {
    const cookie = await setupAuth();
    const app = createApp();

    // Uppercase
    let res = await app.request("/api/v1/channels", {
      method: "POST",
      headers: {
        Cookie: `volute_session=${cookie}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "MyChannel" }),
    });
    assert.equal(res.status, 400);

    // Starts with hyphen
    res = await app.request("/api/v1/channels", {
      method: "POST",
      headers: {
        Cookie: `volute_session=${cookie}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "-bad" }),
    });
    assert.equal(res.status, 400);

    // Special characters
    res = await app.request("/api/v1/channels", {
      method: "POST",
      headers: {
        Cookie: `volute_session=${cookie}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "no spaces!" }),
    });
    assert.equal(res.status, 400);
  });

  it("POST /:name/join — joins channel, returns conversationId", async () => {
    const cookie = await setupAuth();
    const app = createApp();

    const ch = await createChannel("joinable");

    const res = await app.request("/api/v1/channels/joinable/join", {
      method: "POST",
      headers: { Cookie: `volute_session=${cookie}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.conversationId, ch.id);

    // Verify user is now a participant
    const participants = await getParticipants(ch.id);
    assert.ok(participants.some((p) => p.userId === userId));

    await deleteConversation(ch.id);
  });

  it("POST /:name/join — 404 for nonexistent channel", async () => {
    const cookie = await setupAuth();
    const app = createApp();

    const res = await app.request("/api/v1/channels/nope/join", {
      method: "POST",
      headers: { Cookie: `volute_session=${cookie}` },
    });
    assert.equal(res.status, 404);
  });

  it("POST /:name/leave — leaves channel", async () => {
    const cookie = await setupAuth();
    const app = createApp();

    const ch = await createChannel("leavable", userId);

    // Verify initially a member
    let participants = await getParticipants(ch.id);
    assert.ok(participants.some((p) => p.userId === userId));

    const res = await app.request("/api/v1/channels/leavable/leave", {
      method: "POST",
      headers: { Cookie: `volute_session=${cookie}` },
    });
    assert.equal(res.status, 200);

    // Verify no longer a member
    participants = await getParticipants(ch.id);
    assert.ok(!participants.some((p) => p.userId === userId));

    await deleteConversation(ch.id);
  });

  it("GET /:name/members — lists members after join", async () => {
    const cookie = await setupAuth();
    const app = createApp();

    const ch = await createChannel("members-test", userId);

    const res = await app.request("/api/v1/channels/members-test/members", {
      headers: { Cookie: `volute_session=${cookie}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body));
    assert.equal(body.length, 1);
    assert.equal(body[0].username, "ch-admin");

    await deleteConversation(ch.id);
  });

  it("POST /:name/invite — invites user to channel", async () => {
    const cookie = await setupAuth();
    const app = createApp();

    const ch = await createChannel("team", userId);
    const invitee = await createUser("bob", "pass");

    const res = await app.request("/api/v1/channels/team/invite", {
      method: "POST",
      headers: {
        Cookie: `volute_session=${cookie}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ username: "bob" }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);

    // Verify bob is now a participant
    const participants = await getParticipants(ch.id);
    assert.ok(participants.some((p) => p.userId === invitee.id));

    // Verify system message was posted
    const msgs = await getMessages(ch.id);
    assert.ok(
      msgs.some((m) => m.role === "system" && JSON.stringify(m.content).includes("invited bob")),
    );

    await deleteConversation(ch.id);
  });

  it("POST /:name/invite — invites mind user to channel", async () => {
    const cookie = await setupAuth();
    const app = createApp();

    const ch = await createChannel("minds-ch", userId);
    // Create a mind user directly (simulating a registered mind)
    const mindUser = await getOrCreateMindUser("test-mind");

    const res = await app.request("/api/v1/channels/minds-ch/invite", {
      method: "POST",
      headers: {
        Cookie: `volute_session=${cookie}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ username: "test-mind" }),
    });
    assert.equal(res.status, 200);

    const participants = await getParticipants(ch.id);
    assert.ok(participants.some((p) => p.userId === mindUser.id));

    await deleteConversation(ch.id);
  });

  it("POST /:name/invite — 409 when already a member", async () => {
    const cookie = await setupAuth();
    const app = createApp();

    // Create channel with admin already as member
    const ch = await createChannel("solo", userId);

    const res = await app.request("/api/v1/channels/solo/invite", {
      method: "POST",
      headers: {
        Cookie: `volute_session=${cookie}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ username: "ch-admin" }),
    });
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.error, "Already a member");

    await deleteConversation(ch.id);
  });

  it("POST /:name/invite — 404 for nonexistent channel", async () => {
    const cookie = await setupAuth();
    const app = createApp();

    const res = await app.request("/api/v1/channels/nope/invite", {
      method: "POST",
      headers: {
        Cookie: `volute_session=${cookie}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ username: "someone" }),
    });
    assert.equal(res.status, 404);
  });

  it("POST /:name/invite — 404 for nonexistent user", async () => {
    const cookie = await setupAuth();
    const app = createApp();

    const ch = await createChannel("inv-test", userId);

    const res = await app.request("/api/v1/channels/inv-test/invite", {
      method: "POST",
      headers: {
        Cookie: `volute_session=${cookie}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ username: "ghost" }),
    });
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.error, "User not found");

    await deleteConversation(ch.id);
  });

  it("POST /api/v1/channels — creates channel with settings", async () => {
    const cookie = await setupAuth();
    const app = createApp();

    const res = await app.request("/api/v1/channels", {
      method: "POST",
      headers: {
        Cookie: `volute_session=${cookie}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "configured",
        description: "A test channel",
        rules: "Be concise",
        charLimit: 500,
        private: true,
      }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.channel_name, "configured");

    const settings = await getChannelSettings("configured");
    assert.ok(settings);
    assert.equal(settings.description, "A test channel");
    assert.equal(settings.rules, "Be concise");
    assert.equal(settings.char_limit, 500);
    assert.equal(settings.private, 1);

    await deleteConversation(body.id);
  });

  it("GET /:name — includes settings", async () => {
    const cookie = await setupAuth();
    const app = createApp();

    const ch = await createChannel("with-settings", userId, {
      description: "Test desc",
      charLimit: 200,
    });

    const res = await app.request("/api/v1/channels/with-settings", {
      headers: { Cookie: `volute_session=${cookie}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.settings);
    assert.equal(body.settings.description, "Test desc");
    assert.equal(body.settings.charLimit, 200);
    assert.equal(body.settings.rules, null);

    await deleteConversation(ch.id);
  });

  it("PATCH /:name — updates channel settings", async () => {
    const cookie = await setupAuth();
    const app = createApp();

    const ch = await createChannel("patchable", userId);

    const res = await app.request("/api/v1/channels/patchable", {
      method: "PATCH",
      headers: {
        Cookie: `volute_session=${cookie}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        description: "Updated desc",
        charLimit: 1000,
        private: true,
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.settings.description, "Updated desc");
    assert.equal(body.settings.charLimit, 1000);
    assert.equal(body.settings.private, true);

    // Verify partial updates don't clobber other fields
    const res2 = await app.request("/api/v1/channels/patchable", {
      method: "PATCH",
      headers: {
        Cookie: `volute_session=${cookie}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ rules: "Be brief" }),
    });
    assert.equal(res2.status, 200);
    const body2 = await res2.json();
    assert.equal(body2.settings.rules, "Be brief");
    assert.equal(body2.settings.description, "Updated desc");
    assert.equal(body2.settings.charLimit, 1000);

    await deleteConversation(ch.id);
  });

  it("PATCH /:name — 404 for nonexistent channel", async () => {
    const cookie = await setupAuth();
    const app = createApp();

    const res = await app.request("/api/v1/channels/nope", {
      method: "PATCH",
      headers: {
        Cookie: `volute_session=${cookie}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ description: "test" }),
    });
    assert.equal(res.status, 404);
  });

  it("requires auth — 401 without cookie", async () => {
    const app = createApp();
    const res = await app.request("/api/v1/channels");
    assert.equal(res.status, 401);
  });
});
