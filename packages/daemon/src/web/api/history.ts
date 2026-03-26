import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { getDb } from "../../lib/db.js";
import { subscribeAll, subscribe as subscribeMindEvent } from "../../lib/events/mind-events.js";
import log from "../../lib/logger.js";
import {
  activity,
  conversationParticipants,
  conversations,
  mindHistory,
  summaries,
  turns,
  users,
} from "../../lib/schema.js";

const history = new Hono()
  .get("/turns", async (c) => {
    const mindFilter = c.req.query("mind");
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

    // 3. Get inbound/outbound events from mind_history for these turns.
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
        turn_id: mindHistory.turn_id,
        created_at: mindHistory.created_at,
      })
      .from(mindHistory)
      .where(
        and(
          inArray(mindHistory.turn_id, turnIds),
          sql`${mindHistory.type} IN ('inbound', 'outbound')`,
        ),
      )
      .orderBy(mindHistory.created_at);

    // Group all events by turn and channel
    type ConvEvent = {
      id: number;
      role: "user" | "assistant";
      sender: string | null;
      content: string | null;
      created_at: string | null;
    };
    const msgsByTurnChannel = new Map<string, Map<string, ConvEvent[]>>();

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

    // Add inbound and outbound events from mind_history
    for (const m of historyMsgRows) {
      if (!m.turn_id || !m.channel) continue;
      const mindName = turnMindMap.get(m.turn_id) ?? m.mind;
      addToTurnChannel(m.turn_id, m.channel, {
        id: m.id,
        role: m.type === "inbound" ? "user" : "assistant",
        sender: m.type === "inbound" ? (m.sender ?? null) : mindName,
        content: m.content,
        created_at: m.created_at,
      });
    }

    // Build conversation label from channel slug
    function getChannelLabel(channel: string): { label: string; type: "dm" | "channel" } {
      const isDM = channel.startsWith("@");
      const colonIdx = channel.indexOf(":");
      const raw = colonIdx >= 0 ? channel.substring(colonIdx + 1) : channel;
      const label = isDM ? raw : raw.startsWith("#") ? raw : `#${raw}`;
      return { label, type: isDM ? "dm" : "channel" };
    }

    // 4. Get activities linked to these turns
    const activityRows = await db
      .select()
      .from(activity)
      .where(inArray(activity.turn_id, turnIds))
      .orderBy(activity.created_at);

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
      { channel: string | null; sender: string | null; content: string | null }
    >();
    if (triggerIds.length > 0) {
      const triggerRows = await db
        .select({
          id: mindHistory.id,
          channel: mindHistory.channel,
          sender: mindHistory.sender,
          content: mindHistory.content,
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
            .select({ id: conversations.id, name: conversations.name })
            .from(conversations)
            .where(
              and(
                eq(conversations.type, "channel"),
                inArray(
                  conversations.name,
                  channelNames.map((c) => c.name),
                ),
              ),
            );
          const nameToId = new Map(channelRows.map((r) => [r.name, r.id]));
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
          for (const row of dmRows) {
            const slug = `@${row.targetUsername}`;
            const mindNames = dmSlugMinds.get(slug);
            if (mindNames && !channelIdMap.has(slug)) {
              // Verify the mind is also a participant in this conversation
              const mindCheck = await db
                .select({ id: conversationParticipants.user_id })
                .from(conversationParticipants)
                .innerJoin(users, eq(conversationParticipants.user_id, users.id))
                .where(
                  and(
                    eq(conversationParticipants.conversation_id, row.id),
                    inArray(users.username, [...mindNames]),
                  ),
                )
                .get();
              if (mindCheck) channelIdMap.set(slug, row.id);
            }
          }
        }
      }
    } catch (err) {
      log.warn("Failed to resolve channel slugs to conversation IDs", log.errorData(err));
    }

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

      return {
        id: t.id,
        mind: t.mind,
        summary: summary?.content ?? null,
        summary_meta: summaryMeta,
        status: t.status,
        created_at: t.created_at,
        trigger: trigger
          ? { channel: trigger.channel, sender: trigger.sender, content: trigger.content }
          : null,
        conversations: convEntries,
        activities: turnActivities,
      };
    });

    return c.json(result);
  })
  .get("/events", async (c) => {
    const mindFilter = c.req.query("mind");

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
    const mind = c.req.query("mind") ?? "_system";
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
        .filter((n) => !isNaN(n));
      if (idList.length === 0) return c.json([]);
      const rows = await db.select().from(summaries).where(inArray(summaries.id, idList));
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

    if (from) conditions.push(gte(summaries.period_key, from));
    if (to) conditions.push(sql`${summaries.period_key} <= ${to}`);

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
      return { ...r, metadata };
    });

    return c.json(result);
  })
  .get("/activity", async (c) => {
    const mind = c.req.query("mind");
    const from = c.req.query("from");
    const to = c.req.query("to");
    const limit = Math.min(Math.max(parseInt(c.req.query("limit") ?? "100", 10) || 100, 1), 500);

    const db = await getDb();
    const conditions = [];
    if (mind) conditions.push(eq(activity.mind, mind));
    if (from) conditions.push(gte(activity.created_at, from));
    if (to) conditions.push(sql`${activity.created_at} <= ${to}`);

    // Exclude noise events (mind lifecycle, brain presence)
    conditions.push(
      sql`${activity.type} NOT IN ('mind_started', 'mind_stopped', 'mind_active', 'mind_idle', 'mind_done', 'mind_sleeping', 'mind_waking', 'brain_online', 'brain_offline')`,
    );

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
        } catch {
          // ignore malformed metadata
        }
      }
      return { ...r, metadata };
    });

    return c.json(result);
  });

export default history;
