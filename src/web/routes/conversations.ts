import { Hono } from "hono";
import {
  deleteConversationForUser,
  getMessages,
  getParticipants,
  isParticipantOrOwner,
  listConversationsForUser,
} from "../../lib/conversations.js";
import type { AuthEnv } from "../middleware/auth.js";

const app = new Hono<AuthEnv>()
  .get("/:name/conversations", async (c) => {
    const name = c.req.param("name");
    const user = c.get("user");
    const all = await listConversationsForUser(user.id);
    const convs = all.filter((c) => c.agent_name === name);
    return c.json(convs);
  })
  .get("/:name/conversations/:id/messages", async (c) => {
    const id = c.req.param("id");
    const user = c.get("user");
    if (!(await isParticipantOrOwner(id, user.id))) {
      return c.json({ error: "Conversation not found" }, 404);
    }
    const msgs = await getMessages(id);
    return c.json(msgs);
  })
  .get("/:name/conversations/:id/participants", async (c) => {
    const id = c.req.param("id");
    const user = c.get("user");
    if (!(await isParticipantOrOwner(id, user.id))) {
      return c.json({ error: "Conversation not found" }, 404);
    }
    const participants = await getParticipants(id);
    return c.json(participants);
  })
  .delete("/:name/conversations/:id", async (c) => {
    const id = c.req.param("id");
    const user = c.get("user");
    const deleted = await deleteConversationForUser(id, user.id);
    if (!deleted) return c.json({ error: "Conversation not found" }, 404);
    return c.json({ ok: true });
  });

export default app;
