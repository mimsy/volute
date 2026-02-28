import { zValidator } from "@hono/zod-validator";
import { findMind } from "@volute/shared/registry";
import { Hono } from "hono";
import { z } from "zod";
import { getOrCreateMindUser, getUserByUsername } from "../../../lib/auth.js";
import {
  createConversation,
  deleteConversationForUser,
  getMessages,
  getMessagesPaginated,
  getParticipants,
  isParticipantOrOwner,
  listConversationsWithParticipants,
} from "../../../lib/events/conversations.js";
import { type AuthEnv, authMiddleware } from "../../middleware/auth.js";

const createSchema = z.object({
  title: z.string().optional(),
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

    const before = c.req.query("before");
    const limit = c.req.query("limit");

    // If no cursor params, return all messages (backwards compat)
    if (!before && !limit) {
      const msgs = await getMessages(id);
      return c.json({ items: msgs, hasMore: false });
    }

    const result = await getMessagesPaginated(id, {
      before: before ? Number(before) : undefined,
      limit: limit ? Number(limit) : undefined,
    });
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
      if (findMind(name)) {
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

    const conv = await createConversation(firstMindName, "volute", {
      userId: user.id !== 0 ? user.id : undefined,
      title: body.title,
      participantIds: [...participantIds],
    });

    return c.json(conv, 201);
  })
  .delete("/:id", async (c) => {
    const id = c.req.param("id");
    const user = c.get("user");
    const deleted = await deleteConversationForUser(id, user.id);
    if (!deleted) return c.json({ error: "Conversation not found" }, 404);
    return c.json({ ok: true });
  });

export default app;
