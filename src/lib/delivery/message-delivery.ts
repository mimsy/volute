import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { getSleepManagerIfReady } from "../daemon/sleep-manager.js";
import { getActiveTurnId } from "../daemon/turn-tracker.js";
import { getDb } from "../db.js";
import { publish as publishMindEvent } from "../events/mind-events.js";
import log from "../logger.js";
import { findMind, getBaseName } from "../registry.js";
import { activity, conversations, messages, mindHistory, turns } from "../schema.js";
import { getDeliveryManager } from "./delivery-manager.js";
import { type DeliveryPayload, extractTextContent } from "./delivery-router.js";

const dlog = log.child("delivery");

/**
 * Record an inbound message: persist to mind_history and publish to the live event stream.
 * Both the connector `/message` endpoint and `deliverMessage()` use this to avoid drift.
 * Returns the inserted event ID (if available) for subsequent turn tagging.
 */
export async function recordInbound(
  mind: string,
  channel: string,
  sender: string | null,
  content: string | null,
): Promise<number | undefined> {
  // Record without turn_id initially. The turn will be linked either by
  // tagRecentInbound (when session is known) or retroactively at turn creation.
  // This avoids merging unrelated inbounds from different channels into one turn.
  let insertedId: number | undefined;
  try {
    const db = await getDb();
    const result = await db
      .insert(mindHistory)
      .values({
        mind,
        type: "inbound",
        channel,
        sender,
        content,
      })
      .returning({ id: mindHistory.id });
    insertedId = result[0]?.id;
  } catch (err) {
    dlog.warn(`failed to persist inbound for ${mind}`, log.errorData(err));
  }

  publishMindEvent(mind, {
    mind,
    type: "inbound",
    channel,
    content: content ?? undefined,
    sender: sender ?? undefined,
  });

  return insertedId;
}

/**
 * Record an outbound message: persist to mind_history WITHOUT a turn_id.
 *
 * The turn association is deferred — concurrent sessions share a single process-level
 * env var (VOLUTE_SESSION) which races, so we don't attempt session-based turn lookup
 * here. Instead, the outbound record is linked to its turn when the corresponding
 * tool_result event arrives at the events endpoint (via `linkToolResultToTurn`).
 *
 * The outbound event is NOT published to SSE here; it is published by
 * `linkToolResultToTurn` once the correct turn_id is known, ensuring the stream
 * always contains correctly-tagged events. Any orphans are caught by
 * `tagUntaggedOutbound` on turn completion as a safety net.
 *
 * Returns the inserted mind_history record ID (used as a correlation key in tool output).
 */
export async function recordOutbound(
  mind: string,
  channel: string,
  content: string | null,
  opts: { messageId?: string } = {},
): Promise<number | undefined> {
  try {
    const db = await getDb();
    const result = await db
      .insert(mindHistory)
      .values({
        mind,
        type: "outbound",
        channel,
        content,
        turn_id: null,
        message_id: opts.messageId ?? null,
      })
      .returning({ id: mindHistory.id });
    return result[0]?.id;
  } catch (err) {
    dlog.warn(`failed to persist outbound for ${mind}`, log.errorData(err));
    return undefined;
  }
}

/** Regexes to extract correlation IDs from tool_result content. */
const OUTBOUND_MARKER_RE = /\[volute:outbound:(\d+)\]/g;
const ACTIVITY_MARKER_RE = /\[volute:activity:(\d+)\]/g;

/**
 * Link outbound records and extension activities to a turn using correlation
 * markers in tool_result content. Called from the events endpoint when a
 * tool_result event arrives.
 *
 * Scans the content for `[volute:outbound:NNN]` and `[volute:activity:NNN]`
 * markers. For outbound markers:
 * - Sets the outbound record's turn_id
 * - Fixes the linked message's turn_id and source_event_id
 * - Publishes the outbound event to SSE (correctly tagged)
 * For activity markers:
 * - Sets the activity record's turn_id and source_event_id
 */
