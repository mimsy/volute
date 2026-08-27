import { and, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import type { Context } from "hono";
import { Hono } from "hono";
import { getDb } from "../../lib/db.js";
import { subscribeAll, subscribe as subscribeMindEvent } from "../../lib/events/mind-events.js";
import { getBaseName } from "../../lib/mind/registry.js";
import {
  activity,
  channels,
  conversationParticipants,
  conversations,
  mindHistory,
  summaries,
  turns,
  users,
} from "../../lib/schema.js";
import log from "../../lib/util/logger.js";
import {
  getUtcTimeRange,
  isoWeekKeyForDateStr,
  type TimerPeriod,
} from "../../lib/util/period-keys.js";
import { normalizeDbBound } from "../../lib/util/time.js";
import type { AuthEnv } from "../middleware/auth.js";

/**
 * Env for the history router. `mindFilter` is resolved once by router-level
 * middleware and read by every handler, so new routes inherit cross-mind
 * scoping by default instead of by discipline.
 */
type HistoryEnv = {
  Variables: AuthEnv["Variables"] & { mindFilter: string | undefined };
};

/**
 * Resolve the mind whose history the caller may read. Minds are untrusted:
 * a non-admin principal may only see its own history, so the client-supplied
 * `?mind=` param is ignored and forced to the caller's own (base) name.
 * Admin/system callers keep the requested filter.
 */
async function resolveMindFilter(c: Context<HistoryEnv>): Promise<string | undefined> {
  const user = c.get("user");
  const privileged = user.role === "admin" || user.role === "spirit";
  return privileged ? (c.req.query("mind") ?? undefined) : getBaseName(user.username);
}

type Db = Awaited<ReturnType<typeof getDb>>;

/** The event's worded label, stored on the row by recordEventRow. */
function eventLabelOf(metadata: string | null, channel: string): string {
  if (metadata) {
    try {
      const parsed = JSON.parse(metadata) as { label?: unknown };
      if (typeof parsed.label === "string" && parsed.label) return parsed.label;
    } catch {
      // Fall through to the channel-derived label.
    }
  }
  // `event:<type>:<id>` — fall back to the type segment for rows written before the
  // label was stored (or if the metadata is malformed).
  return channel.split(":")[1] || "Event";
}

/** Build conversation label from channel slug. */
function getChannelLabel(channel: string): { label: string; type: "dm" | "channel" } {
  const isDM = channel.startsWith("@");
  const colonIdx = channel.indexOf(":");
  const raw = colonIdx >= 0 ? channel.substring(colonIdx + 1) : channel;
  const label = isDM ? raw : raw.startsWith("#") ? raw : `#${raw}`;
  return { label, type: isDM ? "dm" : "channel" };
}

/**
 * Resolve channel/DM slugs to conversation UUIDs. `dmSlugMinds` maps each DM
 * slug to the minds whose history used it — a DM only resolves when the mind
 * is verified as a participant. Resolution failures degrade to an empty map
 * entry (callers fall back to the slug itself).
 */
async function resolveConversationIds(
  db: Db,
  allChannelSlugs: Set<string>,
  dmSlugMinds: Map<string, Set<string>>,
): Promise<Map<string, string>> {
  const channelIdMap = new Map<string, string>();
  try {
    if (allChannelSlugs.size > 0) {
      // Resolve channel conversations by name (strip # prefix, platform prefix)
      const channelNames = [...allChannelSlugs]
        .filter((s) => !s.startsWith("@"))
        .map((s) => {
          let name = s;
          if (name.startsWith("#")) name = name.slice(1);
          const colonIdx = name.indexOf(":");
          if (colonIdx >= 0) name = name.substring(colonIdx + 1);
          return { slug: s, name };
        });
      if (channelNames.length > 0) {
        const channelRows = await db
          .select({ conversationId: channels.conversation_id, name: channels.name })
          .from(channels)
          .where(
            inArray(
              channels.name,
              channelNames.map((c) => c.name),
            ),
          );
        const nameToId = new Map(channelRows.map((r) => [r.name, r.conversationId]));
        for (const { slug, name } of channelNames) {
          const id = nameToId.get(name);
          if (id) channelIdMap.set(slug, id);
        }
      }

      // Resolve DM conversations by participant username, verifying the mind is also a participant
      const dmSlugs = [...dmSlugMinds.keys()];
      if (dmSlugs.length > 0) {
        const targetNames = dmSlugs.map((s) => s.slice(1));
        const cp2 = db.$with("cp2").as(
          db
            .select({
              conversation_id: conversationParticipants.conversation_id,
              username: users.username,
            })
            .from(conversationParticipants)
            .innerJoin(users, eq(conversationParticipants.user_id, users.id)),
        );
        const dmRows = await db
          .with(cp2)
          .select({
            id: conversations.id,
            targetUsername: users.username,
          })
          .from(conversations)
          .innerJoin(
            conversationParticipants,
            eq(conversations.id, conversationParticipants.conversation_id),
          )
          .innerJoin(users, eq(conversationParticipants.user_id, users.id))
          .where(and(eq(conversations.type, "dm"), inArray(users.username, targetNames)));
        // Batch-verify mind participation in one query instead of per-DM
        const dmCandidates: { slug: string; conversationId: string; mindNames: string[] }[] = [];
        for (const row of dmRows) {
          const slug = `@${row.targetUsername}`;
          const mindNames = dmSlugMinds.get(slug);
          if (mindNames && !channelIdMap.has(slug)) {
            dmCandidates.push({ slug, conversationId: row.id, mindNames: [...mindNames] });
          }
        }
        if (dmCandidates.length > 0) {
          const candidateConvIds = dmCandidates.map((d) => d.conversationId);
          const allMindNames = [...new Set(dmCandidates.flatMap((d) => d.mindNames))];
          const verifyRows = await db
            .select({
              conversation_id: conversationParticipants.conversation_id,
              username: users.username,
            })
            .from(conversationParticipants)
            .innerJoin(users, eq(conversationParticipants.user_id, users.id))
            .where(
              and(
                inArray(conversationParticipants.conversation_id, candidateConvIds),
                inArray(users.username, allMindNames),
              ),
            );
          const verifiedConvs = new Set(verifyRows.map((r) => r.conversation_id));
          for (const candidate of dmCandidates) {
            if (verifiedConvs.has(candidate.conversationId)) {
              channelIdMap.set(candidate.slug, candidate.conversationId);
            }
          }
        }
      }
    }
  } catch (err) {
    log.warn("Failed to resolve channel slugs to conversation IDs", log.errorData(err));
  }
  return channelIdMap;
}

/** Activity types excluded from user-facing history (lifecycle/presence noise). */
const NOISE_ACTIVITY_TYPES = sql`('mind_started', 'mind_stopped', 'mind_active', 'mind_idle', 'mind_done', 'mind_sleeping', 'mind_waking', 'brain_online', 'brain_offline')`;

/** Grouped per-period icon data attached to summary rows via `?include=icons`. */
type SummaryIcons = {
  conversations: { id: string; label: string; type: "dm" | "channel"; count: number }[];
  events: { label: string; count: number }[];
  activities: {
    type: string;
    count: number;
    icon?: string;
    color?: string;
    items: {
      id: number;
      summary: string;
      metadata: Record<string, unknown> | null;
      created_at: string | null;
    }[];
  }[];
};

const PERIODIC_TIERS = new Set<string>(["hour", "day", "week", "month"]);

/**
 * Aggregate what happened during each summary's period — distinct conversations
 * (with message counts), system events grouped by label, activities grouped by
 * type — mirroring the per-turn conversations/events/activities structure at
 * period granularity. `_system` rows are skipped: their events live in per-mind
 * history, so a system-level aggregate would double-count across minds.
 */
async function attachSummaryIcons(
  db: Db,
  rows: { mind: string; period: string; period_key: string; icons?: SummaryIcons }[],
): Promise<void> {
  const allChannelSlugs = new Set<string>();
  const dmSlugMinds = new Map<string, Set<string>>();
  const pending: {
    row: (typeof rows)[number];
    convCounts: { channel: string; count: number }[];
    events: { label: string; count: number }[];
    activities: SummaryIcons["activities"];
  }[] = [];

  for (const row of rows) {
    if (row.mind === "_system" || !PERIODIC_TIERS.has(row.period)) continue;
    const { start, end } = getUtcTimeRange(row.period_key, row.period as TimerPeriod);

    // Conversations: message counts per channel slug (exact via GROUP BY).
    const convCounts = await db
      .select({ channel: mindHistory.channel, count: sql<number>`count(*)` })
      .from(mindHistory)
      .where(
        and(
          eq(mindHistory.mind, row.mind),
          sql`${mindHistory.type} IN ('inbound', 'outbound')`,
          gte(mindHistory.created_at, start),
          lt(mindHistory.created_at, end),
        ),
      )
      .groupBy(mindHistory.channel)
      .limit(50);
    for (const cc of convCounts) {
      if (!cc.channel) continue;
      allChannelSlugs.add(cc.channel);
      if (cc.channel.startsWith("@")) {
        let minds = dmSlugMinds.get(cc.channel);
        if (!minds) {
          minds = new Set();
          dmSlugMinds.set(cc.channel, minds);
        }
        minds.add(row.mind);
      }
    }

    // System events: grouped by worded label. Label lives in metadata JSON, so
    // grouping happens here; the fetch cap comfortably exceeds real volumes
    // (heartbeat-style events are the densest source).
    const eventRows = await db
      .select({ channel: mindHistory.channel, metadata: mindHistory.metadata })
      .from(mindHistory)
      .where(
        and(
          eq(mindHistory.mind, row.mind),
          eq(mindHistory.type, "event"),
          gte(mindHistory.created_at, start),
          lt(mindHistory.created_at, end),
        ),
      )
      .orderBy(mindHistory.created_at, mindHistory.id)
      .limit(2000);
    const eventGroups = new Map<string, number>();
    for (const ev of eventRows) {
      const label = eventLabelOf(ev.metadata, ev.channel ?? "");
      eventGroups.set(label, (eventGroups.get(label) ?? 0) + 1);
    }

    // Activities: grouped by type, newest-first fetch so item caps keep the
    // most recent; counts stay exact via a separate GROUP BY.
    const actCounts = await db
      .select({ type: activity.type, count: sql<number>`count(*)` })
      .from(activity)
      .where(
        and(
          eq(activity.mind, row.mind),
          gte(activity.created_at, start),
          lt(activity.created_at, end),
          sql`${activity.type} NOT IN ${NOISE_ACTIVITY_TYPES}`,
        ),
      )
      .groupBy(activity.type);
    let actGroups: SummaryIcons["activities"] = [];
    if (actCounts.length > 0) {
      const actRows = await db
        .select({
          id: activity.id,
          type: activity.type,
          summary: activity.summary,
          metadata: activity.metadata,
          created_at: activity.created_at,
        })
        .from(activity)
        .where(
          and(
            eq(activity.mind, row.mind),
            gte(activity.created_at, start),
            lt(activity.created_at, end),
            sql`${activity.type} NOT IN ${NOISE_ACTIVITY_TYPES}`,
          ),
        )
        .orderBy(desc(activity.created_at), desc(activity.id))
        .limit(200);
      const byType = new Map<string, SummaryIcons["activities"][number]>();
      for (const a of actRows) {
        let metadata: Record<string, unknown> | null = null;
        if (a.metadata) {
          try {
            metadata = JSON.parse(a.metadata);
          } catch (err) {
            log.debug(`malformed activity metadata for activity ${a.id}`, log.errorData(err));
          }
        }
        let group = byType.get(a.type);
        if (!group) {
          group = {
            type: a.type,
            count: 0,
            ...(typeof metadata?.icon === "string" ? { icon: metadata.icon } : {}),
            ...(typeof metadata?.color === "string" ? { color: metadata.color } : {}),
            items: [],
          };
          byType.set(a.type, group);
        }
        if (group.items.length < 20) {
          group.items.push({ id: a.id, summary: a.summary, metadata, created_at: a.created_at });
        }
      }
      const countByType = new Map(actCounts.map((c) => [c.type, c.count]));
      for (const group of byType.values()) {
        group.count = countByType.get(group.type) ?? group.items.length;
        group.items.reverse(); // chronological within the group
      }
      actGroups = [...byType.values()];
    }

    pending.push({
      row,
      convCounts: convCounts.filter((c): c is { channel: string; count: number } => !!c.channel),
      events: [...eventGroups.entries()].map(([label, count]) => ({ label, count })),
      activities: actGroups,
    });
  }

  if (pending.length === 0) return;
  const channelIdMap = await resolveConversationIds(db, allChannelSlugs, dmSlugMinds);

  for (const p of pending) {
    p.row.icons = {
      conversations: p.convCounts.map((cc) => {
        const { label, type } = getChannelLabel(cc.channel);
        return { id: channelIdMap.get(cc.channel) ?? cc.channel, label, type, count: cc.count };
      }),
      events: p.events,
      activities: p.activities,
    };
  }
}

const history = new Hono<HistoryEnv>()
  // Backstop: compute the caller's allowed mind scope once, up front. Handlers
  // read c.get("mindFilter") rather than each remembering to call the helper, so
  // a future route that forgets still can't leak another mind's history.
  .use("*", async (c, next) => {
    c.set("mindFilter", await resolveMindFilter(c));
    await next();
  })
  .get("/turns", async (c) => {
    const mindFilter = c.get("mindFilter");
    const turnIdFilter = c.req.query("turnId");
    const turnIdsFilter = c.req.query("turnIds");
    const limit = Math.min(Math.max(parseInt(c.req.query("limit") ?? "50", 10) || 50, 1), 200);
    const offset = Math.max(parseInt(c.req.query("offset") ?? "0", 10) || 0, 0);

    const db = await getDb();

    // 1. Get turns (optionally filtered by mind)
    const conditions = [];
    if (mindFilter) conditions.push(eq(turns.mind, mindFilter));
    if (turnIdFilter) conditions.push(eq(turns.id, turnIdFilter));
    if (turnIdsFilter) {
      const ids = turnIdsFilter.split(",").filter(Boolean);
      if (ids.length > 0) conditions.push(inArray(turns.id, ids));
    }
    const turnRows = await db
      .select()
      .from(turns)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(turns.created_at))
      .limit(limit)
      .offset(offset);

    if (turnRows.length === 0) return c.json([]);

    const turnIds = turnRows.map((t) => t.id);

    // 2. Get summaries from the unified summaries table
    const summaryRows = await db
      .select()
      .from(summaries)
      .where(and(eq(summaries.period, "turn"), inArray(summaries.period_key, turnIds)));
    const summaryByTurn = new Map<string, { content: string; metadata: string | null }>();
    for (const s of summaryRows) {
      summaryByTurn.set(s.period_key, { content: s.content, metadata: s.metadata });
    }

    // 3. Get inbound/event/outbound rows from mind_history for these turns.
    // We use mind_history instead of the messages table because mind_history has
    // correct per-mind turn_id tagging. The messages table can only hold one turn_id,
    // so mind-to-mind messages get tagged with the sender's turn, not the receiver's.
    const historyMsgRows = await db
      .select({
        id: mindHistory.id,
        mind: mindHistory.mind,
        type: mindHistory.type,
        channel: mindHistory.channel,
        sender: mindHistory.sender,
        content: mindHistory.content,
        metadata: mindHistory.metadata,
        turn_id: mindHistory.turn_id,
        created_at: mindHistory.created_at,
      })
      .from(mindHistory)
      .where(
        and(
          inArray(mindHistory.turn_id, turnIds),
          // `event` rows are system events, not messages. They're fetched here but split off
          // below into a separate per-turn `events` array — never into `conversations`, so no
          // surface can render them as chat with a phantom sender.
          sql`${mindHistory.type} IN ('inbound', 'event', 'outbound')`,
        ),
      )
      // id tiebreaker: created_at is second-resolution, so a same-second inbound/outbound
      // pair would otherwise flip and read as an answer-before-question exchange (#403).
      .orderBy(mindHistory.created_at, mindHistory.id);

    // Group all events by turn and channel
    type ConvEvent = {
      id: number;
      role: "user" | "assistant";
      sender: string | null;
      content: string | null;
      created_at: string | null;
    };
    const msgsByTurnChannel = new Map<string, Map<string, ConvEvent[]>>();

    /** A system event that triggered or arrived during a turn — never a conversation. */
    type SystemEventEntry = {
      id: number;
      label: string;
      content: string | null;
      created_at: string | null;
    };
    const systemEventsByTurn = new Map<string, SystemEventEntry[]>();

    function addToTurnChannel(turnId: string, channel: string, event: ConvEvent) {
      let byChannel = msgsByTurnChannel.get(turnId);
      if (!byChannel) {
        byChannel = new Map();
        msgsByTurnChannel.set(turnId, byChannel);
      }
      let arr = byChannel.get(channel);
      if (!arr) {
        arr = [];
        byChannel.set(channel, arr);
      }
      arr.push(event);
    }

    // Build a map of turn id -> mind name for sender resolution
    const turnMindMap = new Map<string, string>();
    for (const t of turnRows) turnMindMap.set(t.id, t.mind);

    // Split mind_history rows: messages into conversations, system events into their own
    // per-turn list. An event has no sender and no channel to reply to, so it must never
    // enter the conversation structure that the UI renders as chat.
    for (const m of historyMsgRows) {
      if (!m.turn_id || !m.channel) continue;
      if (m.type === "event") {
        const arr = systemEventsByTurn.get(m.turn_id) ?? [];
        arr.push({
          id: m.id,
          label: eventLabelOf(m.metadata, m.channel),
          content: m.content,
          created_at: m.created_at,
        });
        systemEventsByTurn.set(m.turn_id, arr);
        continue;
      }
      const mindName = turnMindMap.get(m.turn_id) ?? m.mind;
      addToTurnChannel(m.turn_id, m.channel, {
        id: m.id,
        role: m.type === "inbound" ? "user" : "assistant",
        sender: m.type === "inbound" ? (m.sender ?? null) : mindName,
        content: m.content,
        created_at: m.created_at,
      });
    }

    // 4. Get activities linked to these turns
    const activityRows = await db
      .select()
      .from(activity)
      .where(inArray(activity.turn_id, turnIds))
      // id tiebreaker: created_at is second-resolution, so same-second activities within a
      // turn would otherwise flip order (#403 — same missing tiebreaker as the message pairs).
      .orderBy(activity.created_at, activity.id);

    const activitiesByTurn = new Map<string, typeof activityRows>();
    for (const a of activityRows) {
      if (!a.turn_id) continue;
      let arr = activitiesByTurn.get(a.turn_id);
      if (!arr) {
        arr = [];
        activitiesByTurn.set(a.turn_id, arr);
      }
      arr.push(a);
    }

    // 5. Fetch trigger events for turns that have trigger_event_id
    const triggerIds = turnRows
      .filter((t) => t.trigger_event_id != null)
      .map((t) => t.trigger_event_id!);
    const triggerMap = new Map<
      number,
      {
        channel: string | null;
        sender: string | null;
        content: string | null;
        type: string;
        metadata: string | null;
      }
    >();
    if (triggerIds.length > 0) {
      const triggerRows = await db
        .select({
          id: mindHistory.id,
          channel: mindHistory.channel,
          sender: mindHistory.sender,
          content: mindHistory.content,
          type: mindHistory.type,
          metadata: mindHistory.metadata,
        })
        .from(mindHistory)
        .where(inArray(mindHistory.id, triggerIds));
      for (const r of triggerRows) triggerMap.set(r.id, r);
    }

    // 6. Resolve channel slugs to conversation UUIDs
    const allChannelSlugs = new Set<string>();
    for (const [, channels] of msgsByTurnChannel) {
      for (const ch of channels.keys()) allChannelSlugs.add(ch);
    }

    // Collect which minds use which DM slugs (needed to verify both participants)
    const dmSlugMinds = new Map<string, Set<string>>();
    for (const [turnId, channels] of msgsByTurnChannel) {
      const mindName = turnMindMap.get(turnId);
      if (!mindName) continue;
      for (const ch of channels.keys()) {
        if (ch.startsWith("@")) {
          let minds = dmSlugMinds.get(ch);
          if (!minds) {
            minds = new Set();
            dmSlugMinds.set(ch, minds);
          }
          minds.add(mindName);
        }
      }
    }

    const channelIdMap = await resolveConversationIds(db, allChannelSlugs, dmSlugMinds);

    // 7. Assemble response
    const result = turnRows.map((t) => {
      const summary = summaryByTurn.get(t.id);
      const turnChannels = msgsByTurnChannel.get(t.id) ?? new Map<string, ConvEvent[]>();
      const convEntries = [...turnChannels.entries()].map(([channel, evts]) => {
        const { label, type } = getChannelLabel(channel);
        return {
          id: channelIdMap.get(channel) ?? channel,
          label,
          type,
          messages: evts.map((m) => ({
            id: m.id,
            role: m.role as string,
            sender_name: m.sender,
            content: [{ type: "text", text: m.content ?? "" }],
            source_event_id: m.id,
            created_at: m.created_at,
          })),
        };
      });

      const turnActivities = (activitiesByTurn.get(t.id) ?? []).map((a) => {
        let metadata: Record<string, unknown> | null = null;
        if (a.metadata) {
          try {
            metadata = JSON.parse(a.metadata);
          } catch (err) {
            log.debug(`malformed activity metadata for activity ${a.id}`, log.errorData(err));
          }
        }
        return {
          id: a.id,
          type: a.type,
          summary: a.summary,
          metadata,
          source_event_id: a.source_event_id,
          created_at: a.created_at,
        };
      });

      let summaryMeta: Record<string, unknown> | null = null;
      if (summary?.metadata) {
        try {
          summaryMeta = JSON.parse(summary.metadata);
        } catch (err) {
          log.debug(`malformed summary metadata for turn ${t.id}`, log.errorData(err));
        }
      }

      const trigger = t.trigger_event_id ? triggerMap.get(t.trigger_event_id) : null;
      // A turn triggered by a system event is not a conversation: nothing is waiting on a
      // reply, and the mind's closing text is a private reflection, not an answer. The flag
      // lets the timeline say so instead of rendering it like a chat exchange.
      const isEventTrigger = trigger?.type === "event";

      return {
        id: t.id,
        mind: t.mind,
        summary: summary?.content ?? null,
        summary_meta: summaryMeta,
        status: t.status,
        created_at: t.created_at,
        trigger: trigger
          ? {
              // The trigger's mind_history row id — matches events[].id /
              // messages[].source_event_id so the UI can dedupe the trigger
              // from the per-turn icon stack.
              eventId: t.trigger_event_id,
              channel: trigger.channel,
              sender: trigger.sender,
              content: trigger.content,
              ...(isEventTrigger && trigger.channel
                ? {
                    event: {
                      type: trigger.channel.split(":")[1] || "event",
                      label: eventLabelOf(trigger.metadata, trigger.channel),
                    },
                  }
                : {}),
            }
          : null,
        conversations: convEntries,
        events: systemEventsByTurn.get(t.id) ?? [],
        activities: turnActivities,
      };
    });

    return c.json(result);
  })
  .get("/events", async (c) => {
    const mindFilter = c.get("mindFilter");

    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        const send = (data: string) => {
          controller.enqueue(encoder.encode(`data: ${data}\n\n`));
        };

        let unsubscribe: (() => void) | undefined;
        const pingInterval = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(": ping\n\n"));
          } catch {
            clearInterval(pingInterval);
            unsubscribe?.();
          }
        }, 15000);

        if (mindFilter) {
          unsubscribe = subscribeMindEvent(mindFilter, (event) => {
            try {
              send(JSON.stringify(event));
            } catch {
              clearInterval(pingInterval);
              unsubscribe?.();
            }
          });
        } else {
          unsubscribe = subscribeAll((event) => {
            try {
              send(JSON.stringify(event));
            } catch {
              clearInterval(pingInterval);
              unsubscribe?.();
            }
          });
        }

        c.req.raw.signal.addEventListener("abort", () => {
          clearInterval(pingInterval);
          unsubscribe?.();
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        });
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  })
  .get("/summaries", async (c) => {
    const user = c.get("user");
    const privileged = user.role === "admin" || user.role === "spirit";
    // mindFilter is the caller's allowed scope: the requested mind for
    // privileged callers (undefined if none), or the caller's own base name for
    // minds. Summaries default an unscoped privileged read to the system
    // timeline (`_system`) rather than all minds — this asymmetry is
    // intentional and load-bearing for the system timeline view.
    const mind = c.get("mindFilter") ?? "_system";
    const period = c.req.query("period");
    const ids = c.req.query("ids"); // comma-separated summary IDs
    const from = c.req.query("from");
    const to = c.req.query("to");
    const limit = Math.min(Math.max(parseInt(c.req.query("limit") ?? "50", 10) || 50, 1), 200);

    // If fetching by IDs, skip other filters
    if (ids) {
      const db = await getDb();
      const idList = ids
        .split(",")
        .map((s) => parseInt(s, 10))
        .filter((n) => !Number.isNaN(n));
      if (idList.length === 0) return c.json([]);
      // Non-admin callers are still constrained to their own mind's summaries.
      const idConditions = [inArray(summaries.id, idList)];
      if (!privileged) idConditions.push(eq(summaries.mind, mind));
      const rows = await db
        .select()
        .from(summaries)
        .where(and(...idConditions));
      const result = rows.map((r) => {
        let metadata: Record<string, unknown> | null = null;
        if (r.metadata) {
          try {
            metadata = JSON.parse(r.metadata);
          } catch (err) {
            log.debug(`malformed summary metadata for id ${r.id}`, log.errorData(err));
          }
        }
        return { ...r, metadata };
      });
      return c.json(result);
    }

    if (!period || !["turn", "hour", "day", "week", "month"].includes(period)) {
      return c.json({ error: "period is required (turn, hour, day, week, month)" }, 400);
    }

    const db = await getDb();
    const conditions = [eq(summaries.mind, mind), eq(summaries.period, period)];

    // Week period keys are ISO-week format ("YYYY-Www"), which does not sort
    // against date-format ("YYYY-MM-DD") bounds under binary collation. When a
    // caller passes date bounds for the week tier, translate them to the ISO
    // week key of the week *containing* that date so the string comparison is
    // correct (a week straddling the bound is included when any day falls in
    // range). Other tiers already use prefix-compatible date keys.
    const normalizeBound = (bound: string) =>
      period === "week" ? isoWeekKeyForDateStr(bound) : bound;

    // `--to <date>` must mean "through the end of that day" in every tier, the way it
    // does on the default history route. These keys are not timestamps, so the shared
    // normalizer (which yields "… 23:59:59") is the wrong tool: hour keys are
    // "YYYY-MM-DDTHH", and "T" sorts *after* a space, so a bare date bound silently
    // dropped the whole day being asked for. Extend it to that day's last hour key
    // instead. Day/month keys are already prefix-compatible and need nothing.
    const normalizeEndBound = (bound: string) =>
      period === "hour" && /^\d{4}-\d{2}-\d{2}$/.test(bound)
        ? `${bound}T23`
        : normalizeBound(bound);

    if (from) conditions.push(gte(summaries.period_key, normalizeBound(from)));
    if (to) conditions.push(sql`${summaries.period_key} <= ${normalizeEndBound(to)}`);

    const rows = await db
      .select({
        id: summaries.id,
        mind: summaries.mind,
        period: summaries.period,
        period_key: summaries.period_key,
        content: summaries.content,
        metadata: summaries.metadata,
        created_at: summaries.created_at,
      })
      .from(summaries)
      .where(and(...conditions))
      .orderBy(desc(summaries.period_key))
      .limit(limit);

    const result = rows.map((r) => {
      let metadata: Record<string, unknown> | null = null;
      if (r.metadata) {
        try {
          metadata = JSON.parse(r.metadata);
        } catch (err) {
          log.debug(`malformed meta_summary metadata for id ${r.id}`, log.errorData(err));
        }
      }
      return { ...r, metadata } as (typeof rows)[number] & {
        metadata: Record<string, unknown> | null;
        icons?: SummaryIcons;
      };
    });

    if (c.req.query("include") === "icons") {
      await attachSummaryIcons(db, result);
    }

    return c.json(result);
  })
  .get("/activity", async (c) => {
    const mind = c.get("mindFilter");
    // A bare `to` date compared raw against `created_at` excluded the whole day the
    // caller asked for, so `--period day --to <today>` printed a header with nothing
    // under it. Same normalization as the default history route.
    let from: string;
    let to: string;
    try {
      from = normalizeDbBound(c.req.query("from"), "start");
      to = normalizeDbBound(c.req.query("to"), "end");
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
    const limit = Math.min(Math.max(parseInt(c.req.query("limit") ?? "100", 10) || 100, 1), 500);

    const db = await getDb();
    const conditions = [];
    if (mind) conditions.push(eq(activity.mind, mind));
    if (from) conditions.push(gte(activity.created_at, from));
    if (to) conditions.push(sql`${activity.created_at} <= ${to}`);

    // Exclude noise events (mind lifecycle, brain presence)
    conditions.push(sql`${activity.type} NOT IN ${NOISE_ACTIVITY_TYPES}`);

    const rows = await db
      .select({
        id: activity.id,
        type: activity.type,
        mind: activity.mind,
        summary: activity.summary,
        metadata: activity.metadata,
        created_at: activity.created_at,
      })
      .from(activity)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(activity.created_at))
      .limit(limit);

    const result = rows.map((r) => {
      let metadata: Record<string, unknown> | null = null;
      if (r.metadata) {
        try {
          metadata = JSON.parse(r.metadata);
        } catch (err) {
          log.debug(`malformed activity metadata for id ${r.id}`, log.errorData(err));
        }
      }
      return { ...r, metadata };
    });

    return c.json(result);
  });

export default history;
