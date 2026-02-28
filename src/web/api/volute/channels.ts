import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { getOrCreateMindUser, getUserByUsername } from "../../../lib/auth.js";
import {
  addMessage,
  createChannel,
  getChannelByName,
  getParticipants,
  isParticipant,
  joinChannel,
  leaveChannel,
  listChannels,
} from "../../../lib/events/conversations.js";
import { findMind } from "../../../lib/registry.js";
import type { AuthEnv } from "../../middleware/auth.js";

const createSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(50)
    .regex(/^[a-z0-9][a-z0-9-]*$/, "Channel names must be lowercase alphanumeric with hyphens"),
});

const inviteSchema = z.object({
  username: z.string().min(1),
});

const app = new Hono<AuthEnv>()
  .get("/", async (c) => {
    const user = c.get("user");
    const channels = await listChannels();
    const results = await Promise.all(
      channels.map(async (ch) => {
        const participants = await getParticipants(ch.id);
        const isMember = participants.some((p) => p.userId === user.id);
        return { ...ch, participantCount: participants.length, isMember };
      }),
    );
    return c.json(results);
  })
  .post("/", zValidator("json", createSchema), async (c) => {
    const user = c.get("user");
    const body = c.req.valid("json");

    try {
      const ch = await createChannel(body.name, user.id);
      return c.json(ch, 201);
    } catch (err: unknown) {
      const cause =
        err instanceof Error
          ? (err as { cause?: { code?: string; extendedCode?: string; message?: string } }).cause
          : null;
      if (cause && /UNIQUE/i.test(cause.extendedCode ?? cause.message ?? "")) {
        return c.json({ error: "Channel already exists" }, 409);
      }
      throw err;
    }
  })
  .post("/:name/join", async (c) => {
    const name = c.req.param("name");
    const user = c.get("user");

    const ch = await getChannelByName(name);
    if (!ch) return c.json({ error: "Channel not found" }, 404);

    await joinChannel(ch.id, user.id);
    return c.json({ ok: true, conversationId: ch.id });
  })
  .post("/:name/leave", async (c) => {
    const name = c.req.param("name");
    const user = c.get("user");

    const ch = await getChannelByName(name);
    if (!ch) return c.json({ error: "Channel not found" }, 404);

    await leaveChannel(ch.id, user.id);
    return c.json({ ok: true });
  })
  .get("/:name/members", async (c) => {
    const name = c.req.param("name");

    const ch = await getChannelByName(name);
    if (!ch) return c.json({ error: "Channel not found" }, 404);

    const participants = await getParticipants(ch.id);
    return c.json(participants);
  })
  .post("/:name/invite", zValidator("json", inviteSchema), async (c) => {
    const name = c.req.param("name");
    const inviter = c.get("user");
    const { username } = c.req.valid("json");

    const ch = await getChannelByName(name);
    if (!ch) return c.json({ error: "Channel not found" }, 404);

    // Resolve the invitee: try as existing user first, then as a mind
    let user = await getUserByUsername(username);
    if (!user && findMind(username)) {
      user = await getOrCreateMindUser(username);
    }
    if (!user) return c.json({ error: "User not found" }, 404);

    if (await isParticipant(ch.id, user.id)) {
      return c.json({ error: "Already a member" }, 409);
    }

    await joinChannel(ch.id, user.id);

    // Post a system message
    await addMessage(ch.id, "system", "system", [
      { type: "text", text: `${inviter.username} invited ${username} to #${name}` },
    ]);

    return c.json({ ok: true });
  });

export default app;
