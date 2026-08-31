import type { SSEConversationAddedEvent } from "@volute/api/events";
import { desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { getDb } from "../../../lib/db.js";
import { subscribe as subscribeActivity } from "../../../lib/events/activity-events.js";
import {
  addConnection,
  getOnlineBrains,
  removeConnection,
} from "../../../lib/events/brain-presence.js";
import {
  type ConversationEvent,
  subscribe as subscribeConversation,
  subscribeParticipantAdded,
} from "../../../lib/events/conversation-events.js";
import {
  getConversationWithParticipants,
  getUnreadCounts,
  listConversationsWithParticipants,
} from "../../../lib/events/conversations.js";
import { getEventsSince, nextEventId } from "../../../lib/events/event-sequencer.js";
import { getActiveMinds } from "../../../lib/events/mind-activity-tracker.js";
import { getBaseName } from "../../../lib/mind/registry.js";
import { activity } from "../../../lib/schema.js";
import log from "../../../lib/util/logger.js";
import { type AuthEnv, authMiddleware } from "../../middleware/auth.js";
import { hasAdminAuthority } from "../../middleware/effective-principal.js";

const app = new Hono<AuthEnv>().use("*", authMiddleware).get("/", async (c) => {
  const user = c.get("user");
  const since = c.req.query("since");
  const sinceId = since ? Number(since) : 0;

  // Minds are untrusted: a non-admin principal may only see its own
  // activity (activity.summary is an AI-generated summary of a mind's turn).
  // `activityMind === undefined` means a privileged caller with the global feed.
  // Admin authority only, and never *borrowed* admin authority: this is a stream, and
  // authority is captured once at connect — a spirit that opened it during a verified
  // admin's turn would keep the global firehose long after that turn ended, converting
  // one in-turn moment of delegated authority into a standing subscription. Delegation
  // covers discrete requests; streams take an authority of your own (#433).
  const effective = c.get("effective");
  const privileged = hasAdminAuthority(effective) && !effective?.actingFor;
  const activityMind = privileged ? undefined : await getBaseName(user.username);

  return streamSSE(c, async (stream) => {
    const cleanups: (() => void)[] = [];
    if (user.user_type === "human") {
      addConnection(user.username);
      cleanups.push(() => removeConnection(user.username));
    }

    try {
      // Fetch the caller's conversations up front — needed for replay audience
      // filtering, the snapshot, and the live conversation subscriptions.
      let conversations: any[] = [];
      try {
        conversations = await listConversationsWithParticipants(user.id);
        if (conversations.length > 0) {
          const convIds = conversations.map((c: any) => c.id);
          const unreads = await getUnreadCounts(user.id, convIds, user.username);
          for (const conv of conversations) {
            conv.unreadCount = unreads[conv.id] ?? 0;
          }
        }
      } catch (err) {
        log.error("[v1-events] failed to fetch conversations", log.errorData(err));
      }
      const allowedConversationIds = new Set<string>(conversations.map((c: any) => c.id));

      // If reconnecting with a valid sinceId, replay only the buffered events
      // the caller is entitled to (their own conversation events + their own
      // mind's activity, or the global feed for privileged callers). Other
      // users' events and per-connect snapshots are filtered out.
      if (sinceId > 0) {
        const missed = getEventsSince(sinceId, allowedConversationIds, activityMind);
        for (const event of missed) {
          await stream.writeSSE({
            id: String(event.id),
            data: JSON.stringify(event.data),
          });
        }
      }

      // Build and send snapshot
      let recentActivity: any[] = [];
      try {
        const db = await getDb();
        recentActivity = await db
          .select()
          .from(activity)
          .where(activityMind ? eq(activity.mind, activityMind) : undefined)
          .orderBy(desc(activity.created_at))
          .limit(50);
        recentActivity = recentActivity.map((row) => ({
          ...row,
          metadata: row.metadata ? JSON.parse(row.metadata) : null,
        }));
      } catch (err) {
        log.error("[v1-events] failed to fetch recent activity", log.errorData(err));
      }

      const snapshotData = {
        event: "snapshot" as const,
        activity: recentActivity,
        conversations,
        activeMinds: getActiveMinds(),
        onlineBrains: getOnlineBrains(),
      };

      // The snapshot is connection-specific (this user's conversations, unread
      // counts, etc.) — allocate an ID but do NOT buffer it, so it can never be
      // replayed to another connection.
      const snapshotId = nextEventId();

      await stream.writeSSE({
        id: String(snapshotId),
        data: JSON.stringify(snapshotData),
      });

      // Subscribe to activity events. Non-privileged callers only see their own
      // mind's activity live; the buffer still records every event globally so
      // the audience filter is re-applied on reconnect replay too.
      const unsubActivity = subscribeActivity((event) => {
        // The event was already buffered exactly once at the publish site (activity-events
        // notify), so we forward here using its shared `seq` rather than re-buffering per
        // connection. The audience filter still gates live delivery; reconnect replay
        // re-applies it via getEventsSince against the globally-buffered copy.
        if (activityMind !== undefined && event.mind !== activityMind) return;
        const { seq, ...rest } = event;
        const data = {
          event: "activity" as const,
          ...rest,
          metadata: rest.metadata ?? null,
        };
        stream
          .writeSSE({
            id: String(seq),
            data: JSON.stringify(data),
          })
          .catch((err) => {
            if (!stream.aborted) log.error("[v1-events] write error:", log.errorData(err));
          });
      });
      cleanups.push(unsubActivity);

      // Subscribe to conversation events for a single conversation, forwarding
      // its messages to this stream.
      const subscribedConvIds = new Set<string>(conversations.map((c: any) => c.id));
      function subscribeToConversation(convId: string) {
        const unsubConv = subscribeConversation(convId, (event) => {
          // Buffered once at the publish site (conversation-events publish); forward
          // using the shared `seq` instead of re-buffering per subscribed connection.
          const { seq, ...rest } = event;
          const data = { event: "conversation" as const, conversationId: convId, ...rest };
          stream
            .writeSSE({
              id: String(seq),
              data: JSON.stringify(data),
            })
            .catch((err) => {
              if (!stream.aborted) log.error("[v1-events] write error:", log.errorData(err));
            });
        });
        cleanups.push(unsubConv);
      }

      // Subscribe to conversation events for each conversation known at connect.
      for (const conv of conversations) {
        subscribeToConversation(conv.id);
      }

      // A conversation created after connect (e.g. a seed's first DM) has no
      // subscription above, so its messages would only surface on reload. When
      // this caller becomes a participant of such a conversation, subscribe live
      // and push a `conversation_added` event so the client can add it to its
      // list immediately. The event is connection-specific, so allocate an ID
      // without buffering (like the snapshot) — reconnect rebuilds via snapshot.
      const unsubParticipant = subscribeParticipantAdded(({ conversationId, userId }) => {
        if (userId !== user.id || subscribedConvIds.has(conversationId)) return;
        subscribedConvIds.add(conversationId);

        // The client drops message events for conversations it doesn't yet know
        // about, and the first message can be published before the (async,
        // DB-backed) conversation_added is written. Queue this conversation's
        // messages until conversation_added has been sent, then flush in order,
        // so the first message's preview/unread is never lost.
        function forward(event: ConversationEvent & { seq: number }) {
          const { seq, ...rest } = event;
          const data = { event: "conversation" as const, conversationId, ...rest };
          stream.writeSSE({ id: String(seq), data: JSON.stringify(data) }).catch((err) => {
            if (!stream.aborted) log.error("[v1-events] write error:", log.errorData(err));
          });
        }
        let queued: Array<ConversationEvent & { seq: number }> | null = [];
        const unsubConv = subscribeConversation(conversationId, (event) => {
          if (queued) queued.push(event);
          else forward(event);
        });
        cleanups.push(unsubConv);

        getConversationWithParticipants(conversationId)
          .then((conv) => {
            if (!conv) {
              log.error("[v1-events] conversation_added: enrich returned null", { conversationId });
              return;
            }
            const data: SSEConversationAddedEvent = {
              event: "conversation_added",
              conversation: conv,
            };
            return stream.writeSSE({ id: String(nextEventId()), data: JSON.stringify(data) });
          })
          .catch((err) => {
            if (!stream.aborted)
              log.error("[v1-events] conversation_added error:", log.errorData(err));
          })
          .finally(() => {
            const pending = queued ?? [];
            queued = null;
            for (const event of pending) forward(event);
          });
      });
      cleanups.push(unsubParticipant);

      // Keep-alive pings every 15s
      const keepAlive = setInterval(() => {
        stream.writeSSE({ data: "" }).catch((err) => {
          if (!stream.aborted) log.error("[v1-events] ping error:", log.errorData(err));
        });
      }, 15000);
      cleanups.push(() => clearInterval(keepAlive));

      // Wait for disconnect
      await new Promise<void>((resolve) => {
        stream.onAbort(() => resolve());
      });
    } finally {
      for (const cleanup of cleanups) {
        try {
          cleanup();
        } catch {
          // ignore cleanup errors
        }
      }
    }
  });
});

export default app;
