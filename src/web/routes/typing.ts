import { Hono } from "hono";
import { getTypingMap } from "../../lib/typing.js";
import type { AuthEnv } from "../middleware/auth.js";

const app = new Hono<AuthEnv>()
  .post("/:name/typing", async (c) => {
    const body = await c.req.json();
    const { channel, sender, active } = body;

    if (!channel || !sender) {
      return c.json({ error: "channel and sender are required" }, 400);
    }

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
