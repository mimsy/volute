import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { getOrCreateAgentUser, getUserByUsername } from "../../../lib/auth.js";
import {
  createConversation,
  deleteConversationForUser,
  getMessages,
  isParticipantOrOwner,
  listConversationsWithParticipants,
} from "../../../lib/conversations.js";
import { findAgent } from "../../../lib/registry.js";
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
    const msgs = await getMessages(id);
    return c.json(msgs);
  })
  .post("/", zValidator("json", createSchema), async (c) => {
    const user = c.get("user");
    const body = c.req.valid("json");

    // Resolve participant names → IDs, find the first agent for routing
    const participantIds = new Set<number>();
    if (user.id !== 0) participantIds.add(user.id);
    let firstAgentName: string | undefined;

    for (const name of body.participantNames) {
      const existing = await getUserByUsername(name);
      if (existing) {
        participantIds.add(existing.id);
        if (!firstAgentName && existing.user_type === "agent") firstAgentName = name;
        continue;
      }
      if (findAgent(name)) {
        const au = await getOrCreateAgentUser(name);
        participantIds.add(au.id);
        if (!firstAgentName) firstAgentName = name;
        continue;
      }
      return c.json({ error: `User not found: ${name}` }, 400);
    }

    if (!firstAgentName) {
      return c.json({ error: "At least one agent participant is required" }, 400);
    }

    const conv = await createConversation(firstAgentName, "volute", {
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
