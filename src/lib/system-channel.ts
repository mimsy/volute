import { writeChannelEntry } from "../connectors/sdk.js";
import { getOrCreateMindUser } from "./auth.js";
import { deliverMessage } from "./delivery/message-delivery.js";
import {
  addMessage,
  createChannel,
  getChannelByName,
  getParticipants,
  joinChannel,
} from "./events/conversations.js";
import log from "./logger.js";

const SYSTEM_CHANNEL_NAME = "system";

let cachedChannelId: string | null = null;

/** Reset the cached channel ID (for testing). */
export function resetSystemChannelCache(): void {
  cachedChannelId = null;
}

/** Ensure the #system channel exists (idempotent). Returns the conversation ID. */
export async function ensureSystemChannel(): Promise<string> {
  if (cachedChannelId) return cachedChannelId;

  const existing = await getChannelByName(SYSTEM_CHANNEL_NAME);
  if (existing) {
    cachedChannelId = existing.id;
    return existing.id;
  }

  const conv = await createChannel(SYSTEM_CHANNEL_NAME);
  cachedChannelId = conv.id;
  log.info("created #system channel");
  return conv.id;
}

/** Join a brain user to the #system channel. */
export async function joinSystemChannel(userId: number): Promise<void> {
  const channelId = await ensureSystemChannel();
  await joinChannel(channelId, userId);
}

/** Join a mind to the #system channel by mind name. */
export async function joinSystemChannelForMind(mindName: string): Promise<void> {
  const user = await getOrCreateMindUser(mindName);
  await joinSystemChannel(user.id);
}

/** Post a system announcement to the #system channel and deliver to mind participants. */
export async function announceToSystem(text: string): Promise<void> {
  const channelId = await ensureSystemChannel();
  await addMessage(channelId, "system", "system", [{ type: "text", text }]);

  // Deliver to all mind participants of #system
  const participants = await getParticipants(channelId);
  const mindParticipants = participants.filter((p) => p.userType === "mind");
  const channel = "volute:#system";
  for (const mind of mindParticipants) {
    try {
      writeChannelEntry(mind.username, channel, {
        platformId: channelId,
        platform: "volute",
        name: SYSTEM_CHANNEL_NAME,
        type: "group",
      });
    } catch {}
    deliverMessage(mind.username, {
      content: [{ type: "text", text }],
      channel,
      conversationId: channelId,
      sender: "system",
      participants: participants.map((p) => p.username),
      participantCount: participants.length,
      isDM: false,
    }).catch(() => {});
  }
}
