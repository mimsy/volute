import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { createUser, getOrCreateMindUser, setUserRole } from "../packages/daemon/src/lib/auth.js";
import { getDb } from "../packages/daemon/src/lib/db.js";
import {
  createChannel,
  deleteConversation,
  getChannelByName,
  getChannelSettings,
  getMessages,
  getParticipants,
  joinChannel,
} from "../packages/daemon/src/lib/events/conversations.js";
import { addMind, removeMind } from "../packages/daemon/src/lib/mind/registry.js";
import { users } from "../packages/daemon/src/lib/schema.js";
import conversationsRoute from "../packages/daemon/src/web/api/v1/conversations.js";
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

/** Deleting a channel goes through the conversations router, not the channels one. */
function createDeleteApp() {
  const app = new Hono();
  app.use("/api/v1/conversations/*", authMiddleware);
  app.route("/api/v1/conversations", conversationsRoute);
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

  it("POST /api/v1/channels — adds participantNames (users and minds) as members", async () => {
    const cookie = await setupAuth();
    const app = createApp();

    const bob = await createUser("bob", "pass");
    // Register a mind with no pre-existing users row, so the route must
    // resolve it via the registry fallback (findMind → getOrCreateMindUser).
    await addMind("test-mind", 4999);

    try {
      const res = await app.request("/api/v1/channels", {
        method: "POST",
        headers: {
          Cookie: `volute_session=${cookie}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: "squad", participantNames: ["bob", "test-mind"] }),
      });
      assert.equal(res.status, 201);
      const body = await res.json();

      // The mind's user row was created on demand by the route.
      const mindUser = await getOrCreateMindUser("test-mind");

      const participants = await getParticipants(body.id);
      // Creator + the two requested participants.
      assert.equal(participants.length, 3);
      assert.ok(participants.some((p) => p.userId === userId));
      assert.ok(participants.some((p) => p.userId === bob.id));
      assert.ok(participants.some((p) => p.userId === mindUser.id));

      await deleteConversation(body.id);
    } finally {
      await removeMind("test-mind");
    }
  });

  it("POST /api/v1/channels — dedupes the creator and repeated participant names", async () => {
    const cookie = await setupAuth();
    const app = createApp();

    const bob = await createUser("bob", "pass");

    const res = await app.request("/api/v1/channels", {
      method: "POST",
      headers: {
        Cookie: `volute_session=${cookie}`,
        "Content-Type": "application/json",
      },
      // Include the creator and a duplicate name; joins are idempotent so this
      // must succeed with a single row each — not roll the channel back.
      body: JSON.stringify({ name: "dupes", participantNames: ["ch-admin", "bob", "bob"] }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();

    const participants = await getParticipants(body.id);
    // Creator + bob, each exactly once.
    assert.equal(participants.length, 2);
    assert.ok(participants.some((p) => p.userId === userId));
    assert.ok(participants.some((p) => p.userId === bob.id));

    await deleteConversation(body.id);
  });

  it("POST /api/v1/channels — 404 for unknown participant, channel not created", async () => {
    const cookie = await setupAuth();
    const app = createApp();

    await createUser("bob", "pass");

    const res = await app.request("/api/v1/channels", {
      method: "POST",
      headers: {
        Cookie: `volute_session=${cookie}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "ghosted", participantNames: ["bob", "ghost"] }),
    });
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.match(body.error, /ghost/);

    // The channel must not have been created, even though "bob" resolved.
    const ch = await getChannelByName("ghosted");
    assert.equal(ch, null);
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

    // Explicit null clears a field (the UI relies on null-vs-undefined)
    const res3 = await app.request("/api/v1/channels/patchable", {
      method: "PATCH",
      headers: {
        Cookie: `volute_session=${cookie}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ description: null }),
    });
    assert.equal(res3.status, 200);
    const body3 = await res3.json();
    assert.equal(body3.settings.description, null);
    assert.equal(body3.settings.rules, "Be brief");

    await deleteConversation(ch.id);
  });

  it("PATCH /:name — a non-admin who created the channel may update its settings", async () => {
    await setupAuth(); // first user (admin) exists but is not used as the caller
    const app = createApp();

    const bob = await createUser("bob", "pass");
    await setUserRole(bob.id, "user");
    const bobCookie = await createSession(bob.id);

    // bob created the channel, so he's stamped "owner" — that's what grants the edit,
    // and it's the branch minds rely on for channels they open themselves.
    const ch = await createChannel("creator-edit", bob.id);

    const res = await app.request("/api/v1/channels/creator-edit", {
      method: "PATCH",
      headers: {
        Cookie: `volute_session=${bobCookie}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ description: "set by creator" }),
    });
    assert.equal(res.status, 200);
    const settings = await getChannelSettings("creator-edit");
    assert.equal(settings?.description, "set by creator");

    await deleteConversation(ch.id);
  });

  it("PATCH /:name — a member who didn't create the channel may not update its settings", async () => {
    const adminCookie = await setupAuth();
    const app = createApp();

    const bob = await createUser("bob", "pass");
    await setUserRole(bob.id, "user");
    const bobCookie = await createSession(bob.id);

    // The admin creates it; bob merely joins. Membership alone must not grant the edit —
    // otherwise any mind in a channel could lift a limit set to restrain it.
    const ch = await createChannel("owned-elsewhere", userId, { charLimit: 100 });
    await joinChannel(ch.id, bob.id);

    const res = await app.request("/api/v1/channels/owned-elsewhere", {
      method: "PATCH",
      headers: {
        Cookie: `volute_session=${bobCookie}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ charLimit: null }),
    });
    assert.equal(res.status, 403);
    // The limit is untouched.
    assert.equal((await getChannelSettings("owned-elsewhere"))?.char_limit, 100);

    // The creator (here also an admin) still can.
    const ok = await app.request("/api/v1/channels/owned-elsewhere", {
      method: "PATCH",
      headers: {
        Cookie: `volute_session=${adminCookie}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ charLimit: 200 }),
    });
    assert.equal(ok.status, 200);

    await deleteConversation(ch.id);
  });

  it("PATCH /:name — an admin may edit an ownerless channel (the commons)", async () => {
    const adminCookie = await setupAuth();
    const app = createApp();

    // Created with no creator, exactly as the commons is — so no participant is "owner".
    const ch = await createChannel("ownerless");

    const res = await app.request("/api/v1/channels/ownerless", {
      method: "PATCH",
      headers: {
        Cookie: `volute_session=${adminCookie}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ rules: "House rules" }),
    });
    assert.equal(res.status, 200);
    assert.equal((await getChannelSettings("ownerless"))?.rules, "House rules");

    await deleteConversation(ch.id);
  });

  it("PATCH /:name — rate limit round-trips, and a half-set pair is rejected", async () => {
    const cookie = await setupAuth();
    const app = createApp();

    const ch = await createChannel("paced", userId);
    const patch = (body: unknown) =>
      app.request("/api/v1/channels/paced", {
        method: "PATCH",
        headers: {
          Cookie: `volute_session=${cookie}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

    const res = await patch({ rateLimit: 20, rateWindow: 60 });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.settings.rateLimit, 20);
    assert.equal(body.settings.rateWindow, 60);

    // Coherence is judged against the row as the patch will leave it, not the request alone.
    // With 20/60 already stored, changing one half is fine — the pair stays complete.
    assert.equal((await patch({ rateLimit: 5 })).status, 200);
    assert.equal((await getChannelSettings("paced"))?.rate_limit, 5);
    assert.equal((await patch({ rateWindow: 30 })).status, 200);
    assert.equal((await getChannelSettings("paced"))?.rate_window, 30);

    // But clearing only one half would leave a limit that silently stops being enforced
    // while the API still reports it, so that is refused.
    assert.equal((await patch({ rateWindow: null })).status, 400);
    assert.equal((await patch({ rateLimit: null })).status, 400);
    assert.equal((await patch({ rateLimit: 5, rateWindow: null })).status, 400);
    assert.equal((await patch({ rateLimit: 0, rateWindow: 60 })).status, 400);

    // None of the rejects changed anything.
    const still = await getChannelSettings("paced");
    assert.equal(still?.rate_limit, 5);
    assert.equal(still?.rate_window, 30);

    // Both null clears it.
    assert.equal((await patch({ rateLimit: null, rateWindow: null })).status, 200);
    const cleared = await getChannelSettings("paced");
    assert.equal(cleared?.rate_limit, null);
    assert.equal(cleared?.rate_window, null);

    await deleteConversation(ch.id);
  });

  it("DELETE a channel conversation needs ownership, not just membership", async () => {
    const adminCookie = await setupAuth();
    const app = createDeleteApp();

    const bob = await createUser("bob", "pass");
    await setUserRole(bob.id, "user");
    const bobCookie = await createSession(bob.id);

    // The admin creates a limited channel; bob is only a member. If a member could delete it,
    // the owner-only settings guard would be worthless — bob could destroy the channel and
    // re-create it as owner with no limits at all.
    const ch = await createChannel("undeletable", userId, { charLimit: 100 });
    await joinChannel(ch.id, bob.id);

    const denied = await app.request(`/api/v1/conversations/${ch.id}`, {
      method: "DELETE",
      headers: { Cookie: `volute_session=${bobCookie}` },
    });
    assert.equal(denied.status, 403, "a member who didn't create the channel may not delete it");
    assert.ok(await getChannelByName("undeletable"), "the channel still exists");

    // The creator/admin can.
    const ok = await app.request(`/api/v1/conversations/${ch.id}`, {
      method: "DELETE",
      headers: { Cookie: `volute_session=${adminCookie}` },
    });
    assert.equal(ok.status, 200);
    assert.equal(await getChannelByName("undeletable"), null, "the channel is gone");
  });

  it("PATCH /:name — 400 for invalid charLimit", async () => {
    const cookie = await setupAuth();
    const app = createApp();

    const ch = await createChannel("strict", userId);

    for (const bad of [0, -5, 2.5]) {
      const res = await app.request("/api/v1/channels/strict", {
        method: "PATCH",
        headers: {
          Cookie: `volute_session=${cookie}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ charLimit: bad }),
      });
      assert.equal(res.status, 400, `charLimit ${bad} should be rejected`);
    }

    // Nothing was persisted.
    const settings = await getChannelSettings("strict");
    assert.equal(settings?.char_limit, null);

    await deleteConversation(ch.id);
  });

  it("PATCH /:name — 403 for non-member, non-admin caller", async () => {
    await setupAuth(); // ch-admin (admin) is the channel creator
    const app = createApp();

    // A separate, non-admin user who is NOT a member of the channel.
    const bob = await createUser("bob", "pass");
    await setUserRole(bob.id, "user");
    const bobCookie = await createSession(bob.id);

    const ch = await createChannel("guarded", userId);

    const res = await app.request("/api/v1/channels/guarded", {
      method: "PATCH",
      headers: {
        Cookie: `volute_session=${bobCookie}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ description: "hijacked" }),
    });
    assert.equal(res.status, 403);

    // Settings must be untouched.
    const settings = await getChannelSettings("guarded");
    assert.equal(settings?.description, null);

    await deleteConversation(ch.id);
  });

  it("PATCH /:name — admin may edit a channel they are not a member of", async () => {
    const cookie = await setupAuth(); // ch-admin is admin
    const app = createApp();

    // Channel created without ch-admin as a member.
    const ch = await createChannel("adminless");

    const res = await app.request("/api/v1/channels/adminless", {
      method: "PATCH",
      headers: {
        Cookie: `volute_session=${cookie}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ description: "admin edit" }),
    });
    assert.equal(res.status, 200);
    const settings = await getChannelSettings("adminless");
    assert.equal(settings?.description, "admin edit");

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
