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
import { subscribe as subscribeConversation } from "../../../lib/events/conversation-events.js";
import {
  getUnreadCounts,
  listConversationsWithParticipants,
} from "../../../lib/events/conversations.js";
import { bufferEvent, getEventsSince, nextEventId } from "../../../lib/events/event-sequencer.js";
import { getActiveMinds } from "../../../lib/events/mind-activity-tracker.js";
import { getBaseName } from "../../../lib/mind/registry.js";
import { activity } from "../../../lib/schema.js";
import log from "../../../lib/util/logger.js";
import { type AuthEnv, authMiddleware } from "../../middleware/auth.js";

const app = new Hono<AuthEnv>().use("*", authMiddleware).get("/", async (c) => {
  const user = c.get("user");
  const since = c.req.query("since");
  const sinceId = since ? Number(since) : 0;

  // Minds are untrusted: a non-admin/system principal may only see its own
  // activity (activity.summary is an AI-generated summary of a mind's turn).
  // `activityMind === undefined` means a privileged caller with the global feed.
  const privileged = user.role === "admin" || user.role === "system";
  const activityMind = privileged ? undefined : await getBaseName(user.username);

  return streamSSE(c, async (stream) => {
    const cleanups: (() => void)[] = [];
    if (user.user_type === "brain") {
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
          const unreads = await getUnreadCounts(user.id, convIds);
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
        const data = {
          event: "activity" as const,
          ...event,
          metadata: event.metadata ?? null,
        };
        // Buffer every event globally first so the audience filter is re-applied
        // on reconnect replay (getEventsSince) rather than dropping events that
        // this connection isn't entitled to see live.
        const eventId = bufferEvent(data);
        if (activityMind !== undefined && event.mind !== activityMind) return;
        stream
          .writeSSE({
            id: String(eventId),
            data: JSON.stringify(data),
          })
          .catch((err) => {
            if (!stream.aborted) log.error("[v1-events] write error:", log.errorData(err));
          });
      });
      cleanups.push(unsubActivity);

      // Subscribe to conversation events for each user conversation
      for (const conv of conversations) {
        const unsubConv = subscribeConversation(conv.id, (event) => {
          const data = { event: "conversation" as const, conversationId: conv.id, ...event };
          const eventId = bufferEvent(data);
          stream
            .writeSSE({
              id: String(eventId),
              data: JSON.stringify(data),
            })
            .catch((err) => {
              if (!stream.aborted) log.error("[v1-events] write error:", log.errorData(err));
            });
        });
        cleanups.push(unsubConv);
      }

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
