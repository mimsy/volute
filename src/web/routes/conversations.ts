import { Hono } from "hono";
import {
  deleteConversationForUser,
  getConversationForUser,
  getMessages,
  listConversations,
} from "../../lib/conversations.js";
import type { AuthEnv } from "../middleware/auth.js";

const app = new Hono<AuthEnv>()
  .get("/:name/conversations", async (c) => {
    const name = c.req.param("name");
    const user = c.get("user");
    const convs = await listConversations(name, { userId: user.id });
    return c.json(convs);
  })
  .get("/:name/conversations/:id/messages", async (c) => {
    const id = c.req.param("id");
    const user = c.get("user");
    const conv = await getConversationForUser(id, user.id);
    if (!conv) return c.json({ error: "Conversation not found" }, 404);
    const msgs = await getMessages(id);
    return c.json(msgs);
  })
  .delete("/:name/conversations/:id", async (c) => {
    const id = c.req.param("id");
    const user = c.get("user");
    const deleted = await deleteConversationForUser(id, user.id);
    if (!deleted) return c.json({ error: "Conversation not found" }, 404);
    return c.json({ ok: true });
  });

export default app;
