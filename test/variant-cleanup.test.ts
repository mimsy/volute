import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { and, eq } from "drizzle-orm";
import { getDb } from "../packages/daemon/src/lib/db.js";
import {
  addMind,
  addVariant,
  deleteMindDbFootprint,
  findMind,
  removeMind,
} from "../packages/daemon/src/lib/mind/registry.js";
import { reconcileVariants } from "../packages/daemon/src/lib/mind/variant-cleanup.js";
import {
  activity,
  channelGates,
  channels,
  conversationParticipants,
  conversations,
  deliveryQueue,
  messages,
  mindHistory,
  mindNotices,
  minds,
  summaries,
  turns,
  users,
} from "../packages/daemon/src/lib/schema.js";
import log from "../packages/daemon/src/lib/util/logger.js";

const base = `cleanup-base-${Date.now()}`;
const variant = `${base}-v`;

async function mindUserId(name: string): Promise<number | undefined> {
  const db = await getDb();
  const row = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.username, name), eq(users.user_type, "mind")))
    .get();
  return row?.id;
}

/** Insert the footprint genuinely keyed by a variant's own name. */
async function seedVariantFootprint(): Promise<number> {
  const db = await getDb();
  const [user] = await db
    .insert(users)
    .values({ username: variant, password_hash: "!mind", role: "user", user_type: "mind" })
    .returning({ id: users.id });

  const convId = `conv-${variant}`;
  await db.insert(conversations).values({ id: convId, type: "dm", user_id: user.id });
  await db.insert(channels).values({ conversation_id: convId, name: variant });
  await db.insert(messages).values({ conversation_id: convId, role: "user", content: "hi" });
  await db.insert(conversationParticipants).values({ conversation_id: convId, user_id: user.id });

  // Start/stop activity is published under the raw name — genuinely variant-keyed.
  await db.insert(activity).values({ type: "mind_started", mind: variant, summary: "s" });
  // delivery_queue keys `mind` by the base name and `target_mind` by the variant.
  await db
    .insert(deliveryQueue)
    .values({ mind: base, target_mind: variant, session: "main", payload: "{}" });
  return user.id;
}

/** Insert rows the delivery pipeline keys by the BASE name (never the variant). */
async function seedBaseKeyed(): Promise<void> {
  const db = await getDb();
  await db.insert(turns).values({ id: `turn-${base}`, mind: base });
  await db.insert(mindHistory).values({ mind: base, type: "inbound", content: "x" });
  await db
    .insert(summaries)
    .values({ mind: base, period: "day", period_key: "2026-07-11", content: "c" });
  await db
    .insert(mindNotices)
    .values({ mind: base, session: "main", kind: "crash", reason: "unknown", detail: "d" });
  await db.insert(channelGates).values({ mind: base, channel: "#x", state: "declined" });
}

