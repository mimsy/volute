import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { getOrCreateMindUser, getUserByUsername } from "../../../lib/auth.js";
import { subscribe } from "../../../lib/conversation-events.js";
import {
  createConversation,
  deleteConversationForUser,
  getMessages,
  isParticipantOrOwner,
  listConversationsWithParticipants,
} from "../../../lib/conversations.js";
import { findMind } from "../../../lib/registry.js";
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

    // Resolve participant names → IDs, find the first mind for routing
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
  .get("/:id/events", async (c) => {
    const conversationId = c.req.param("id");
    const user = c.get("user");
    if (user.id !== 0 && !(await isParticipantOrOwner(conversationId, user.id))) {
      return c.json({ error: "Conversation not found" }, 404);
    }

    return streamSSE(c, async (stream) => {
      const unsubscribe = subscribe(conversationId, (event) => {
        stream.writeSSE({ data: JSON.stringify(event) }).catch((err) => {
          if (!stream.aborted) console.error("[chat] SSE write error:", err);
        });
      });

      const keepAlive = setInterval(() => {
        stream.writeSSE({ data: "" }).catch((err) => {
          if (!stream.aborted) console.error("[chat] SSE ping error:", err);
        });
      }, 15000);

      await new Promise<void>((resolve) => {
        stream.onAbort(() => {
          unsubscribe();
          clearInterval(keepAlive);
          resolve();
        });
      });
    });
  })
  .delete("/:id", async (c) => {
    const id = c.req.param("id");
    const user = c.get("user");
    const deleted = await deleteConversationForUser(id, user.id);
    if (!deleted) return c.json({ error: "Conversation not found" }, 404);
    return c.json({ ok: true });
  });

export default app;
