import { Hono } from "hono";
import { deleteConversation, getMessages, listConversations } from "../../lib/conversations.js";
import type { AuthEnv } from "../middleware/auth.js";

const app = new Hono<AuthEnv>();

app.get("/:name/conversations", (c) => {
  const name = c.req.param("name");
  const user = c.get("user");
  const conversations = listConversations(name, { userId: user.id });
  return c.json(conversations);
});

app.get("/:name/conversations/:id/messages", (c) => {
  const id = c.req.param("id");
  const messages = getMessages(id);
  return c.json(messages);
});

app.delete("/:name/conversations/:id", (c) => {
  const id = c.req.param("id");
  deleteConversation(id);
  return c.json({ ok: true });
});

export default app;
