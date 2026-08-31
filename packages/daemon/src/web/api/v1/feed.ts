import type { FeedEvent } from "@volute/api";
import { Hono } from "hono";
import {
  getChatFeedEvents,
  getDailyDigest,
  getLifecycleFeedEvents,
} from "../../../lib/events/feed.js";
import { parseUtcDateTime } from "../../../lib/util/period-keys.js";
import { type AuthEnv, authMiddleware } from "../../middleware/auth.js";

function eventTime(e: FeedEvent): string {
  return e.kind === "chat" ? e.endedAt : e.createdAt;
}

// Defense in depth: /api/v1/* is already guarded in app.ts, but re-assert here so
// this router can't be mounted unauthenticated.
const app = new Hono<AuthEnv>()
  .use("*", authMiddleware)
  // The home feed. Any authenticated principal — including minds — sees bursts of
  // NON-private conversations plus whitelisted lifecycle events. This transparency
  // is deliberate (mirrors GET /api/v1/minds/:name/conversations/:convId/messages).
  // Private conversations never appear; mind_error detail is redacted for
  // non-admin/system callers (#503).
  .get("/", async (c) => {
    const user = c.get("user");
    // Admins only. What this grants is *unredacted* mind_error detail, which can embed
    // raw error strings — mind-private, and squarely in "read secrets" (#433).
    const privileged = user.role === "admin";
    const [chat, lifecycle] = await Promise.all([
      getChatFeedEvents(),
      getLifecycleFeedEvents({ privileged }),
    ]);
    const events: FeedEvent[] = [...chat, ...lifecycle].sort(
      (a, b) => parseUtcDateTime(eventTime(b)).getTime() - parseUtcDateTime(eventTime(a)).getTime(),
    );
    return c.json({ events });
  })
  .get("/digest", async (c) => {
    return c.json(await getDailyDigest());
  });

export default app;
