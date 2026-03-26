import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { getOrCreateMindUser, getUserByUsername } from "../../../lib/auth.js";
import {
  createConversation,
  deleteConversationForUser,
  findDMConversation,
  getConversation,
  getMessagesPaginated,
  getParticipants,
  isParticipantOrOwner,
  listConversationsWithParticipants,
  markConversationRead,
  setConversationPrivate,
} from "../../../lib/events/conversations.js";
import { findMind } from "../../../lib/registry.js";
import { type AuthEnv, authMiddleware } from "../../middleware/auth.js";

const createSchema = z.object({
  participantNames: z.array(z.string()).min(1),
});

const app = new Hono<AuthEnv>()
  .use("*", authMiddleware)
  .get("/", async (c) => {
    const user = c.get("user");
    const convs = await listConversationsWithParticipants(user.id);
    return c.json(convs);
  })
  .get("/:id/messages", async (c) => {
    const id = c.req.param("id");
    const user = c.get("user");
    if (user.id !== 0 && !(await isParticipantOrOwner(id, user.id))) {
      return c.json({ error: "Conversation not found" }, 404);
    }

    const beforeStr = c.req.query("before");
    const limitStr = c.req.query("limit");
    const before = beforeStr ? parseInt(beforeStr, 10) : undefined;
    const limit = limitStr ? parseInt(limitStr, 10) : undefined;
    if (
      (before !== undefined && Number.isNaN(before)) ||
      (limit !== undefined && Number.isNaN(limit))
    ) {
      return c.json({ error: "Invalid cursor params: before and limit must be integers" }, 400);
    }

    const result = await getMessagesPaginated(id, { before, limit });
    return c.json({ items: result.messages, hasMore: result.hasMore });
  })
  .get("/:id/participants", async (c) => {
    const id = c.req.param("id");
    const user = c.get("user");
    if (user.id !== 0 && !(await isParticipantOrOwner(id, user.id))) {
      return c.json({ error: "Conversation not found" }, 404);
    }
    const participants = await getParticipants(id);
    return c.json(participants);
  })
  .post("/", zValidator("json", createSchema), async (c) => {
    const user = c.get("user");
    const body = c.req.valid("json");

    const participantIds = new Set<number>();
    if (user.id !== 0) participantIds.add(user.id);
    let firstMindName: string | undefined;

    for (const name of body.participantNames) {
      const existing = await getUserByUsername(name);
      if (existing) {
        participantIds.add(existing.id);
        if (!firstMindName && existing.user_type === "mind") firstMindName = name;
        continue;
      }
      if (await findMind(name)) {
        const au = await getOrCreateMindUser(name);
        participantIds.add(au.id);
        if (!firstMindName) firstMindName = name;
        continue;
      }
      return c.json({ error: `User not found: ${name}` }, 400);
    }

    if (!firstMindName) {
      return c.json({ error: "At least one mind participant is required" }, 400);
    }

    if (participantIds.size > 2) {
      return c.json({ error: "Use channels for multi-participant conversations" }, 400);
    }

    const ids = [...participantIds];

    // DM reuse: if exactly 2 participants, return existing conversation if found
    if (ids.length === 2) {
      const existingId = await findDMConversation(ids as [number, number]);
      if (existingId) {
        const existing = await getConversation(existingId);
        if (existing) return c.json(existing);
      }
    }

    const conv = await createConversation("volute", {
      userId: user.id !== 0 ? user.id : undefined,
      participantIds: ids,
    });

    return c.json(conv, 201);
  })
  .post("/:id/read", async (c) => {
    const id = c.req.param("id");
    const user = c.get("user");
    if (user.id === 0) return c.json({ ok: true });
    if (!(await isParticipantOrOwner(id, user.id))) {
      return c.json({ error: "Conversation not found" }, 404);
    }
    await markConversationRead(user.id, id);
    return c.json({ ok: true });
  })
  .put("/:id/private", zValidator("json", z.object({ private: z.boolean() })), async (c) => {
    const id = c.req.param("id");
    const user = c.get("user");
    if (!(await isParticipantOrOwner(id, user.id))) {
      return c.json({ error: "Forbidden" }, 403);
    }
    const body = c.req.valid("json");
    await setConversationPrivate(id, body.private);
    return c.json({ ok: true });
  })
  .delete("/:id", async (c) => {
    const id = c.req.param("id");
    const user = c.get("user");
    const deleted = await deleteConversationForUser(id, user.id);
    if (!deleted) return c.json({ error: "Conversation not found" }, 404);
    return c.json({ ok: true });
  });

export default app;
