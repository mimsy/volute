import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { getOrCreateAgentUser, getUser, getUserByUsername } from "../../lib/auth.js";
import {
  createConversation,
  deleteConversationForUser,
  getMessages,
  getParticipants,
  isParticipantOrOwner,
  listConversationsForUser,
} from "../../lib/conversations.js";
import { findAgent } from "../../lib/registry.js";
import type { AuthEnv } from "../middleware/auth.js";

const createConvSchema = z.object({
  title: z.string().optional(),
  participantIds: z.array(z.number()).optional(),
  participantNames: z.array(z.string()).optional(),
});

const app = new Hono<AuthEnv>()
  .get("/:name/conversations", async (c) => {
    const name = c.req.param("name");
    const user = c.get("user");

    // Daemon token (id: 0) lists as the agent
    let lookupId = user.id;
    if (user.id === 0) {
      const agentUser = await getOrCreateAgentUser(name);
      lookupId = agentUser.id;
    }

    const all = await listConversationsForUser(lookupId);
    const convs = all.filter((c) => c.agent_name === name);
    return c.json(convs);
  })
  .post("/:name/conversations", zValidator("json", createConvSchema), async (c) => {
    const name = c.req.param("name");
    const user = c.get("user");
    const body = c.req.valid("json");

    if (!body.participantIds?.length && !body.participantNames?.length) {
      return c.json({ error: "participantIds or participantNames required" }, 400);
    }

    // Ensure the named agent is a participant
    const agentUser = await getOrCreateAgentUser(name);

    // Build participant list: creator first (owner), then agent, then others
    const participantSet = new Set<number>();
    if (user.id !== 0) participantSet.add(user.id);
    participantSet.add(agentUser.id);
    for (const id of body.participantIds ?? []) participantSet.add(id);

    // Resolve participant names to IDs (auto-creating agent users for registered agents)
    if (body.participantNames) {
      for (const pname of body.participantNames) {
        const existing = await getUserByUsername(pname);
        if (existing) {
          participantSet.add(existing.id);
          continue;
        }
        // If name matches a registered agent, auto-create agent user
        if (findAgent(pname)) {
          const au = await getOrCreateAgentUser(pname);
          participantSet.add(au.id);
          continue;
        }
        return c.json({ error: `User not found: ${pname}` }, 400);
      }
    }

    // Validate all participant IDs exist
    for (const id of participantSet) {
      if (id === user.id || id === agentUser.id) continue;
      const u = await getUser(id);
      if (!u) return c.json({ error: `User ${id} not found` }, 400);
    }

    const conv = await createConversation(name, "volute", {
      userId: user.id !== 0 ? user.id : undefined,
      title: body.title,
      participantIds: [...participantSet],
    });

    return c.json(conv, 201);
  })
  .get("/:name/conversations/:id/messages", async (c) => {
    const id = c.req.param("id");
    const user = c.get("user");
    if (user.id !== 0 && !(await isParticipantOrOwner(id, user.id))) {
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