describe("deleteMindDbFootprint", () => {
  afterEach(async () => {
    const db = await getDb();
    await deleteMindDbFootprint(variant).catch(() => {});
    await db.delete(conversations).where(eq(conversations.id, `conv-${variant}`));
    await db.delete(conversations).where(eq(conversations.id, `shared-${base}`));
    await db.delete(turns).where(eq(turns.mind, base));
    await db.delete(mindHistory).where(eq(mindHistory.mind, base));
    await db.delete(summaries).where(eq(summaries.mind, base));
    await db.delete(mindNotices).where(eq(mindNotices.mind, base));
    await db.delete(channelGates).where(eq(channelGates.mind, base));
    await db.delete(activity).where(eq(activity.mind, base));
    await db.delete(deliveryQueue).where(eq(deliveryQueue.mind, base));
    await db.delete(users).where(eq(users.username, `owner-${base}`));
    await removeMind(base).catch(() => {});
  });

  it("purges the variant's user, owned conversations, activity, and targeted deliveries", async () => {
    const userId = await seedVariantFootprint();

    await deleteMindDbFootprint(variant);

    const db = await getDb();
    assert.equal(await mindUserId(variant), undefined, "variant user gone");
    assert.equal(
      (await db.select().from(conversations).where(eq(conversations.user_id, userId))).length,
      0,
      "owned conversation gone",
    );
    assert.equal(
      (
        await db
          .select()
          .from(messages)
          .where(eq(messages.conversation_id, `conv-${variant}`))
      ).length,
      0,
      "owned messages gone (cascade)",
    );
    assert.equal(
      (await db.select().from(activity).where(eq(activity.mind, variant))).length,
      0,
      "variant activity gone",
    );
    assert.equal(
      (await db.select().from(deliveryQueue).where(eq(deliveryQueue.target_mind, variant))).length,
      0,
      "variant-targeted delivery gone",
    );
  });

  it("leaves the base mind's base-keyed rows and shared-channel history untouched", async () => {
    const db = await getDb();
    const variantUserId = await seedVariantFootprint();
    await seedBaseKeyed();

    // A shared channel owned by another user, holding a message the variant sent and a
    // participant row for the variant. The message must survive (it belongs to the
    // channel); the variant's membership goes with its user row.
    const [owner] = await db
      .insert(users)
      .values({ username: `owner-${base}`, password_hash: "!x", role: "user", user_type: "brain" })
      .returning({ id: users.id });
    const sharedId = `shared-${base}`;
    await db.insert(conversations).values({ id: sharedId, type: "channel", user_id: owner.id });
    await db.insert(channels).values({ conversation_id: sharedId, name: `shared-${base}` });
    await db.insert(messages).values({
      conversation_id: sharedId,
      role: "assistant",
      sender_name: variant,
      content: "yo",
    });
    await db
      .insert(conversationParticipants)
      .values({ conversation_id: sharedId, user_id: variantUserId });

    await deleteMindDbFootprint(variant);

    // Base-keyed rows survive.
    assert.equal((await db.select().from(turns).where(eq(turns.mind, base))).length, 1);
    assert.equal((await db.select().from(mindHistory).where(eq(mindHistory.mind, base))).length, 1);
    assert.equal((await db.select().from(summaries).where(eq(summaries.mind, base))).length, 1);
    assert.equal((await db.select().from(mindNotices).where(eq(mindNotices.mind, base))).length, 1);
    assert.equal(
      (await db.select().from(channelGates).where(eq(channelGates.mind, base))).length,
      1,
    );

    // Shared channel + the variant's message survive; its membership does not.
    assert.equal(
      (await db.select().from(conversations).where(eq(conversations.id, sharedId))).length,
      1,
      "shared conversation survives",
    );
    assert.equal(
      (await db.select().from(messages).where(eq(messages.conversation_id, sharedId))).length,
      1,
      "variant's shared-channel message survives as history",
    );
    assert.equal(
      (
        await db
          .select()
          .from(conversationParticipants)
          .where(eq(conversationParticipants.user_id, variantUserId))
      ).length,
      0,
      "variant membership removed with its user row",
    );
  });
});

describe("reconcileVariants", () => {
  const tmpDirs: string[] = [];
  afterEach(async () => {
    const db = await getDb();
    await db.delete(minds).where(eq(minds.parent, base));
    await removeMind(`${base}@legacy`).catch(() => {});
    await removeMind(base).catch(() => {});
    for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("drops a variant row whose worktree directory is gone", async () => {
    await addMind(base, 4300);
    await addVariant(variant, base, 4301, "/does/not/exist/gone", variant);

    await reconcileVariants();

    assert.equal(await findMind(variant), undefined);
  });

  it("keeps a variant whose worktree still exists", async () => {
    const dir = mkdtempSync(resolve(tmpdir(), "variant-live-"));
    tmpDirs.push(dir);
    await addMind(base, 4300);
    await addVariant(variant, base, 4301, dir, variant);

    await reconcileVariants();

    assert.ok(await findMind(variant), "live variant should be kept");
  });

  it("drops a legacy row whose name predates current validation (e.g. name@variant)", async () => {
    // addVariant would reject the `@`; insert the row directly like the old flow left it.
    const db = await getDb();
    await addMind(base, 4300);
    await db
      .insert(minds)
      .values({ name: `${base}@legacy`, port: 4302, parent: base, dir: "/gone/legacy" });

    await reconcileVariants();

    assert.equal(await findMind(`${base}@legacy`), undefined);
  });

  it("reports an orphaned .variants dir with no registry row without deleting it", async () => {
    const dir = mkdtempSync(resolve(tmpdir(), "variant-orphan-"));
    tmpDirs.push(dir);
    const orphan = resolve(dir, ".variants", "orphan");
    mkdirSync(orphan, { recursive: true });
    const db = await getDb();
    // Base mind row must carry a real dir so reconcile scans its .variants/.
    await db.insert(minds).values({ name: base, port: 4300, dir });

    const warnings: string[] = [];
    const origWarn = log.warn;
    (log as { warn: typeof log.warn }).warn = (msg: string) => {
      warnings.push(msg);
    };
    try {
      await reconcileVariants();
    } finally {
      (log as { warn: typeof log.warn }).warn = origWarn;
    }

    assert.ok(existsSync(orphan), "orphan dir must not be deleted");
    assert.ok(
      warnings.some((w) => w.includes(orphan)),
      "reconcile should report the orphaned worktree",
    );
  });
});
