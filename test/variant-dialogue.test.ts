import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { eq, inArray } from "drizzle-orm";
import { getOrCreateMindUser } from "../packages/daemon/src/lib/auth.js";
import { ensureSystemDM, resetSystemDMCache } from "../packages/daemon/src/lib/chat/system-chat.js";
import { getDb } from "../packages/daemon/src/lib/db.js";
import {
  findDMConversation,
  getParticipants,
} from "../packages/daemon/src/lib/events/conversations.js";
import { addMind, removeMind } from "../packages/daemon/src/lib/mind/registry.js";
import { conversationParticipants, messages, users } from "../packages/daemon/src/lib/schema.js";
import { establishVariantDialogue } from "../packages/daemon/src/web/api/variants.js";

const PARENT = `dv-parent-${Date.now()}`;
const VARIANT = `${PARENT}-exp`;
const USERNAMES = [PARENT, VARIANT, "volute"];

/** The message the parent received in its system DM announcing the variant. */
async function parentNotice(): Promise<string | undefined> {
  const { conversationId } = await ensureSystemDM(PARENT);
  const db = await getDb();
  const msgs = await db
    .select()
    .from(messages)
    .where(eq(messages.conversation_id, conversationId))
    .all();
  return msgs.map((m) => m.content).find((c) => c.includes(VARIANT));
}

async function cleanup() {
  resetSystemDMCache();
  const db = await getDb();
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(inArray(users.username, USERNAMES));
  const ids = rows.map((r) => r.id);
  if (ids.length) {
    await db.delete(conversationParticipants).where(inArray(conversationParticipants.user_id, ids));
  }
  await db.delete(users).where(inArray(users.username, USERNAMES));
  try {
    await removeMind(VARIANT);
  } catch {}
  try {
    await removeMind(PARENT);
  } catch {}
}

describe("establishVariantDialogue", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("opens a parent↔variant DM and notifies the parent with the purpose", async () => {
    await addMind(PARENT, 4310);

    await establishVariantDialogue(PARENT, VARIANT, "test a drier journaling voice");

    // A DM exists between the two mind identities.
    const parentUser = await getOrCreateMindUser(PARENT);
    const variantUser = await getOrCreateMindUser(VARIANT);
    const dmId = await findDMConversation([parentUser.id, variantUser.id]);
    assert.ok(dmId, "a parent↔variant DM should be created");

    const partIds = (await getParticipants(dmId!)).map((p) => p.userId).sort();
    assert.deepEqual(partIds, [parentUser.id, variantUser.id].sort());

    // The parent is told it has a variant, with the purpose, via its own system DM.
    const notice = await parentNotice();
    assert.ok(notice, "parent should be notified about the variant");
    assert.ok(
      notice!.includes("test a drier journaling voice"),
      "notification should include the purpose",
    );
  });

  it("omits the purpose line when none is given", async () => {
    await addMind(PARENT, 4310);

    await establishVariantDialogue(PARENT, VARIANT);

    const parentUser = await getOrCreateMindUser(PARENT);
    const variantUser = await getOrCreateMindUser(VARIANT);
    const dmId = await findDMConversation([parentUser.id, variantUser.id]);
    assert.ok(dmId, "a parent↔variant DM should be created even without a purpose");

    const notice = await parentNotice();
    assert.ok(notice, "parent should still be notified about the variant");
    assert.ok(!notice!.includes("Its purpose:"), "no purpose line without a purpose");
  });

  it("is idempotent — a second call reuses the same DM", async () => {
    await addMind(PARENT, 4310);

    await establishVariantDialogue(PARENT, VARIANT, "explore");
    await establishVariantDialogue(PARENT, VARIANT, "explore");

    const variantUser = await getOrCreateMindUser(VARIANT);

    // The variant belongs to exactly one conversation — a duplicate DM would leave
    // it a participant in two.
    const db = await getDb();
    const dmParts = await db
      .select()
      .from(conversationParticipants)
      .where(eq(conversationParticipants.user_id, variantUser.id))
      .all();
    assert.equal(dmParts.length, 1, "variant should belong to exactly one conversation");
  });
});
