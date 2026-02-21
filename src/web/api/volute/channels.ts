import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import {
  createChannel,
  getChannelByName,
  getParticipants,
  joinChannel,
  leaveChannel,
  listChannels,
} from "../../../lib/conversations.js";
import type { AuthEnv } from "../../middleware/auth.js";

const createSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(50)
    .regex(/^[a-z0-9][a-z0-9-]*$/, "Channel names must be lowercase alphanumeric with hyphens"),
});

const app = new Hono<AuthEnv>()
  .get("/", async (c) => {
    const channels = await listChannels();
    const results = await Promise.all(
      channels.map(async (ch) => {
        const participants = await getParticipants(ch.id);
        return { ...ch, participantCount: participants.length };
      }),
    );
    return c.json(results);
  })
  .post("/", zValidator("json", createSchema), async (c) => {
    const user = c.get("user");
    const body = c.req.valid("json");

    const existing = await getChannelByName(body.name);
    if (existing) return c.json({ error: "Channel already exists" }, 409);

    const ch = await createChannel(body.name, user.id);
    return c.json(ch, 201);
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
  });

export default app;
