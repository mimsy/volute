import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { getOrCreateMindUser } from "../../lib/auth.js";
import { getBridgeDef } from "../../lib/bridges/bridge-defs.js";
import {
  getBridgeConfig,
  readBridgesConfig,
  removeBridgeConfig,
  removeChannelMapping,
  resolveChannelMapping,
  setBridgeConfig,
  setChannelMapping,
} from "../../lib/bridges/bridges.js";
import { findOrCreatePuppet } from "../../lib/chat/puppets.js";
import { getBridgeManager } from "../../lib/daemon/bridge-manager.js";
import { fanOutToMinds } from "../../lib/delivery/fan-out.js";
import {
  addMessage,
  type ContentBlock,
  createConversation,
  findDMConversation,
  getChannelByName,
  getParticipants,
} from "../../lib/events/conversations.js";
import { findMind } from "../../lib/mind/registry.js";
import log from "../../lib/util/logger.js";
import type { AuthEnv } from "../middleware/auth.js";
import { requireAdmin } from "../middleware/auth.js";

const inboundSchema = z.object({
  content: z
    .array(
      z.union([
        z.object({ type: z.literal("text"), text: z.string() }),
        z.object({ type: z.literal("image"), media_type: z.string(), data: z.string() }),
      ]),
    )
    .min(1),
  platformUserId: z.string(),
  displayName: z.string(),
  externalChannel: z.string(),
  isDM: z.boolean(),
  targetMind: z.string().optional(),
});

const mappingSchema = z.object({
  externalChannel: z.string(),
  voluteChannel: z.string(),
});

const enableSchema = z.object({
  defaultMind: z.string(),
});

