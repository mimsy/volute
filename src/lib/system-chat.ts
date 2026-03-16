import { writeChannelEntry } from "../connectors/sdk.js";
import { aiComplete } from "./ai-service.js";
import { getOrCreateMindUser, getOrCreateSystemUser } from "./auth.js";
import { deliverMessage } from "./delivery/message-delivery.js";
import { addMessage, createConversation, findDMConversation } from "./events/conversations.js";
import log from "./logger.js";
import { findMind, mindDir } from "./registry.js";
import { readVoluteConfig } from "./volute-config.js";

const slog = log.child("system-chat");

const dmCache = new Map<string, string>();

/** Reset the DM cache (for testing). */
export function resetSystemDMCache(): void {
  dmCache.clear();
}

/**
 * Ensure a DM conversation exists between the system user and a mind.
 * Caches per-mind to avoid repeated lookups.
 */
export async function ensureSystemDM(mindName: string): Promise<{ conversationId: string }> {
  const cached = dmCache.get(mindName);
  if (cached) return { conversationId: cached };

  const systemUser = await getOrCreateSystemUser();
  const mindUser = await getOrCreateMindUser(mindName);

  const existing = await findDMConversation(mindName, [systemUser.id, mindUser.id]);
  if (existing) {
    dmCache.set(mindName, existing);
    return { conversationId: existing };
  }

  const conv = await createConversation(mindName, "volute", {
    participantIds: [systemUser.id, mindUser.id],
    title: "Volute",
  });

  try {
    writeChannelEntry(mindName, "volute:@volute", {
      platformId: conv.id,
      platform: "volute",
      name: "Volute",
      type: "dm",
    });
  } catch (err) {
    slog.warn(`failed to write channel entry for ${mindName}`, log.errorData(err));
  }

  dmCache.set(mindName, conv.id);
  return { conversationId: conv.id };
}

/**
 * Send a system message to a mind through the normal delivery pipeline.
 * Persists to the conversation and routes through deliverMessage (which handles
 * sleep queueing, routing, mind_history recording, etc.).
 */
export async function sendSystemMessage(
  mindName: string,
  text: string,
  opts?: { whileSleeping?: "skip" | "queue" | "trigger-wake" },
): Promise<void> {
  const { conversationId } = await ensureSystemDM(mindName);

  await addMessage(conversationId, "user", "volute", [{ type: "text", text }]);

  await deliverMessage(mindName, {
    content: [{ type: "text", text }],
    channel: "volute:@volute",
    conversationId,
    sender: "volute",
    isDM: true,
    participants: ["volute", mindName],
    participantCount: 2,
    ...opts,
  });
}

/**
 * Persist a system message to the conversation but do NOT call deliverMessage.
 * For cases where the caller POSTs directly to the mind's /message endpoint
 * (sleep manager, mind manager) and wants the message in the conversation.
 * The mind's /message handler calls recordInbound for mind_history.
 */
export async function sendSystemMessageDirect(
  mindName: string,
  text: string,
): Promise<{ conversationId: string }> {
  const { conversationId } = await ensureSystemDM(mindName);

  await addMessage(conversationId, "user", "volute", [{ type: "text", text }]);

  return { conversationId };
}

/**
 * Generate an AI-powered reply from the system user to a mind's message.
 * Gathers mind context (config, state) and uses aiComplete for the response.
 */
export async function generateSystemReply(
  conversationId: string,
  mindName: string,
  message: string,
): Promise<void> {
  // Gather mind context
  const entry = await findMind(mindName);
  const dir = mindDir(mindName);
  const config = readVoluteConfig(dir);

  const contextParts: string[] = [
    "You are Volute, the system that manages this mind's infrastructure.",
    "You are having a direct conversation with a mind. Be helpful, concise, and informative.",
    `Mind name: ${mindName}`,
    `Status: ${entry?.running ? "running" : "stopped"}`,
  ];

  if (config?.model) contextParts.push(`Model: ${config.model}`);
  if (config?.tokenBudget) contextParts.push(`Token budget: ${config.tokenBudget}`);
  if (config?.sleep?.enabled) {
    contextParts.push(`Sleep schedule: enabled`);
    if (config.sleep.schedule?.sleep)
      contextParts.push(`Sleep cron: ${config.sleep.schedule.sleep}`);
    if (config.sleep.schedule?.wake) contextParts.push(`Wake cron: ${config.sleep.schedule.wake}`);
  }

  // Get sleep state if available
  try {
    const { getSleepManagerIfReady } = await import("./daemon/sleep-manager.js");
    const sm = getSleepManagerIfReady();
    if (sm) {
      const state = sm.getState(mindName);
      if (state.sleeping) {
        contextParts.push(`Sleep state: sleeping since ${state.sleepingSince}`);
      }
    }
  } catch {
    // Sleep manager may not be initialized
  }

  // Get active schedules from config
  try {
    const schedules = config?.schedules;
    if (schedules && schedules.length > 0) {
      const activeSchedules = schedules.filter((s) => s.enabled !== false);
      if (activeSchedules.length > 0) {
        contextParts.push(
          `Active schedules: ${activeSchedules.map((s) => `${s.id} (${s.cron ?? s.fireAt ?? "unknown"})`).join(", ")}`,
        );
      }
    }
  } catch {
    // Scheduler may not be initialized
  }

  const systemPrompt = contextParts.join("\n");

  const response = await aiComplete(systemPrompt, message);
  if (!response) {
    slog.debug(`no AI response for system reply to ${mindName}`);
    return;
  }

  await addMessage(conversationId, "assistant", "volute", [{ type: "text", text: response }]);

  // Deliver the reply to the mind
  await deliverMessage(mindName, {
    content: [{ type: "text", text: response }],
    channel: "volute:@volute",
    conversationId,
    sender: "volute",
    isDM: true,
    participants: ["volute", mindName],
    participantCount: 2,
  });
}
