import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { getOrCreateMindUser, getUserByUsername } from "../../../lib/auth.js";
import {
  addMessage,
  createChannel,
  deleteConversation,
  formatChannelSettings,
  getChannelByName,
  getChannelSettings,
  getParticipantRole,
  getParticipants,
  isParticipant,
  joinChannel,
  leaveChannel,
  listChannels,
  updateChannelSettings,
} from "../../../lib/events/conversations.js";
import { findMind } from "../../../lib/mind/registry.js";
import type { AuthEnv } from "../../middleware/auth.js";
import { hasSystemAuthority } from "../../middleware/effective-principal.js";

const channelSettingsFields = z.object({
  description: z.string().nullable().optional(),
  rules: z.string().nullable().optional(),
  charLimit: z.number().int().positive().nullable().optional(),
  rateLimit: z.number().int().positive().nullable().optional(),
  rateWindow: z.number().int().positive().nullable().optional(),
  private: z.boolean().optional(),
});

// A rate limit is meaningless without its window, so the pair moves together: a count and a
// window, or neither.
const RATE_PAIR_MESSAGE = "rateLimit and rateWindow must be set together, or both null";
const ratePairIsCoherent = (limit: number | null, window: number | null) =>
  (limit === null) === (window === null);

// A PATCH is a partial update, so coherence has to be judged against the row as it will end
// up — not against the request alone. Judging the request in isolation both accepts
// `{rateWindow: null}` (leaving a stored count with no window, which silently stops being
// enforced while the API still reports it) and then rejects the follow-up `{rateLimit: 5}`
// that would have repaired it.
const channelSettingsSchema = channelSettingsFields;

const createSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(50)
      .regex(/^[a-z0-9][a-z0-9-]*$/, "Channel names must be lowercase alphanumeric with hyphens"),
    participantNames: z.array(z.string().min(1)).optional(),
  })
  .merge(channelSettingsFields)
  // On create there is no prior state, so the request is the whole story.
  .refine((v) => ratePairIsCoherent(v.rateLimit ?? null, v.rateWindow ?? null), {
    message: RATE_PAIR_MESSAGE,
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

    const { name, participantNames, ...settings } = body;

    // Resolve every requested participant up front so an unknown name fails
    // cleanly instead of silently dropping members after the channel exists.
    const participantIds: number[] = [];
    for (const username of participantNames ?? []) {
      let member = await getUserByUsername(username);
      if (!member && (await findMind(username))) {
        member = await getOrCreateMindUser(username);
      }
      if (!member) {
        return c.json({ error: `User not found: ${username}` }, 404);
      }
      participantIds.push(member.id);
    }

    let ch: Awaited<ReturnType<typeof createChannel>>;
    try {
      ch = await createChannel(name, user.id, settings);
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

    try {
      for (const id of participantIds) {
        await joinChannel(ch.id, id);
      }
    } catch (err) {
      console.error("[channels] join failed during channel create:", err);
      // Don't leave a half-populated channel behind on a join failure.
      try {
        await deleteConversation(ch.id);
      } catch (cleanupErr) {
        console.error(
          `[channels] failed to roll back channel ${ch.id} after join failure:`,
          cleanupErr,
        );
      }
      throw err;
    }

    return c.json({ ...ch, channel_name: name }, 201);
  })
  .get("/:name", async (c) => {
    const name = c.req.param("name");

    const ch = await getChannelByName(name);
    if (!ch) return c.json({ error: "Channel not found" }, 404);

    const [participants, settings] = await Promise.all([
      getParticipants(ch.id),
      getChannelSettings(name),
    ]);
    return c.json({
      ...ch,
      channel_name: name,
      participants,
      settings: formatChannelSettings(settings),
    });
  })
  .patch("/:name", zValidator("json", channelSettingsSchema), async (c) => {
    const name = c.req.param("name");
    const user = c.get("user");
    const body = c.req.valid("json");

    const ch = await getChannelByName(name);
    if (!ch) return c.json({ error: "Channel not found" }, 404);

    // In-handler authz: only the channel's creator (stamped "owner" at creation) or an
    // admin/spirit may change settings. Plain members deliberately cannot — otherwise a mind
    // could lift a limit that was set to restrain it. Channels with no owner (the commons, or
    // one whose creator left) are admin-only.
    if (
      !hasSystemAuthority(c.get("effective")) &&
      (await getParticipantRole(ch.id, user.id)) !== "owner"
    ) {
      return c.json({ error: "Forbidden" }, 403);
    }

    // Judge the rate pair against the row as this patch will leave it, so a partial update
    // can neither create a half-set limit nor be blocked from repairing one.
    const current = await getChannelSettings(name);
    const nextRateLimit =
      body.rateLimit !== undefined ? body.rateLimit : (current?.rate_limit ?? null);
    const nextRateWindow =
      body.rateWindow !== undefined ? body.rateWindow : (current?.rate_window ?? null);
    if (!ratePairIsCoherent(nextRateLimit, nextRateWindow)) {
      return c.json({ error: RATE_PAIR_MESSAGE }, 400);
    }

    await updateChannelSettings(name, body);
    const settings = await getChannelSettings(name);
    return c.json({ ...ch, channel_name: name, settings: formatChannelSettings(settings) });
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

    // In-handler authz: only a channel member (or admin/spirit) may add members.
    if (!hasSystemAuthority(c.get("effective")) && !(await isParticipant(ch.id, inviter.id))) {
      return c.json({ error: "Forbidden" }, 403);
    }

    // Resolve the invitee: try as existing user first, then as a mind
    let user = await getUserByUsername(username);
    if (!user && (await findMind(username))) {
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
