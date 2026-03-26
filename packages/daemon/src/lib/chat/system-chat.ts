import { aiCompleteUtility } from "../ai-service.js";
import { getOrCreateMindUser, getOrCreateSystemUser } from "../auth.js";
import { deliverMessage, recordInbound } from "../delivery/message-delivery.js";
import { addMessage, createConversation, findDMConversation } from "../events/conversations.js";
import { findMind, mindDir } from "../mind/registry.js";
import { readVoluteConfig } from "../mind/volute-config.js";
import log from "../util/logger.js";

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

  // Spirit "volute" shares the system user — can't DM yourself
  if (systemUser.id === mindUser.id) {
    throw new Error(`Cannot create system DM: mind "${mindName}" is the system user`);
  }

  const existing = await findDMConversation([systemUser.id, mindUser.id]);
  if (existing) {
    dmCache.set(mindName, existing);
    return { conversationId: existing };
  }

  const conv = await createConversation({
    participantIds: [systemUser.id, mindUser.id],
  });

  dmCache.set(mindName, conv.id);
  return { conversationId: conv.id };
}

/**
 * Send a system message to a mind through the normal delivery pipeline.
 * Persists to the conversation and routes through deliverMessage (which handles
 * sleep queueing, routing, mind_history recording, etc.).
 *
 * When the target is the spirit ("volute"), skips conversation persistence
 * since the spirit cannot DM itself, and delivers directly.
 */
export async function sendSystemMessage(
  mindName: string,
  text: string,
  opts?: { whileSleeping?: "skip" | "queue" | "trigger-wake"; session?: string },
): Promise<void> {
  // Spirit can't DM itself — deliver directly without conversation persistence
  const isSpirit = mindName === "volute";
  let conversationId: string | undefined;

  if (!isSpirit) {
    const dm = await ensureSystemDM(mindName);
    conversationId = dm.conversationId;
    await addMessage(conversationId, "user", "volute", [{ type: "text", text }]);
  }

  await deliverMessage(mindName, {
    content: [{ type: "text", text }],
    channel: "@volute",
    ...(conversationId ? { conversationId } : {}),
    sender: "volute",
    isDM: true,
    participants: ["volute", mindName],
    participantCount: 2,
    ...(opts?.whileSleeping ? { whileSleeping: opts.whileSleeping } : {}),
    ...(opts?.session ? { session: opts.session } : {}),
  });
}

/**
 * Persist a system message to the conversation and mind_history, but do NOT
 * call deliverMessage. For cases where the caller POSTs directly to the mind's
 * /message endpoint (sleep manager, mind manager).
 */
export async function sendSystemMessageDirect(
  mindName: string,
  text: string,
): Promise<{ conversationId: string }> {
  const { conversationId } = await ensureSystemDM(mindName);

  await addMessage(conversationId, "user", "volute", [{ type: "text", text }]);
  await recordInbound(mindName, "@volute", "volute", text);

  return { conversationId };
}

/**
 * Check if the system spirit is running and can handle replies.
 */
async function isSpiritAvailable(): Promise<boolean> {
  const spiritEntry = await findMind("volute");
  return !!(spiritEntry?.running && spiritEntry.mindType === "spirit");
}

/**
 * Generate an AI-powered reply from the system user to a mind's message.
 * Routes through the system spirit when available, falls back to aiCompleteUtility.
 */
export async function generateSystemReply(
  conversationId: string,
  mindName: string,
  message: string,
): Promise<void> {
  // If the system spirit is running, deliver through it
  if (await isSpiritAvailable()) {
    try {
      await deliverMessage("volute", {
        content: [{ type: "text", text: message }],
        channel: `@${mindName}`,
        conversationId,
        sender: mindName,
        isDM: true,
        participants: ["volute", mindName],
        participantCount: 2,
      });
      return;
    } catch (err) {
      slog.warn(`failed to route to spirit, falling back to aiCompleteUtility`, log.errorData(err));
    }
  }

  // Fallback: generate reply via utility model
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

  try {
    const { getSleepManagerIfReady } = await import("../daemon/sleep-manager.js");
    const sm = getSleepManagerIfReady();
    if (sm) {
      const state = sm.getState(mindName);
      if (state.sleeping) {
        contextParts.push(`Sleep state: sleeping since ${state.sleepingSince}`);
      }
    }
  } catch (err) {
    slog.debug("could not retrieve sleep state for system reply", log.errorData(err));
  }

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
  } catch (err) {
    slog.debug("could not retrieve schedules for system reply", log.errorData(err));
  }

  const systemPrompt = contextParts.join("\n");

  const response = await aiCompleteUtility(systemPrompt, message);
  if (!response) {
    slog.warn(`no AI model available for system reply to ${mindName}`);
    const fallback =
      "I can't reply right now — no AI model is configured for system responses. An admin can set one up in Settings.";
    await addMessage(conversationId, "assistant", "volute", [{ type: "text", text: fallback }]);
    return;
  }

  await addMessage(conversationId, "assistant", "volute", [{ type: "text", text: response }]);

  await deliverMessage(mindName, {
    content: [{ type: "text", text: response }],
    channel: "@volute",
    conversationId,
    sender: "volute",
    isDM: true,
    participants: ["volute", mindName],
    participantCount: 2,
  });
}
