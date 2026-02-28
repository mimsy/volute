import { zValidator } from "@hono/zod-validator";
import { findMind } from "@volute/shared/registry";
import { Hono } from "hono";
import { z } from "zod";
import { getOrCreateMindUser, getUser, getUserByUsername } from "../../../lib/auth.js";
import {
  createConversation,
  deleteConversationForUser,
  findDMConversation,
  getConversation,
  getMessages,
  getParticipants,
  isParticipantOrOwner,
  listConversationsForUser,
} from "../../../lib/events/conversations.js";
import type { AuthEnv } from "../../middleware/auth.js";

const createConvSchema = z.object({
  title: z.string().optional(),
  participantIds: z.array(z.number()).optional(),
  participantNames: z.array(z.string()).optional(),
});

const app = new Hono<AuthEnv>()
  .get("/:name/conversations", async (c) => {
    const name = c.req.param("name");
    const user = c.get("user");

    // Daemon token (id: 0) lists as the mind
    let lookupId = user.id;
    if (user.id === 0) {
      const mindUser = await getOrCreateMindUser(name);
      lookupId = mindUser.id;
    }

    const all = await listConversationsForUser(lookupId);
    const convs = all.filter((c) => c.mind_name === name || c.type === "channel");
    return c.json(convs);
  })
  .post("/:name/conversations", zValidator("json", createConvSchema), async (c) => {
    const name = c.req.param("name");
    const user = c.get("user");
    const body = c.req.valid("json");

    if (!body.participantIds?.length && !body.participantNames?.length) {
      return c.json({ error: "participantIds or participantNames required" }, 400);
    }

    // Ensure the named mind is a participant
    const mindUser = await getOrCreateMindUser(name);

    // Build participant list: creator first (owner), then mind, then others
    const participantSet = new Set<number>();
    if (user.id !== 0) participantSet.add(user.id);
    participantSet.add(mindUser.id);
    for (const id of body.participantIds ?? []) participantSet.add(id);

    // Resolve participant names to IDs (auto-creating mind users for registered minds)
    if (body.participantNames) {
      for (const pname of body.participantNames) {
        const existing = await getUserByUsername(pname);
        if (existing) {
          participantSet.add(existing.id);
          continue;
        }
        // If name matches a registered mind, auto-create mind user
        if (findMind(pname)) {
          const au = await getOrCreateMindUser(pname);
          participantSet.add(au.id);
          continue;
        }
        return c.json({ error: `User not found: ${pname}` }, 400);
      }
    }

    // Validate all participant IDs exist
    for (const id of participantSet) {
      if (id === user.id || id === mindUser.id) continue;
      const u = await getUser(id);
      if (!u) return c.json({ error: `User ${id} not found` }, 400);
    }

    const participantIds = [...participantSet];

    // DM reuse: if exactly 2 participants, return existing conversation if found
    if (participantIds.length === 2) {
      const existingId = await findDMConversation(name, participantIds as [number, number]);
      if (existingId) {
        const conv = await getConversation(existingId);
        if (conv) return c.json(conv);
        console.warn(`[conversations] DM conversation ${existingId} found but not retrievable`);
      }
    }

    // Default title from participant names when none provided
    let title = body.title;
    if (!title && body.participantNames?.length) {
      title = body.participantNames.join(", ");
    }

    const conv = await createConversation(name, "volute", {
      userId: user.id !== 0 ? user.id : undefined,
      title,
      participantIds,
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
    // Daemon token (id: 0) can access any conversation
    if (user.id !== 0 && !(await isParticipantOrOwner(id, user.id))) {
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
