/**
 * Echo text — when enabled, streams a mind's text output back to the
 * triggering channel as outbound messages in real time.
 */
import type { ContentBlock } from "@volute/api";
import { getOrCreateMindUser, getUserByUsername } from "../auth.js";
import { routeOutboundBridge } from "../bridges/bridge-outbound.js";
import { checkChannelLimits } from "../chat/channel-limits.js";
import { addMessage, findDMConversation, getChannelByName } from "../events/conversations.js";
import { publish as publishMindEvent } from "../events/mind-events.js";
import { mindDir } from "../mind/registry.js";
import { readVoluteConfig } from "../mind/volute-config.js";
import { fixModelEscapes } from "../util/fix-model-escapes.js";
import log from "../util/logger.js";
import { recordOutbound } from "./message-delivery.js";

const dlog = log.child("echo-text");

type EchoConfig = { echoText: boolean; unescapeNewlines: boolean };
const echoConfigCache = new Map<string, EchoConfig>();
const channelConvCache = new Map<string, string | null>();

function getEchoConfig(mind: string): EchoConfig {
  const cached = echoConfigCache.get(mind);
  if (cached) return cached;
  const config = readVoluteConfig(mindDir(mind));
  const result: EchoConfig = {
    echoText: config?.echoText === true,
    unescapeNewlines: config?.unescapeNewlines === true,
  };
  echoConfigCache.set(mind, result);
  return result;
}

export function clearEchoTextCache(mind?: string): void {
  if (mind) {
    echoConfigCache.delete(mind);
    for (const key of channelConvCache.keys()) {
      if (key.startsWith(`${mind}:`)) channelConvCache.delete(key);
    }
  } else {
    echoConfigCache.clear();
    channelConvCache.clear();
  }
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
 *
 * Fan-out decision (echoText vs. chat-send asymmetry): echoText intentionally does
 * NOT fan out to peer mind participants. It fires on every raw `text` event a mind
 * streams, so it is a real-time mirror to the human-facing conversation and external
 * bridges (`routeOutboundBridge`) — display surfaces, not interactive principals.
 * The authoritative mind→mind delivery path is the explicit chat send
 * (`/chat` → `fanOutToMinds`), which owns fan-out. Echoing raw streamed text to peer
 * minds would double-deliver every deliberate send, so peer-mind fan-out stays
 * exclusively on the explicit send path.
 */
export async function echoTextToChannel(
  mind: string,
  channel: string,
  text: string,
  turnId: string | undefined,
  textEventId: number | undefined,
): Promise<number | undefined> {
  const cfg = getEchoConfig(mind);
  if (!cfg.echoText) return undefined;
  if (!text.trim()) return undefined;

  const conversationId = await resolveConversationId(mind, channel);
  if (!conversationId) {
    dlog.debug(`echo-text: could not resolve channel "${channel}" to conversation`);
    return undefined;
  }

  text = fixModelEscapes(text, cfg.unescapeNewlines);

  // A channel's character and rate limits bind this path too. Without the check a mind with
  // echoText on would never be held to them at all — its text reaches the channel here
  // rather than through the send API. There is no caller to hand a 4xx to, so an over-limit
  // echo is dropped and logged; the mind's own text is still in its turn history.
  const channelName = channel.startsWith("#") ? channel.slice(1) : channel;
  const rejection = await checkChannelLimits({
    conversationId,
    channelName,
    text,
  });
  if (rejection) {
    dlog.warn(`echo-text: not echoing ${mind} to ${channel} — ${rejection.error}`);
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
