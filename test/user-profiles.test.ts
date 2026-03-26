import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import {
  createUser,
  getOrCreateMindUser,
  getUser,
  syncMindProfile,
  updateUserProfile,
} from "../packages/daemon/src/lib/auth.js";
import { getDb } from "../packages/daemon/src/lib/db.js";
import { subscribe } from "../packages/daemon/src/lib/events/activity-events.js";
import {
  createConversation,
  deleteConversation,
  getParticipants,
} from "../packages/daemon/src/lib/events/conversations.js";
import { users } from "../packages/daemon/src/lib/schema.js";
import { formatPrefix } from "../templates/_base/src/lib/format-prefix.js";

const TEST_USERNAMES = [
  "profile-test",
  "avatar-test",
  "clear-test",
  "fields-test",
  "brain-profile",
  "sync-mind",
  "sync-clear",
  "broadcast-test",
  "no-broadcast",
  "mind-profile",
];

async function cleanup() {
  const db = await getDb();
  for (const username of TEST_USERNAMES) {
    await db.delete(users).where(eq(users.username, username));
  }
}

describe("user profiles", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("updateUserProfile sets display_name and description", async () => {
    const user = await createUser("profile-test", "pass");
    await updateUserProfile(user.id, {
      display_name: "Alice Chen",
      description: "researcher",
    });
    const updated = await getUser(user.id);
    assert.ok(updated);
    assert.equal(updated.display_name, "Alice Chen");
    assert.equal(updated.description, "researcher");
    assert.equal(updated.avatar, null);
  });

  it("updateUserProfile can set avatar", async () => {
    const user = await createUser("avatar-test", "pass");
    await updateUserProfile(user.id, { avatar: "avatar-1.png" });
    const updated = await getUser(user.id);
    assert.ok(updated);
    assert.equal(updated.avatar, "avatar-1.png");
  });

  it("updateUserProfile can clear fields to null", async () => {
    const user = await createUser("clear-test", "pass");
    await updateUserProfile(user.id, { display_name: "Name" });
    await updateUserProfile(user.id, { display_name: null });
    const updated = await getUser(user.id);
    assert.ok(updated);
    assert.equal(updated.display_name, null);
  });

  it("syncMindProfile syncs volute.json fields to DB", async () => {
    await syncMindProfile("sync-mind", {
      displayName: "Thoughtful Mind",
      description: "an introspective mind",
      avatar: "avatar.png",
    });
    const mind = await getOrCreateMindUser("sync-mind");
    assert.equal(mind.display_name, "Thoughtful Mind");
    assert.equal(mind.description, "an introspective mind");
    assert.equal(mind.avatar, "avatar.png");
  });

  it("syncMindProfile clears fields not in config", async () => {
    await syncMindProfile("sync-clear", {
      displayName: "Name",
      description: "desc",
    });
    // Sync again without displayName
    await syncMindProfile("sync-clear", {});
    const mind = await getOrCreateMindUser("sync-clear");
    assert.equal(mind.display_name, null);
    assert.equal(mind.description, null);
  });

  it("syncMindProfile broadcasts profile_updated when profile changes", async () => {
    const events: any[] = [];
    const unsub = subscribe((e) => events.push(e));
    try {
      await syncMindProfile("broadcast-test", { displayName: "New Name" });
      assert.equal(events.length, 1);
      assert.equal(events[0].type, "profile_updated");
      assert.equal(events[0].mind, "broadcast-test");
    } finally {
      unsub();
    }
  });

  it("syncMindProfile skips broadcast when profile unchanged", async () => {
    await syncMindProfile("no-broadcast", { displayName: "Same", description: "desc" });
    const events: any[] = [];
    const unsub = subscribe((e) => events.push(e));
    try {
      // Sync again with same values
      await syncMindProfile("no-broadcast", { displayName: "Same", description: "desc" });
      assert.equal(events.length, 0);
    } finally {
      unsub();
    }
  });

  it("getUser returns new profile fields", async () => {
    const user = await createUser("fields-test", "pass");
    assert.equal(user.display_name, null);
    assert.equal(user.description, null);
    assert.equal(user.avatar, null);
  });
});

describe("participant profiles in conversations", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("getParticipants returns displayName, description, and avatar", async () => {
    const brain = await createUser("brain-profile", "pass");
    await updateUserProfile(brain.id, {
      display_name: "Alice",
      description: "researcher",
      avatar: "avatar-5.png",
    });
    const mind = await getOrCreateMindUser("mind-profile");
    await syncMindProfile("mind-profile", {
      displayName: "Deep Thinker",
      description: "introspective",
      avatar: "avatar.png",
    });

    const conv = await createConversation({
      participantIds: [brain.id, mind.id],
    });

    try {
      const participants = await getParticipants(conv.id);
      assert.equal(participants.length, 2);

      const brainP = participants.find((p) => p.username === "brain-profile");
      assert.ok(brainP);
      assert.equal(brainP.displayName, "Alice");
      assert.equal(brainP.description, "researcher");
      assert.equal(brainP.avatar, "avatar-5.png");

      const mindP = participants.find((p) => p.username === "mind-profile");
      assert.ok(mindP);
      assert.equal(mindP.displayName, "Deep Thinker");
      assert.equal(mindP.description, "introspective");
      assert.equal(mindP.avatar, "avatar.png");
    } finally {
      await deleteConversation(conv.id);
    }
  });
});

describe("format-prefix participant profiles", () => {
  it("renders participant block when profiles present", () => {
    const result = formatPrefix(
      {
        channel: "@test",
        sender: "alice",
        participantProfiles: [
          {
            username: "alice",
            userType: "brain",
            displayName: "Alice Chen",
            description: "researcher",
          },
          {
            username: "mystery",
            userType: "mind",
            displayName: null,
            description: "an introspective mind",
          },
        ],
      },
      "12:00",
    );
    assert.ok(result.includes("[Participants:"));
    assert.ok(result.includes("alice (Alice Chen) [brain] — researcher"));
    assert.ok(result.includes("mystery [mind] — an introspective mind"));
  });

  it("omits participant block when no profiles", () => {
    const result = formatPrefix({ channel: "@test", sender: "alice" }, "12:00");
    assert.ok(!result.includes("[Participants:"));
  });

  it("omits participant block when profiles array is empty", () => {
    const result = formatPrefix(
      { channel: "@test", sender: "alice", participantProfiles: [] },
      "12:00",
    );
    assert.ok(!result.includes("[Participants:"));
  });
});
