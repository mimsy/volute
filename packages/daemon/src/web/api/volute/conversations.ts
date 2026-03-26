import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { getOrCreateMindUser, getUser, getUserByUsername } from "../../../lib/auth.js";
import {
  createConversation,
  deleteConversationForUser,
  findDMConversation,
  getConversation,
  getMessages,
  getMessagesPaginated,
  getParticipants,
  isParticipantOrOwner,
  listConversationsForUser,
} from "../../../lib/events/conversations.js";
import { findMind } from "../../../lib/registry.js";
import type { AuthEnv } from "../../middleware/auth.js";

const createConvSchema = z.object({
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

    const convs = await listConversationsForUser(lookupId);
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
        let existing = await getUserByUsername(pname);
        // Try un-slugifying: discord-user → discord:user (puppet usernames use platform:id format)
        if (!existing) {
          const hyphenIdx = pname.indexOf("-");
          if (hyphenIdx > 0) {
            const prefix = pname.slice(0, hyphenIdx);
            if (["discord", "slack", "telegram"].includes(prefix)) {
              existing = await getUserByUsername(`${prefix}:${pname.slice(hyphenIdx + 1)}`);
            }
          }
        }
        if (existing) {
          participantSet.add(existing.id);
          continue;
        }
        // If name matches a registered mind, auto-create mind user
        if (await findMind(pname)) {
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

    // Reject group DMs — use channels for 3+ participants
    if (participantIds.length > 2) {
      return c.json({ error: "Use channels for multi-participant conversations" }, 400);
    }

    // DM reuse: if exactly 2 participants, return existing conversation if found
    if (participantIds.length === 2) {
      const existingId = await findDMConversation(participantIds as [number, number]);
      if (existingId) {
        const conv = await getConversation(existingId);
        if (conv) return c.json(conv);
        console.warn(`[conversations] DM conversation ${existingId} found but not retrievable`);
      }
    }

    const conv = await createConversation("volute", {
      userId: user.id !== 0 ? user.id : undefined,
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
    const limitStr = c.req.query("limit");
    const beforeStr = c.req.query("before");
    if (!limitStr && !beforeStr) {
      const msgs = await getMessages(id);
      return c.json({ items: msgs, hasMore: false });
    }
    const limit = limitStr ? parseInt(limitStr, 10) : undefined;
    const before = beforeStr ? parseInt(beforeStr, 10) : undefined;
    if (
      (limit !== undefined && !Number.isFinite(limit)) ||
      (before !== undefined && !Number.isFinite(before))
    ) {
      return c.json({ error: "Invalid pagination parameters" }, 400);
    }
    const result = await getMessagesPaginated(id, { before, limit });
    return c.json({ items: result.messages, hasMore: result.hasMore });
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