export async function linkToolResultToTurn(
  mind: string,
  turnId: string,
  toolResultContent: string | null,
  toolUseEventId: number | undefined,
): Promise<void> {
  if (!toolResultContent) return;

  const db = await getDb();

  // --- Outbound markers ---
  for (const match of toolResultContent.matchAll(OUTBOUND_MARKER_RE)) {
    const outboundId = Number(match[1]);
    try {
      const rows = await db
        .select({
          id: mindHistory.id,
          channel: mindHistory.channel,
          content: mindHistory.content,
          message_id: mindHistory.message_id,
        })
        .from(mindHistory)
        .where(and(eq(mindHistory.id, outboundId), eq(mindHistory.mind, mind)))
        .limit(1);

      const row = rows[0];
      if (!row) {
        dlog.warn(`outbound marker references missing record: mind=${mind} id=${outboundId}`);
        continue;
      }

      await db.update(mindHistory).set({ turn_id: turnId }).where(eq(mindHistory.id, outboundId));

      if (row.message_id) {
        await db
          .update(messages)
          .set({
            turn_id: turnId,
            ...(toolUseEventId != null ? { source_event_id: toolUseEventId } : {}),
          })
          .where(eq(messages.id, Number(row.message_id)));
      }

      // Publish the outbound event to SSE — correctly tagged
      publishMindEvent(mind, {
        mind,
        type: "outbound",
        channel: row.channel ?? undefined,
        content: row.content ?? undefined,
        turnId,
      });
    } catch (err) {
      dlog.warn(`failed to link outbound ${outboundId} to turn ${turnId}`, log.errorData(err));
    }
  }

  // --- Activity markers ---
  const activityIds: number[] = [];
  for (const match of toolResultContent.matchAll(ACTIVITY_MARKER_RE)) {
    activityIds.push(Number(match[1]));
  }
  if (activityIds.length > 0) {
    try {
      await db
        .update(activity)
        .set({
          turn_id: turnId,
          ...(toolUseEventId != null ? { source_event_id: toolUseEventId } : {}),
        })
        .where(inArray(activity.id, activityIds));

      // Insert mind_history rows so activities appear in the turn event stream
      const actRows = await db.select().from(activity).where(inArray(activity.id, activityIds));
      if (actRows.length > 0) {
        await db.insert(mindHistory).values(
          actRows.map((a) => ({
            mind,
            type: "activity",
            content: a.summary,
            metadata: a.metadata,
            turn_id: turnId,
            created_at: a.created_at,
          })),
        );
      }
    } catch (err) {
      dlog.warn(`failed to link activities to turn ${turnId}`, log.errorData(err));
    }
  }
}

/**
 * Retroactively tag orphaned outbound records (and their linked messages) with the
 * correct turn_id. Called on turn completion, analogous to `tagUntaggedInbound`.
 *
 * Finds outbound records for this mind that have no turn_id and whose IDs fall within
 * the range of events already tagged with this turn. Also fixes the corresponding
 * messages in the conversations table (turn_id and source_event_id).
 */
export async function tagUntaggedOutbound(mind: string, turnId: string): Promise<void> {
  const db = await getDb();

  // Find the event ID range for this turn
  const range = await db
    .select({
      minId: sql<number>`MIN(${mindHistory.id})`,
      maxId: sql<number>`MAX(${mindHistory.id})`,
    })
    .from(mindHistory)
    .where(and(eq(mindHistory.mind, mind), eq(mindHistory.turn_id, turnId)));

  const minId = range[0]?.minId;
  const maxId = range[0]?.maxId;
  if (minId == null || maxId == null) return;

  // Find orphaned outbound records within this turn's event range
  const orphans = await db
    .select({ id: mindHistory.id, message_id: mindHistory.message_id })
    .from(mindHistory)
    .where(
      and(
        eq(mindHistory.mind, mind),
        eq(mindHistory.type, "outbound"),
        sql`${mindHistory.turn_id} IS NULL`,
        sql`${mindHistory.id} >= ${minId}`,
        sql`${mindHistory.id} <= ${maxId}`,
      ),
    );

  if (orphans.length === 0) return;

  // Tag the outbound records
  const orphanIds = orphans.map((r) => r.id);
  await db.update(mindHistory).set({ turn_id: turnId }).where(inArray(mindHistory.id, orphanIds));

  // Fix linked messages: set turn_id and source_event_id
  // For source_event_id, find the nearest preceding tool_use event in this turn
  for (const orphan of orphans) {
    if (!orphan.message_id) continue;
    // Find the closest tool_use event before this outbound in the same turn
    const toolUse = await db
      .select({ id: mindHistory.id })
      .from(mindHistory)
      .where(
        and(
          eq(mindHistory.mind, mind),
          eq(mindHistory.turn_id, turnId),
          eq(mindHistory.type, "tool_use"),
          sql`${mindHistory.id} < ${orphan.id}`,
        ),
      )
      .orderBy(desc(mindHistory.id))
      .limit(1);

    const sourceEventId = toolUse[0]?.id ?? null;
    await db
      .update(messages)
      .set({
        turn_id: turnId,
        ...(sourceEventId != null ? { source_event_id: sourceEventId } : {}),
      })
      .where(eq(messages.id, Number(orphan.message_id)));
  }

  dlog.info(`tagged ${orphans.length} orphaned outbound record(s) for ${mind} with turn ${turnId}`);
}

/**
 * Tag recent untagged inbound events and messages for a mind with the given turn ID.
 * Used both proactively (on message delivery) and retroactively (on turn creation).
 * When `setTrigger` is true, also sets the turn's `trigger_event_id` to the most recent inbound.
 * When `channel` is provided, only tags inbounds on that channel (prevents cross-session leaks).
 */
