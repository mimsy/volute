import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Hono } from "hono";
import { createUser, getOrCreateMindUser } from "../src/lib/auth.js";
import {
  createChannel,
  deleteConversation,
  getMessages,
  getParticipants,
} from "../src/lib/conversations.js";
import { getDb } from "../src/lib/db.js";
import {
  conversationParticipants,
  conversations,
  messages,
  sessions,
  users,
} from "../src/lib/schema.js";
import channelsRoute from "../src/web/api/volute/channels.js";
import { authMiddleware, createSession } from "../src/web/middleware/auth.js";

let sessionId: string;
let userId: number;

function createApp() {
  const app = new Hono();
  app.use("/api/volute/*", authMiddleware);
  app.route("/api/volute/channels", channelsRoute);
  return app;
}

async function cleanup() {
  const db = await getDb();
  await db.delete(sessions);
  await db.delete(messages);
  await db.delete(conversationParticipants);
  await db.delete(conversations);
  await db.delete(users);
}

async function setupAuth() {
  const user = await createUser("ch-admin", "pass");
  userId = user.id;
  sessionId = await createSession(user.id);
  return sessionId;
}

describe("web volute channels routes", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("GET /api/volute/channels — lists channels with isMember and participantCount", async () => {
    const cookie = await setupAuth();
    const app = createApp();

    // Create a channel with the user as creator (auto-joined)
    const ch = await createChannel("general", userId);

    const res = await app.request("/api/volute/channels", {
      headers: { Cookie: `volute_session=${cookie}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body));
    assert.equal(body.length, 1);
    assert.equal(body[0].name, "general");
    assert.equal(body[0].participantCount, 1);
    assert.equal(body[0].isMember, true);

    await deleteConversation(ch.id);
  });

  it("GET /api/volute/channels — isMember false when not joined", async () => {
    const cookie = await setupAuth();
    const app = createApp();

    // Create a channel without the current user
    const ch = await createChannel("private");

    const res = await app.request("/api/volute/channels", {
      headers: { Cookie: `volute_session=${cookie}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.length, 1);
    assert.equal(body[0].isMember, false);
    assert.equal(body[0].participantCount, 0);

    await deleteConversation(ch.id);
  });

  it("POST /api/volute/channels — creates channel (201)", async () => {
    const cookie = await setupAuth();
    const app = createApp();

    const res = await app.request("/api/volute/channels", {
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
    assert.equal(body.name, "dev");

    await deleteConversation(body.id);
  });

  it("POST /api/volute/channels — 409 for duplicate name", async () => {
    const cookie = await setupAuth();
    const app = createApp();

    await createChannel("duped", userId);

    const res = await app.request("/api/volute/channels", {
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

  it("POST /api/volute/channels — 400 for invalid name", async () => {
    const cookie = await setupAuth();
    const app = createApp();

    // Uppercase
    let res = await app.request("/api/volute/channels", {
      method: "POST",
      headers: {
        Cookie: `volute_session=${cookie}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "MyChannel" }),
    });
    assert.equal(res.status, 400);

    // Starts with hyphen
    res = await app.request("/api/volute/channels", {
      method: "POST",
      headers: {
        Cookie: `volute_session=${cookie}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "-bad" }),
    });
    assert.equal(res.status, 400);

    // Special characters
    res = await app.request("/api/volute/channels", {
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

    const res = await app.request("/api/volute/channels/joinable/join", {
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

    const res = await app.request("/api/volute/channels/nope/join", {
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

    const res = await app.request("/api/volute/channels/leavable/leave", {
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

    const res = await app.request("/api/volute/channels/members-test/members", {
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

    const res = await app.request("/api/volute/channels/team/invite", {
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

    const res = await app.request("/api/volute/channels/minds-ch/invite", {
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

    const res = await app.request("/api/volute/channels/solo/invite", {
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

    const res = await app.request("/api/volute/channels/nope/invite", {
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

    const res = await app.request("/api/volute/channels/inv-test/invite", {
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

  it("requires auth — 401 without cookie", async () => {
    const app = createApp();
    const res = await app.request("/api/volute/channels");
    assert.equal(res.status, 401);
  });
});
