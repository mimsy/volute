/**
 * Outbound bridge routing — when a mind adds a message to a bridged conversation,
 * send the message to the external platform via the channel driver.
 */
import type { ContentBlock } from "@volute/api";
import { findBridgeForChannel } from "./bridges.js";
import { getChannelDriver, type ImageAttachment } from "./channels.js";
import { readEnv, sharedEnvPath } from "./env.js";
import { getConversation } from "./events/conversations.js";
import log from "./logger.js";

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

    // Only bridge channel-type conversations by name
    // DMs are handled differently — the bridge inbound created them, and outbound
    // goes through the same channel mapping
    const channelName = conv.type === "channel" ? conv.name : null;
    if (!channelName) {
      // For DMs, check if this is a bridge-created DM by looking at the conversation
      // Bridge DMs are currently not routed outbound — the mind uses daemonSend()
      // which goes through the channel driver directly
      return;
    }

    const bridgeInfo = findBridgeForChannel(channelName);
    if (!bridgeInfo) return;

    const driver = getChannelDriver(bridgeInfo.platform);
    if (!driver) {
      log.warn(`no channel driver for bridge platform: ${bridgeInfo.platform}`);
      return;
    }

    // Extract text content
    const text = contentBlocks
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("\n");

    if (!text) return;

    // Extract images
    const images: ImageAttachment[] = contentBlocks
      .filter((b): b is { type: "image"; media_type: string; data: string } => b.type === "image")
      .map((b) => ({ media_type: b.media_type, data: b.data }));

    // Build env for the channel driver (uses shared env for credentials)
    const env = readEnv(sharedEnvPath());
    env.VOLUTE_SENDER = senderName;

    // Resolve the external channel ID via the channel driver
    await driver.send(
      env,
      bridgeInfo.externalChannel,
      text,
      images.length > 0 ? images : undefined,
    );

    log.debug(`bridge outbound: sent to ${bridgeInfo.platform}:${bridgeInfo.externalChannel}`);
  } catch (err) {
    log.error(`bridge outbound failed for conversation ${conversationId}`, log.errorData(err));
  }
}
