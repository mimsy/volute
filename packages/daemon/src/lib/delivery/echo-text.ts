/**
 * Echo text — when enabled, streams a mind's text output back to the
 * triggering channel as outbound messages in real time.
 */
import type { ContentBlock } from "@volute/api";
import { getOrCreateMindUser, getUserByUsername } from "../auth.js";
import { routeOutboundBridge } from "../bridges/bridge-outbound.js";
import { addMessage, findDMConversation, getChannelByName } from "../events/conversations.js";
import { publish as publishMindEvent } from "../events/mind-events.js";
import { mindDir } from "../mind/registry.js";
import { readVoluteConfig } from "../mind/volute-config.js";
import log from "../util/logger.js";
import { recordOutbound } from "./message-delivery.js";

const dlog = log.child("echo-text");

const echoTextCache = new Map<string, boolean>();
const channelConvCache = new Map<string, string | null>();

export function clearEchoTextCache(mind?: string): void {
  if (mind) {
    echoTextCache.delete(mind);
    for (const key of channelConvCache.keys()) {
      if (key.startsWith(`${mind}:`)) channelConvCache.delete(key);
    }
  } else {
    echoTextCache.clear();
    channelConvCache.clear();
  }
}

function isEchoEnabled(mind: string): boolean {
  const cached = echoTextCache.get(mind);
  if (cached !== undefined) return cached;
  const config = readVoluteConfig(mindDir(mind));
  const enabled = config?.echoText === true;
  echoTextCache.set(mind, enabled);
  return enabled;
}

async function resolveConversationId(mind: string, channel: string): Promise<string | null> {
  const cacheKey = `${mind}:${channel}`;
  const cached = channelConvCache.get(cacheKey);
  if (cached !== undefined) return cached;

  let conversationId: string | null = null;
  if (channel.startsWith("#")) {
    const conv = await getChannelByName(channel.slice(1));
    if (conv) conversationId = conv.id;
  } else if (channel.startsWith("@")) {
    const otherUsername = channel.slice(1);
    const [mindUser, otherUser] = await Promise.all([
      getOrCreateMindUser(mind),
      getUserByUsername(otherUsername),
    ]);
    if (otherUser) {
      conversationId = await findDMConversation([mindUser.id, otherUser.id]);
    }
  }

  if (conversationId) {
    channelConvCache.set(cacheKey, conversationId);
  }
  return conversationId;
}

/**
 * If echoText is enabled for this mind, send the text content as an outbound
 * message to the channel. Returns the outbound history ID if sent.
 */
export async function echoTextToChannel(
  mind: string,
  channel: string,
  text: string,
  turnId: string | undefined,
  textEventId: number | undefined,
): Promise<number | undefined> {
  if (!isEchoEnabled(mind)) return undefined;
  if (!text.trim()) return undefined;

  const conversationId = await resolveConversationId(mind, channel);
  if (!conversationId) {
    dlog.debug(`echo-text: could not resolve channel "${channel}" to conversation`);
    return undefined;
  }

  const contentBlocks: ContentBlock[] = [{ type: "text", text }];

  const message = await addMessage(conversationId, "user", mind, contentBlocks, {
    turnId,
    sourceEventId: textEventId,
  });

  routeOutboundBridge(conversationId, mind, contentBlocks).catch((err) => {
    dlog.warn(`echo-text: bridge routing failed for ${mind} on ${channel}`, log.errorData(err));
  });

  const outboundId = await recordOutbound(mind, channel, text, {
    messageId: message != null ? String(message.id) : undefined,
    turnId,
  });

  if (outboundId != null) {
    publishMindEvent(mind, {
      mind,
      type: "outbound",
      channel,
      content: text,
      turnId,
    });
  }

  return outboundId;
}