const app = new Hono<AuthEnv>()
  // Inbound message from bridge process (daemon token only)
  .post("/:platform/inbound", zValidator("json", inboundSchema), async (c) => {
    const user = c.get("user");
    if (user.id !== 0) return c.json({ error: "Bridge inbound requires daemon token" }, 403);

    const platform = c.req.param("platform");
    const body = c.req.valid("json");
    const bridgeConfig = getBridgeConfig(platform);
    if (!bridgeConfig?.enabled) {
      return c.json({ error: `Bridge not enabled for ${platform}` }, 400);
    }

    // Find or create puppet user for the external sender. `puppet.username` is the
    // namespaced `platform:id` handle, and it — not the caller-chosen `displayName` —
    // is what every sender slot below records: `mind_history.sender` and
    // `messages.sender_name` otherwise mix an authenticated Volute username with a
    // string a stranger on Discord picked for themselves, with nothing marking which
    // is which (#1016). Using the puppet's own username rather than re-deriving
    // `platform:id` here keeps the recorded sender byte-identical to the participant
    // row, so display-name lookups and the participant-profile block agree.
    const puppet = await findOrCreatePuppet(platform, body.platformUserId, body.displayName);

    if (body.isDM) {
      // DM routing: use targetMind or defaultMind
      const mindName = body.targetMind ?? bridgeConfig.defaultMind;
      if (!mindName) {
        return c.json({ error: "No default mind configured for DM routing" }, 400);
      }
      const mindEntry = await findMind(mindName);
      if (!mindEntry) {
        return c.json({ error: `Mind ${mindName} not found` }, 404);
      }

      const mindUser = await getOrCreateMindUser(mindName);

      // Find or create DM conversation between puppet and mind
      const participantIds: [number, number] = [puppet.id, mindUser.id];
      let conversationId = await findDMConversation(participantIds);

      if (!conversationId) {
        const conv = await createConversation({
          participantIds: [puppet.id, mindUser.id],
          type: "dm",
        });
        conversationId = conv.id;
      }

      // Add message to conversation (inbound — no turn_id yet, turn created per-session)
      const contentBlocks = body.content as ContentBlock[];
      await addMessage(conversationId, "user", puppet.username, contentBlocks);

      // Fan out to the mind via existing delivery pipeline
      await fanOutToBridgedMinds({
        conversationId,
        contentBlocks,
        senderName: puppet.username,
        platform,
        isDM: true,
      });

      return c.json({ ok: true, conversationId });
    }

    // Channel message: look up mapping
    const voluteChannelName = resolveChannelMapping(platform, body.externalChannel);
    if (!voluteChannelName) {
      log.debug(`no mapping for ${platform}:${body.externalChannel}`);
      return c.json({ ok: true, unmapped: true });
    }

    // Find the Volute channel
    const channel = await getChannelByName(voluteChannelName);
    if (!channel) {
      log.warn(`mapped channel "${voluteChannelName}" not found — skipping`);
      return c.json({ ok: true, unmapped: true });
    }

    // Ensure puppet is a participant
    const participants = await getParticipants(channel.id);
    if (!participants.some((p) => p.userId === puppet.id)) {
      const { addParticipant } = await import("../../lib/events/conversations.js");
      await addParticipant(channel.id, puppet.id);
    }

    // Add message (inbound — no turn_id yet, turn created per-session)
    const contentBlocks = body.content as ContentBlock[];
    await addMessage(channel.id, "user", puppet.username, contentBlocks);

    // Fan out to mind participants
    await fanOutToBridgedMinds({
      conversationId: channel.id,
      contentBlocks,
      senderName: puppet.username,
      platform,
      isDM: false,
    });

    return c.json({ ok: true, conversationId: channel.id });
  })

  // List bridges + status
  .get("/", (c) => {
    const config = readBridgesConfig();
    const manager = getBridgeManager();
    const statuses = manager.getBridgeStatus();

    const bridges = Object.entries(config).map(([platform, cfg]) => {
      const status = statuses.find((s) => s.platform === platform);
      const def = getBridgeDef(platform);
      return {
        platform,
        displayName: def?.displayName ?? platform,
        enabled: cfg.enabled,
        running: status?.running ?? false,
        defaultMind: cfg.defaultMind,
        channelMappings: cfg.channelMappings,
      };
    });

    return c.json(bridges);
  })

  // Enable bridge — admin only
  .post("/:platform", requireAdmin, zValidator("json", enableSchema), async (c) => {
    const platform = c.req.param("platform");
    const body = c.req.valid("json");
    const def = getBridgeDef(platform);
    if (!def) return c.json({ error: `Unknown bridge platform: ${platform}` }, 400);

    // Check env vars
    const manager = getBridgeManager();
    const envCheck = manager.checkBridgeEnv(platform);
    if (envCheck) {
      return c.json(
        {
          error: "missing_env",
          missing: envCheck.missing,
          bridgeName: envCheck.bridgeName,
        },
        400,
      );
    }

    const existing = getBridgeConfig(platform);
    setBridgeConfig(platform, {
      enabled: true,
      defaultMind: body.defaultMind,
      channelMappings: existing?.channelMappings ?? {},
    });

    try {
      const daemonPort = parseInt(process.env.VOLUTE_DAEMON_PORT ?? "", 10);
      if (Number.isNaN(daemonPort)) {
        return c.json({ error: "VOLUTE_DAEMON_PORT not available" }, 500);
      }
      await manager.startBridge(platform, daemonPort);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "Failed to start bridge" }, 500);
    }
  })

  // Disable bridge — admin only
  .delete("/:platform", requireAdmin, async (c) => {
    const platform = c.req.param("platform");
    const manager = getBridgeManager();
    await manager.stopBridge(platform);
    removeBridgeConfig(platform);
    return c.json({ ok: true });
  })

  // Set channel mapping — admin only
  .put("/:platform/mappings", requireAdmin, zValidator("json", mappingSchema), (c) => {
    const platform = c.req.param("platform");
    const body = c.req.valid("json");
    try {
      setChannelMapping(platform, body.externalChannel, body.voluteChannel);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "Failed to set mapping" }, 400);
    }
  })

  // Remove channel mapping — admin only
  .delete("/:platform/mappings/:channel", requireAdmin, (c) => {
    const platform = c.req.param("platform");
    const channel = decodeURIComponent(c.req.param("channel"));
    removeChannelMapping(platform, channel);
    return c.json({ ok: true });
  })

  // List mappings
  .get("/:platform/mappings", (c) => {
    const platform = c.req.param("platform");
    const config = getBridgeConfig(platform);
    if (!config) return c.json({ error: "Bridge not configured" }, 404);
    return c.json(config.channelMappings);
  });

/**
 * Fan out a message from a bridged conversation to all mind participants.
 * Bridge senders are external humans, so this is not a mind→mind turn (loop
 * protection counter resets). Delegates to the shared fan-out path.
 */
async function fanOutToBridgedMinds(opts: {
  conversationId: string;
  contentBlocks: ContentBlock[];
  senderName: string;
  platform: string;
  isDM: boolean;
}): Promise<void> {
  await fanOutToMinds({
    conversationId: opts.conversationId,
    contentBlocks: opts.contentBlocks,
    senderName: opts.senderName,
    // Null: a bridge sender is an external platform identity Volute never
    // authenticated (#1017).
    senderId: null,
    isDM: opts.isDM,
  });
}

export default app;
