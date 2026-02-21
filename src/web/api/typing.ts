import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { getTypingMap } from "../../lib/typing.js";
import type { AuthEnv } from "../middleware/auth.js";

const typingSchema = z.object({
  channel: z.string().min(1),
  sender: z.string().min(1),
  active: z.boolean(),
});

const app = new Hono<AuthEnv>()
  .post("/:name/typing", zValidator("json", typingSchema), (c) => {
    const { channel, sender, active } = c.req.valid("json");

    const map = getTypingMap();
    if (active) {
      map.set(channel, sender);
    } else {
      map.delete(channel, sender);
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
