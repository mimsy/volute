/**
 * Outbound bridge routing — when a mind adds a message to a bridged conversation,
 * send the message to the external platform via the channel driver.
 */
import type { ContentBlock } from "@volute/api";
import { findBridgeForChannel, getBridgeConfig } from "./bridges.js";
import { getChannelDriver, type ImageAttachment } from "./channels.js";
import { readEnv, sharedEnvPath } from "./env.js";
import { getConversation, getParticipants } from "./events/conversations.js";
import log from "./logger.js";
import { mindDir } from "./registry.js";

function extractContent(contentBlocks: ContentBlock[]): {
  text: string;
  images: ImageAttachment[];
} {
  const text = contentBlocks
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  const images: ImageAttachment[] = contentBlocks
    .filter((b): b is { type: "image"; media_type: string; data: string } => b.type === "image")
    .map((b) => ({ media_type: b.media_type, data: b.data }));

  return { text, images };
}

/**
 * Check if a conversation is bridged and send the message to the external platform.
 * Call this after addMessage() for messages from minds (role: "user" when sender is a mind,
 * or role: "assistant").
 *
 * @param conversationId - The Volute conversation ID
 * @param senderName - The name of the sender (mind name)
 * @param contentBlocks - The message content
 */
export async function routeOutboundBridge(
  conversationId: string,
  senderName: string,
  contentBlocks: ContentBlock[],
): Promise<void> {
  try {
    const conv = await getConversation(conversationId);
    if (!conv) return;

    if (conv.type === "channel" && conv.name) {
      await routeChannelOutbound(conv.name, senderName, contentBlocks);
    } else if (conv.type === "dm") {
      await routeDMOutbound(conversationId, senderName, contentBlocks);
    }
  } catch (err) {
    log.error(`bridge outbound failed for conversation ${conversationId}`, log.errorData(err));
  }
}

/** Route outbound for channel-type conversations via channel mappings. */
async function routeChannelOutbound(
  channelName: string,
  senderName: string,
  contentBlocks: ContentBlock[],
): Promise<void> {
  const bridgeInfo = findBridgeForChannel(channelName);
  if (!bridgeInfo) return;

  const driver = getChannelDriver(bridgeInfo.platform);
  if (!driver) {
    log.warn(`no channel driver for bridge platform: ${bridgeInfo.platform}`);
    return;
  }

  const { text, images } = extractContent(contentBlocks);
  if (!text) return;

  const env = readEnv(sharedEnvPath());
  env.VOLUTE_SENDER = senderName;

  await driver.send(env, bridgeInfo.externalChannel, text, images.length > 0 ? images : undefined);
  log.debug(`bridge outbound: sent to ${bridgeInfo.platform}:${bridgeInfo.externalChannel}`);
}

/** Route outbound for DM conversations by finding puppet participants. */
async function routeDMOutbound(
  conversationId: string,
  senderName: string,
  contentBlocks: ContentBlock[],
): Promise<void> {
  const participants = await getParticipants(conversationId);

  // Find puppet participants (username format: "platform:userId")
  const puppets = participants.filter((p) => p.userType === "puppet");
  if (puppets.length === 0) return;

  const { text, images } = extractContent(contentBlocks);
  if (!text) return;

  for (const puppet of puppets) {
    const colonIdx = puppet.username.indexOf(":");
    if (colonIdx === -1) continue;

    const platform = puppet.username.slice(0, colonIdx);
    const externalUserId = puppet.username.slice(colonIdx + 1);

    // Only route if this platform has an enabled bridge
    const bridgeConfig = getBridgeConfig(platform);
    if (!bridgeConfig?.enabled) continue;

    const driver = getChannelDriver(platform);
    if (!driver?.createConversation) {
      log.warn(`no channel driver with DM support for bridge platform: ${platform}`);
      continue;
    }

    const env = readEnv(sharedEnvPath());
    env.VOLUTE_SENDER = senderName;
    env.VOLUTE_MIND = senderName;
    env.VOLUTE_MIND_DIR = mindDir(senderName);

    // Create/find the DM channel on the external platform, then send
    const slug = await driver.createConversation(env, [externalUserId]);
    await driver.send(env, slug, text, images.length > 0 ? images : undefined);
    log.debug(`bridge outbound DM: sent to ${platform}:${externalUserId}`);
  }
}