export async function tagUntaggedInbound(
  mind: string,
  turnId: string,
  {
    limit = 5,
    setTrigger = false,
    channel,
  }: { limit?: number; setTrigger?: boolean; channel?: string } = {},
): Promise<void> {
  const db = await getDb();
  // Tag recent untagged inbound events in mind_history
  const historyConditions = [
    eq(mindHistory.mind, mind),
    eq(mindHistory.type, "inbound"),
    sql`${mindHistory.turn_id} IS NULL`,
    sql`${mindHistory.created_at} > datetime('now', '-60 seconds')`,
  ];
  if (channel) historyConditions.push(eq(mindHistory.channel, channel));
  const recentInbounds = await db
    .select({ id: mindHistory.id })
    .from(mindHistory)
    .where(and(...historyConditions))
    .orderBy(desc(mindHistory.id))
    .limit(limit);
  if (recentInbounds.length > 0) {
    const ids = recentInbounds.map((r) => r.id);
    await db.update(mindHistory).set({ turn_id: turnId }).where(inArray(mindHistory.id, ids));
    if (setTrigger) {
      await db
        .update(turns)
        .set({ trigger_event_id: recentInbounds[0].id })
        .where(eq(turns.id, turnId));
    }
  }
  // Tag recent untagged conversation messages (only inbound, i.e. not sent by the mind itself)
  const recentMsgs = await db
    .select({ id: messages.id })
    .from(messages)
    .innerJoin(conversations, eq(messages.conversation_id, conversations.id))
    .where(
      and(
        eq(conversations.mind_name, mind),
        sql`${messages.turn_id} IS NULL`,
        sql`${messages.sender_name} != ${mind}`,
        sql`${messages.created_at} > datetime('now', '-60 seconds')`,
      ),
    )
    .orderBy(desc(messages.id))
    .limit(limit);
  if (recentMsgs.length > 0) {
    const ids = recentMsgs.map((r) => r.id);
    await db.update(messages).set({ turn_id: turnId }).where(inArray(messages.id, ids));
  }
}

/**
 * Tag the most recent untagged inbound for a mind with the active turn for a session.
 * Called from the delivery manager after routing resolves the session, so incoming
 * messages are linked to the current turn immediately (enabling correct live streaming).
 * The channel parameter scopes the tagging to avoid cross-session leaks.
 */
export async function tagRecentInbound(
  mind: string,
  session: string,
  channel?: string,
): Promise<void> {
  const turnId = getActiveTurnId(mind, session);
  if (!turnId) return;
  try {
    await tagUntaggedInbound(mind, turnId, { limit: 1, channel });
  } catch (err) {
    dlog.warn(`failed to tag recent inbound for ${mind} with turn ${turnId}`, log.errorData(err));
  }
}

/**
 * Determine what to do with a message for a sleeping mind.
 * Returns the action to take: "skip", "queue", or "queue-and-wake".
 */
export function resolveSleepAction(
  sleepBehavior: string | undefined,
  wokenByTrigger: boolean,
  wakeTriggerMatches: boolean,
): "skip" | "queue" | "queue-and-wake" {
  if (sleepBehavior === "skip") return "skip";
  if (sleepBehavior === "trigger-wake" && !wokenByTrigger) return "queue-and-wake";
  if (!sleepBehavior && wakeTriggerMatches) return "queue-and-wake";
  return "queue";
}

/**
 * Deliver a message to a mind via the delivery manager (routes, batches, gates).
 * Fire-and-forget — logs errors but does not throw.
 */
export async function deliverMessage(mindName: string, payload: DeliveryPayload): Promise<void> {
  try {
    const baseName = await getBaseName(mindName);
    const entry = await findMind(baseName);
    if (!entry) {
      dlog.warn(`cannot deliver to ${mindName}: mind not found`);
      return;
    }

    const textContent = extractTextContent(payload.content);
    await recordInbound(baseName, payload.channel, payload.sender ?? null, textContent);

    // Check if mind is sleeping — handle based on whileSleeping or wake triggers
    const sleepManager = getSleepManagerIfReady();
    if (sleepManager?.isSleeping(baseName)) {
      const sleepState = sleepManager.getState(baseName);
      const action = resolveSleepAction(
        payload.whileSleeping,
        sleepState.wokenByTrigger,
        sleepManager.checkWakeTrigger(baseName, payload),
      );

      if (action === "skip") {
        dlog.info(
          `skipped delivery to ${baseName} (sleeping, whileSleeping=skip, channel=${payload.channel})`,
        );
        return;
      }

      await sleepManager.queueSleepMessage(baseName, payload);
      if (action === "queue-and-wake") {
        sleepManager
          .initiateWake(baseName, { trigger: { channel: payload.channel } })
          .catch((err) => dlog.warn(`failed to trigger-wake ${baseName}`, log.errorData(err)));
      }
      return;
    }

    const manager = getDeliveryManager();
    await manager.routeAndDeliver(mindName, payload);
  } catch (err) {
    dlog.warn(`unexpected error delivering to ${mindName}`, log.errorData(err));
  }
}
