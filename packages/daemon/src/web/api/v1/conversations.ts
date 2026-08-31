import { zValidator } from "@hono/zod-validator";
import { isMind } from "@volute/api/user-type";
import { type Context, Hono } from "hono";
import { z } from "zod";
import { getOrCreateMindUser, getUserByUsername } from "../../../lib/auth.js";
import {
  createConversation,
  deleteConversation,
  deleteConversationForUser,
  findDMConversation,
  getConversation,
  getMessagesPaginated,
  getParticipantRole,
  getParticipants,
  isParticipantOrOwner,
  listConversationsWithParticipants,
  markConversationRead,
  setConversationPrivate,
} from "../../../lib/events/conversations.js";
import { findMind } from "../../../lib/mind/registry.js";
import { cursorParamsSchema, cursorResponse } from "../../../lib/util/query-params.js";
import { type AuthEnv, authMiddleware } from "../../middleware/auth.js";
import { hasSystemAuthority } from "../../middleware/effective-principal.js";

const createSchema = z.object({
  participantNames: z.array(z.string()).min(1),
});

/**
 * Whether `user` may read conversation `id`. Missing → false (404). Non-private →
 * readable by any authenticated principal (deliberate transparency for the home
 * feed). Private → participant/owner, admin, system, or the internal system caller
 * (user.id === 0) only.
 */
async function canReadConversation(c: Context<AuthEnv>, id: string): Promise<boolean> {
  const conv = await getConversation(id);
  if (!conv) return false;
  if (conv.private !== 1) return true;
  const user = c.get("user");
  if (user.id === 0 || hasSystemAuthority(c.get("effective"))) return true;
  return isParticipantOrOwner(id, user.id);
}

const app = new Hono<AuthEnv>()
  .use("*", authMiddleware)
  .get("/", async (c) => {
    const user = c.get("user");
    const convs = await listConversationsWithParticipants(user.id);
    return c.json(convs);
  })
  .get("/:id/messages", zValidator("query", cursorParamsSchema), async (c) => {
    const id = c.req.param("id");
    // Non-private conversations are readable by any authenticated user — deliberate;
    // powers the home feed transcript modal (mirrors GET /api/v1/minds/:name/
    // conversations/:convId/messages, AUTHZ_EXEMPT). Private conversations stay
    // scoped to participants (or admin/system).
    if (!(await canReadConversation(c, id))) {
      return c.json({ error: "Conversation not found" }, 404);
    }

    const { before, limit } = c.req.valid("query");
    const result = await getMessagesPaginated(id, { before, limit });
    return c.json(cursorResponse(result.messages, result.hasMore));
  })
  .get("/:id/participants", async (c) => {
    const id = c.req.param("id");
    // Same read semantics as /:id/messages: non-private conversations are readable
    // by any authenticated user (powers the home feed); private ones stay scoped.
    if (!(await canReadConversation(c, id))) {
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
        if (!firstMindName && isMind(existing)) firstMindName = name;
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

    const conv = await createConversation({
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

    // A channel is shared, and deleting it destroys the room and its entire history for
    // every participant. That takes the same authority as changing its settings: otherwise
    // the owner-only settings guard is trivially bypassed — a mind held to a limit could
    // delete the channel and re-create it as its own owner with no limits at all.
    const conv = await getConversation(id);
    if (conv?.type === "channel") {
      const isAdmin = hasSystemAuthority(c.get("effective"));
      if (!isAdmin && (await getParticipantRole(id, user.id)) !== "owner") {
        return c.json({ error: "Forbidden" }, 403);
      }
      // An admin need not be a member to clean up a channel, so bypass the
      // participant-scoped helper here.
      await deleteConversation(id);
      return c.json({ ok: true });
    }

    const deleted = await deleteConversationForUser(id, user.id);
    if (!deleted) return c.json({ error: "Conversation not found" }, 404);
    return c.json({ ok: true });
  });

export default app;
