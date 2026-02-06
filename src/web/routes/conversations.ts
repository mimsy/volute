import { Hono } from "hono";
import { deleteConversation, getMessages, listConversations } from "../../lib/conversations.js";
import type { AuthEnv } from "../middleware/auth.js";

const app = new Hono<AuthEnv>();

app.get("/:name/conversations", async (c) => {
  const name = c.req.param("name");
  const user = c.get("user");
  const convs = await listConversations(name, { userId: user.id });
  return c.json(convs);
});

app.get("/:name/conversations/:id/messages", async (c) => {
  const id = c.req.param("id");
  const msgs = await getMessages(id);
  return c.json(msgs);
});

app.delete("/:name/conversations/:id", async (c) => {
  const id = c.req.param("id");
  await deleteConversation(id);
  return c.json({ ok: true });
});

export default app;
