import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { getDb } from "../db.js";
import { findMind, getBaseName } from "../mind/registry.js";
import { getPrompt } from "../prompts.js";
import { systemEvents } from "../schema.js";
import log from "../util/logger.js";
import { parseDbTimestamp } from "../util/time.js";
import { deliverEvent, MIND_LEVEL_THREAD, parseMeta } from "./system-events.js";

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
 * Record a "your message could not be delivered" notice for a mind, coalescing
 * repeated failures to the same channel: if an undelivered delivery-failure
 * notice for this (mind, channel) was created within {@link COALESCE_WINDOW_MINUTES},
 * its count and body are updated in place instead of inserting a new row.
 * Never throws — a failure to record a failure must not break the send path.
 */
export async function recordDeliveryFailure(input: DeliveryFailureInput): Promise<void> {
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
      const since = parseDbTimestamp(existing.created_at).toLocaleTimeString("en-GB", {
        hour: "2-digit",
        minute: "2-digit",
      });
      const body = await getPrompt("delivery_failure_coalesced", {
        count: String(count),
        channel: input.channel,
        since,
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
    await deliverEvent(input.mind, {
      type: "notice",
      body,
      thread: input.thread ?? MIND_LEVEL_THREAD,
      delivery: "next-turn",
      meta: {
        subtype: "delivery_failed",
        reason: "delivery_failed",
        channel: input.channel,
        count: 1,
      },
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
    const base = await getBaseName(sender);
    await recordDeliveryFailure({ mind: base, channel, reason });
  } catch (err) {
    nlog.warn(
      `failed to record sender delivery-failure notice for ${sender} → ${channel}`,
      log.errorData(err),
    );
  }
}
