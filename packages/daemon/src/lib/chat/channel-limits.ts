import { and, desc, eq, ne } from "drizzle-orm";
import { getDb } from "../db.js";
import { getChannelSettings } from "../events/conversations.js";
import { messages } from "../schema.js";
import log from "../util/logger.js";
import { parseDbTimestamp } from "../util/time.js";

const clog = log.child("channel-limits");

export type LimitRejection = {
  error: string;
  /** 400 for a too-long message, 429 for a rate-limited channel. */
  status: 400 | 429;
};

/**
 * Channel policy checks for an outbound message: the per-message character limit and the
 * channel-wide rate limit. Applies to every sender — minds and humans alike — so a channel's
 * limits mean the same thing whoever is writing.
 *
 * Returns a rejection to hand straight back to the caller, or null to allow the send.
 * Fails open: if the settings or the message history can't be read, the message goes through
 * rather than a transient DB error silencing a channel.
 */
export async function checkChannelLimits(opts: {
  conversationId: string;
  channelName: string;
  /** The sender's own message text — not system-generated blocks appended alongside it. */
  text: string;
}): Promise<LimitRejection | null> {
  const { conversationId, channelName, text } = opts;
  try {
    const settings = await getChannelSettings(channelName);
    if (!settings) return null;

    if (settings.char_limit && text.length > settings.char_limit) {
      return {
        error: `Message is ${text.length} characters; #${channelName} has a ${settings.char_limit} character limit. Shorten your message and try again.`,
        status: 400,
      };
    }

    return await checkRateLimit(conversationId, channelName, settings);
  } catch (err) {
    clog.warn(`failed to check limits for #${channelName}, allowing send`, log.errorData(err));
    return null;
  }
}

async function checkRateLimit(
  conversationId: string,
  channelName: string,
  settings: { rate_limit: number | null; rate_window: number | null },
): Promise<LimitRejection | null> {
  const limit = settings.rate_limit;
  const windowSeconds = settings.rate_window;
  if (!limit || !windowSeconds) return null;

  // The Nth-newest message decides it: if the limit'th most recent message is still inside
  // the window, the window is already full. One bounded read instead of counting every row
  // in the window, and the same row's timestamp gives the exact retry-after.
  const db = await getDb();
  const nth = await db
    .select({ created_at: messages.created_at })
    .from(messages)
    .where(and(eq(messages.conversation_id, conversationId), ne(messages.role, "system")))
    .orderBy(desc(messages.id))
    .limit(1)
    .offset(limit - 1)
    .get();
  if (!nth) return null;

  const windowMs = windowSeconds * 1000;
  const elapsedMs = Date.now() - parseDbTimestamp(nth.created_at).getTime();
  if (elapsedMs >= windowMs) return null;

  const retryAfter = Math.max(1, Math.ceil((windowMs - elapsedMs) / 1000));
  return {
    error: `#${channelName} is rate limited (${limit} messages per ${windowSeconds}s). Try again in ${retryAfter}s.`,
    status: 429,
  };
}
