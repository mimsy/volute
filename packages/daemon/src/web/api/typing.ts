import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { getTypingMap, isConversationId } from "../../lib/chat/typing.js";
import { publish } from "../../lib/events/conversation-events.js";
import type { AuthEnv } from "../middleware/auth.js";
import { refusedSenderMessage } from "./chat.js";

const typingSchema = z.object({
  channel: z.string().min(1),
  sender: z.string().min(1).optional(),
  active: z.boolean(),
});

const app = new Hono<AuthEnv>()
  .post("/:name/typing", zValidator("json", typingSchema), (c) => {
    const { channel, sender: requested, active } = c.req.valid("json");

    // Same rule as POST /api/v1/chat: a caller may only act as itself. `sender` is
    // rendered verbatim to everyone watching the channel as "X is typing", so an
    // arbitrary value here puts a name nobody chose into a live presence line — the
    // #500 misattribution, transient rather than persisted. The name broadcast is the
    // authenticated principal's, and asking for another is refused rather than
    // silently rewritten. Passing your own name is not impersonation: the web
    // composer sends its own username on every keystroke burst.
    const user = c.get("user");
    if (requested && user.id !== 0 && requested !== user.username) {
      return c.json({ error: refusedSenderMessage(requested, user.username) }, 403);
    }
    const sender = user.id === 0 && requested ? requested : user.username;

    const map = getTypingMap();
    if (active) {
      map.set(channel, sender);
    } else {
      map.delete(channel, sender);
    }

    // Push typing state to conversation SSE subscribers for volute channels
    if (isConversationId(channel)) {
      publish(channel, { type: "typing", senders: map.get(channel) });
    }

    return c.json({ ok: true });
  })
  .get("/:name/typing", (c) => {
    const channel = c.req.query("channel");
    if (!channel) {
      return c.json({ error: "channel query param is required" }, 400);
    }

    const map = getTypingMap();
    return c.json({ typing: map.get(channel) });
  });

export default app;
