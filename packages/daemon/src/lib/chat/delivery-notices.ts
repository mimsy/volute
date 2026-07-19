import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { getDb } from "../db.js";
import { findMind } from "../mind/registry.js";
import { getPrompt } from "../prompts.js";
import { systemEvents } from "../schema.js";
import log from "../util/logger.js";
import { localHM, MIND_LEVEL_THREAD, parseMeta, recordNotice } from "./system-events.js";

const nlog = log.child("delivery-notices");

/**
 * One delivery-failure notice per (mind, channel) within this window. A downed
 * bridge or dead recipient can fail many sends in a burst — the mind should get
 * signal ("N messages to X have failed"), not one notice per message.
 */
export const COALESCE_WINDOW_MINUTES = 15;

export type DeliveryFailureInput = {
  /** The mind whose outbound send failed (the sender). */
  mind: string;
  /** Channel slug the failed send was addressed to (e.g. "discord:server/general", "@peer"). */
  channel: string;
  /** Short human-readable summary of why the send failed. */
  reason: string;
  /** Routing thread for the notice; defaults to mind-level (drained by any thread). */
  thread?: string;
};

/**
 * Per-(mind, channel) promise chain serializing {@link recordDeliveryFailure} calls.
 * Coalescing is a read-modify-write across awaits; a burst interleaving two calls
 * would otherwise double-insert or drop a count. Entries self-clean when idle.
 */
const recordChains = new Map<string, Promise<void>>();

/**
 * Record a "your message could not be delivered" notice for a mind, coalescing
 * repeated failures to the same channel: if an undelivered delivery-failure
 * notice for this (mind, channel, thread) was created within
 * {@link COALESCE_WINDOW_MINUTES}, its count and body are updated in place instead
 * of inserting a new row. Never throws — a failure to record a failure must not
 * break the send path.
 */
export async function recordDeliveryFailure(input: DeliveryFailureInput): Promise<void> {
  const key = `${input.mind}\n${input.channel}`;
  const next = (recordChains.get(key) ?? Promise.resolve()).then(() =>
    recordDeliveryFailureUnserialized(input),
  );
  recordChains.set(key, next);
  await next;
  if (recordChains.get(key) === next) recordChains.delete(key);
}

async function recordDeliveryFailureUnserialized(input: DeliveryFailureInput): Promise<void> {
  const thread = input.thread ?? MIND_LEVEL_THREAD;
  try {
    const db = await getDb();
    const existing = await db
      .select()
      .from(systemEvents)
      .where(
        and(
          eq(systemEvents.mind, input.mind),
          eq(systemEvents.type, "notice"),
          eq(systemEvents.delivery, "next-turn"),
          eq(systemEvents.thread, thread),
          isNull(systemEvents.delivered_at),
          // Literal subtype + bound channel value — not string-built SQL.
          sql`json_extract(${systemEvents.meta}, '$.subtype') = 'delivery_failed'`,
          sql`json_extract(${systemEvents.meta}, '$.channel') = ${input.channel}`,
          sql`${systemEvents.created_at} > datetime('now', ${`-${COALESCE_WINDOW_MINUTES} minutes`})`,
        ),
      )
      .orderBy(desc(systemEvents.id))
      .limit(1)
      .get();

    if (existing) {
      const meta = parseMeta(existing.meta, `event ${existing.id}`);
      const count = (typeof meta.count === "number" ? meta.count : 1) + 1;
      const body = await getPrompt("delivery_failure_coalesced", {
        count: String(count),
        channel: input.channel,
        since: localHM(existing.created_at),
        reason: input.reason,
      });
      await db
        .update(systemEvents)
        .set({ body, meta: JSON.stringify({ ...meta, count }) })
        .where(eq(systemEvents.id, existing.id));
      return;
    }

    const body = await getPrompt("delivery_failure_notice", {
      channel: input.channel,
      reason: input.reason,
    });
    await recordNotice({
      mind: input.mind,
      thread,
      kind: "delivery_failed",
      reason: "delivery_failed",
      detail: body,
      meta: { channel: input.channel, count: 1 },
    });
  } catch (err) {
    nlog.warn(
      `failed to record delivery-failure notice for ${input.mind} → ${input.channel}`,
      log.errorData(err),
    );
  }
}

/**
 * Like {@link recordDeliveryFailure}, but for call sites where the sender may be a
 * human or unknown principal: resolves the sender against the mind registry and
 * no-ops unless it's a mind (humans see failures in their own UI; notices are the
 * mind-facing surface). Variants are base-named so the notice reaches the process
 * that actually drains notices. Never throws.
 */
export async function recordSenderDeliveryFailure(
  sender: string,
  channel: string,
  reason: string,
): Promise<void> {
  try {
    const entry = await findMind(sender);
    if (!entry) return;
    await recordDeliveryFailure({ mind: entry.parent ?? entry.name, channel, reason });
  } catch (err) {
    nlog.warn(
      `failed to record sender delivery-failure notice for ${sender} → ${channel}`,
      log.errorData(err),
    );
  }
}
