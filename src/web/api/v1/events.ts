import { desc } from "drizzle-orm";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { getDb } from "../../../lib/db.js";
import { subscribe as subscribeActivity } from "../../../lib/events/activity-events.js";
import { subscribe as subscribeConversation } from "../../../lib/events/conversation-events.js";
import { listConversationsWithParticipants } from "../../../lib/events/conversations.js";
import { bufferEvent, getEventsSince } from "../../../lib/events/event-sequencer.js";
import { getActiveMinds } from "../../../lib/events/mind-activity-tracker.js";
import log from "../../../lib/logger.js";
import { getCachedRecentPages, getCachedSites } from "../../../lib/pages-watcher.js";
import { activity } from "../../../lib/schema.js";
import { type AuthEnv, authMiddleware } from "../../middleware/auth.js";

const app = new Hono<AuthEnv>().use("*", authMiddleware).get("/", async (c) => {
  const user = c.get("user");
  const since = c.req.query("since");
  const sinceId = since ? Number(since) : 0;

  return streamSSE(c, async (stream) => {
    const cleanups: (() => void)[] = [];

    try {
      // If reconnecting with a valid sinceId, replay buffered events
      if (sinceId > 0) {
        const missed = getEventsSince(sinceId);
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
          .orderBy(desc(activity.created_at))
          .limit(50);
        recentActivity = recentActivity.map((row) => ({
          ...row,
          metadata: row.metadata ? JSON.parse(row.metadata) : null,
        }));
      } catch (err) {
        log.error("[v1-events] failed to fetch recent activity", log.errorData(err));
      }

      let conversations: any[] = [];
      try {
        conversations = await listConversationsWithParticipants(user.id);
      } catch (err) {
        log.error("[v1-events] failed to fetch conversations", log.errorData(err));
      }

      const sites = getCachedSites();
      const recentPages = getCachedRecentPages();

      const snapshotData = {
        event: "snapshot" as const,
        activity: recentActivity,
        conversations,
        sites,
        recentPages,
        activeMinds: getActiveMinds(),
      };

      const snapshotId = bufferEvent(snapshotData);

      await stream.writeSSE({
        id: String(snapshotId),
        data: JSON.stringify(snapshotData),
      });

      // Subscribe to activity events
      const unsubActivity = subscribeActivity((event) => {
        const data = {
          event: "activity" as const,
          ...event,
          metadata: event.metadata ?? null,
        };
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
