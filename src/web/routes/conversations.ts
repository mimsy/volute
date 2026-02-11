import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { getOrCreateAgentUser, getUser } from "../../lib/auth.js";
import {
  createConversation,
  deleteConversationForUser,
  getMessages,
  getParticipants,
  isParticipantOrOwner,
  listConversationsForUser,
} from "../../lib/conversations.js";
import type { AuthEnv } from "../middleware/auth.js";

const createConvSchema = z.object({
  title: z.string().optional(),
  participantIds: z.array(z.number()).min(1),
});

const app = new Hono<AuthEnv>()
  .get("/:name/conversations", async (c) => {
    const name = c.req.param("name");
    const user = c.get("user");
    const all = await listConversationsForUser(user.id);
    const convs = all.filter((c) => c.agent_name === name);
    return c.json(convs);
  })
  .post("/:name/conversations", zValidator("json", createConvSchema), async (c) => {
    const name = c.req.param("name");
    const user = c.get("user");
    const body = c.req.valid("json");

    // Ensure the named agent is a participant
    const agentUser = await getOrCreateAgentUser(name);

    // Build participant list: current user + specified IDs + agent
    const participantSet = new Set([user.id, agentUser.id, ...body.participantIds]);

    // Validate all participant IDs exist
    for (const id of participantSet) {
      if (id === user.id || id === agentUser.id) continue;
      const u = await getUser(id);
      if (!u) return c.json({ error: `User ${id} not found` }, 400);
    }

    const conv = await createConversation(name, "volute", {
      userId: user.id,
      title: body.title,
      participantIds: [...participantSet],
    });

    return c.json(conv, 201);
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
