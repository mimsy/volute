import { and, desc, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { getDb } from "../../lib/db.js";
import { subscribeAll, subscribe as subscribeMindEvent } from "../../lib/events/mind-events.js";
import log from "../../lib/logger.js";
import {
  activity,
  conversationParticipants,
  conversations,
  messages,
  mindHistory,
  turns,
  users,
} from "../../lib/schema.js";

const history = new Hono()
  .get("/turns", async (c) => {
    const mindFilter = c.req.query("mind");
    const turnIdFilter = c.req.query("turnId");
    const limit = Math.min(Math.max(parseInt(c.req.query("limit") ?? "50", 10) || 50, 1), 200);
    const offset = Math.max(parseInt(c.req.query("offset") ?? "0", 10) || 0, 0);

    const db = await getDb();

    // 1. Get turns (optionally filtered by mind)
    const conditions = [];
    if (mindFilter) conditions.push(eq(turns.mind, mindFilter));
    if (turnIdFilter) conditions.push(eq(turns.id, turnIdFilter));
    const turnRows = await db
      .select()
      .from(turns)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(turns.created_at))
      .limit(limit)
      .offset(offset);

    if (turnRows.length === 0) return c.json([]);

    const turnIds = turnRows.map((t) => t.id);

    // 2. Get summaries
    const summaryConditions = [
      eq(mindHistory.type, "summary"),
      inArray(mindHistory.turn_id, turnIds),
    ];
    const summaryRows = await db
      .select()
      .from(mindHistory)
      .where(and(...summaryConditions));
    const summaryByTurn = new Map<string, { content: string; metadata: string | null }>();
    for (const s of summaryRows) {
      if (s.turn_id)
        summaryByTurn.set(s.turn_id, { content: s.content ?? "", metadata: s.metadata });
    }

    // 3. Get conversation messages linked to these turns
    const msgRows = await db
      .select({
        id: messages.id,
        conversation_id: messages.conversation_id,
        role: messages.role,
        sender_name: messages.sender_name,
        content: messages.content,
        source_event_id: messages.source_event_id,
        turn_id: messages.turn_id,
        created_at: messages.created_at,
      })
      .from(messages)
      .where(inArray(messages.turn_id, turnIds))
      .orderBy(messages.created_at);

    // Group messages by turn and conversation
    type MsgRow = (typeof msgRows)[number];
    const msgsByTurnConv = new Map<string, Map<string, MsgRow[]>>();
    const convIds = new Set<string>();
    for (const m of msgRows) {
      if (!m.turn_id) continue;
      let byConv = msgsByTurnConv.get(m.turn_id);
      if (!byConv) {
        byConv = new Map();
        msgsByTurnConv.set(m.turn_id, byConv);
      }
      let arr = byConv.get(m.conversation_id);
      if (!arr) {
        arr = [];
        byConv.set(m.conversation_id, arr);
      }
      arr.push(m);
      convIds.add(m.conversation_id);
    }

    // Fetch conversation metadata + participants for referenced conversations
    type ConvMeta = { id: string; type: string; name: string | null; title: string | null };
    const convMeta = new Map<string, ConvMeta>();
    const convParticipantsMap = new Map<
      string,
      { username: string; displayName: string | null }[]
    >();
    if (convIds.size > 0) {
      const convIdsArr = [...convIds];
      const convRows = await db
        .select({
          id: conversations.id,
          type: conversations.type,
          name: conversations.name,
          title: conversations.title,
        })
        .from(conversations)
        .where(inArray(conversations.id, convIdsArr));
      for (const c2 of convRows) convMeta.set(c2.id, c2);

      const cpRows = await db
        .select({
          conversationId: conversationParticipants.conversation_id,
          username: users.username,
          displayName: users.display_name,
        })
        .from(conversationParticipants)
        .innerJoin(users, eq(conversationParticipants.user_id, users.id))
        .where(inArray(conversationParticipants.conversation_id, convIdsArr));
      for (const cp of cpRows) {
        let arr = convParticipantsMap.get(cp.conversationId);
        if (!arr) {
          arr = [];
          convParticipantsMap.set(cp.conversationId, arr);
        }
        arr.push({ username: cp.username, displayName: cp.displayName });
      }
    }

    // Build conversation label — needs mind name for DM "other" resolution
    function getConvLabel(convId: string, mindName: string): string {
      const meta = convMeta.get(convId);
      if (!meta) return "Conversation";
      if (meta.type === "channel" && meta.name) return `#${meta.name}`;
      const parts = convParticipantsMap.get(convId) ?? [];
      if (meta.type === "dm" && parts.length === 2) {
        const other = parts.find((p) => p.username !== mindName);
        if (other) return `@${other.displayName || other.username}`;
      }
      if (meta.title) return meta.title;
      return "Conversation";
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

    // 6. Assemble response
    const result = turnRows.map((t) => {
      const summary = summaryByTurn.get(t.id);
      const turnConvs = msgsByTurnConv.get(t.id) ?? new Map<string, MsgRow[]>();
      const convEntries = [...turnConvs.entries()].map(([convId, msgs]) => {
        const meta = convMeta.get(convId);
        return {
          id: convId,
          label: getConvLabel(convId, t.mind),
          type: (meta?.type ?? "dm") as "dm" | "channel",
          messages: msgs.map((m) => {
            let content: unknown[];
            try {
              const parsed = JSON.parse(m.content);
              content = Array.isArray(parsed) ? parsed : [{ type: "text", text: m.content }];
            } catch {
              content = [{ type: "text", text: m.content }];
            }
            return {
              id: m.id,
              role: m.role,
              sender_name: m.sender_name,
              content,
              source_event_id: m.source_event_id,
              created_at: m.created_at,
            };
          }),
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
  });

export default history;
