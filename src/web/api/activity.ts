import { desc } from "drizzle-orm";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { subscribe as subscribeActivity } from "../../lib/activity-events.js";
import { subscribe as subscribeConversation } from "../../lib/conversation-events.js";
import { listConversationsWithParticipants } from "../../lib/conversations.js";
import { getDb } from "../../lib/db.js";
import log from "../../lib/logger.js";
import { getCachedRecentPages, getCachedSites } from "../../lib/pages-watcher.js";
import { activity } from "../../lib/schema.js";
import type { AuthEnv } from "../middleware/auth.js";

const app = new Hono<AuthEnv>().get("/events", async (c) => {
  const user = c.get("user");

  return streamSSE(c, async (stream) => {
    const cleanups: (() => void)[] = [];

    // Build snapshot
    try {
      // Fetch activity from DB
      let recentActivity: any[] = [];
      try {
        const db = await getDb();
        recentActivity = await db
          .select()
          .from(activity)
          .orderBy(desc(activity.created_at))
          .limit(50);
        // Parse metadata JSON
        recentActivity = recentActivity.map((row) => ({
          ...row,
          metadata: row.metadata ? JSON.parse(row.metadata) : null,
        }));
      } catch (err) {
        log.error("[activity-sse] failed to fetch recent activity", log.errorData(err));
      }

      // Fetch conversations for this user
      let conversations: any[] = [];
      try {
        conversations = await listConversationsWithParticipants(user.id);
      } catch (err) {
        log.error("[activity-sse] failed to fetch conversations", log.errorData(err));
      }

      // Get cached pages data
      const sites = getCachedSites();
      const recentPages = getCachedRecentPages();

      // Send snapshot
      await stream.writeSSE({
        data: JSON.stringify({
          event: "snapshot",
          activity: recentActivity,
          conversations,
          sites,
          recentPages,
        }),
      });

      // Subscribe to activity events
      const unsubActivity = subscribeActivity((event) => {
        stream
          .writeSSE({
            data: JSON.stringify({ event: "activity", ...event }),
          })
          .catch((err) => {
            if (!stream.aborted) log.error("[activity-sse] write error:", log.errorData(err));
          });
      });
      cleanups.push(unsubActivity);

      // Subscribe to conversation events for each user conversation
      for (const conv of conversations) {
        const unsubConv = subscribeConversation(conv.id, (event) => {
          stream
            .writeSSE({
              data: JSON.stringify({ event: "conversation", conversationId: conv.id, ...event }),
            })
            .catch((err) => {
              if (!stream.aborted) log.error("[activity-sse] write error:", log.errorData(err));
            });
        });
        cleanups.push(unsubConv);
      }

      // Keep-alive pings
      const keepAlive = setInterval(() => {
        stream.writeSSE({ data: "" }).catch((err) => {
          if (!stream.aborted) log.error("[activity-sse] ping error:", log.errorData(err));
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
