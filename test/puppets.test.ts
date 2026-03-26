import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { findOrCreatePuppet, updatePuppetAvatar } from "../packages/daemon/src/lib/chat/puppets.js";
import { getDb } from "../packages/daemon/src/lib/db.js";
import { users } from "../packages/daemon/src/lib/schema.js";

describe("puppets", () => {
  it("creates a puppet user with platform-qualified username", async () => {
    const puppet = await findOrCreatePuppet("discord", "alice#1234", "Alice");
    const db = await getDb();
    try {
      assert.equal(puppet.username, "discord:alice#1234");
      assert.equal(puppet.display_name, "Alice");

      // Verify in DB
      const row = await db.select().from(users).where(eq(users.id, puppet.id)).get();
      assert.ok(row);
      assert.equal(row!.user_type, "puppet");
      assert.equal(row!.password_hash, "!puppet");
      assert.equal(row!.role, "user");
    } finally {
      await db.delete(users).where(eq(users.id, puppet.id));
    }
  });

  it("returns existing puppet on duplicate call", async () => {
    const db = await getDb();
    const first = await findOrCreatePuppet("slack", "bob", "Bob");
    try {
      const second = await findOrCreatePuppet("slack", "bob", "Bob");
      assert.equal(first.id, second.id);
    } finally {
      await db.delete(users).where(eq(users.id, first.id));
    }
  });

  it("updates display name on subsequent calls", async () => {
    const db = await getDb();
    const first = await findOrCreatePuppet("telegram", "@charlie", "Charlie");
    try {
      const second = await findOrCreatePuppet("telegram", "@charlie", "Charles");
      assert.equal(second.id, first.id);
      assert.equal(second.display_name, "Charles");
    } finally {
      await db.delete(users).where(eq(users.id, first.id));
    }
  });

  it("creates separate puppets for different platforms", async () => {
    const db = await getDb();
    const discordPuppet = await findOrCreatePuppet("discord", "dave", "Dave");
    const slackPuppet = await findOrCreatePuppet("slack", "dave", "Dave");
    try {
      assert.notEqual(discordPuppet.id, slackPuppet.id);
      assert.equal(discordPuppet.username, "discord:dave");
      assert.equal(slackPuppet.username, "slack:dave");
    } finally {
      await db.delete(users).where(eq(users.id, discordPuppet.id));
      await db.delete(users).where(eq(users.id, slackPuppet.id));
    }
  });

  it("updatePuppetAvatar sets avatar", async () => {
    const db = await getDb();
    const puppet = await findOrCreatePuppet("discord", "eve", "Eve");
    try {
      await updatePuppetAvatar(puppet.id, "https://example.com/avatar.png");
      const row = await db.select().from(users).where(eq(users.id, puppet.id)).get();
      assert.equal(row!.avatar, "https://example.com/avatar.png");
    } finally {
      await db.delete(users).where(eq(users.id, puppet.id));
    }
  });
});
