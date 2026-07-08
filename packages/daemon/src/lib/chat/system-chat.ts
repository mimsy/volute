import { aiCompleteUtility } from "../ai-service.js";
import { getOrCreateMindUser, getOrCreateSystemUser } from "../auth.js";
import { deliverMessage, recordInbound } from "../delivery/message-delivery.js";
import { addMessage, createConversation, findDMConversation } from "../events/conversations.js";
import { findMind, isSpiritName, mindDir, SPIRIT_NAME } from "../mind/registry.js";
import { readVoluteConfig } from "../mind/volute-config.js";
import log from "../util/logger.js";

const slog = log.child("system-chat");

const dmCache = new Map<string, string>();

/** Reset the DM cache (for testing). */
export function resetSystemDMCache(): void {
  dmCache.clear();
}

/**
 * Decide whether a mind's message should trigger the system fallback reply.
 *
 * Only genuine two-party system DMs qualify. Channels and group DMs that include
 * the system user are covered by fan-out to the running spirit (correctly
 * labeled), so the utility fallback stays DM-only — this stops #system posts and
 * group DMs from being treated as private DMs. The spirit shares the system user,
 * so it must never be triggered to reply to its own message, which would loop.
 */
export function shouldGenerateSystemFallback(opts: {
  senderIsMind: boolean;
  hasMessage: boolean;
  convType: string;
  participants: { userType: string }[];
  replyTarget: string;
}): boolean {
  const { senderIsMind, hasMessage, convType, participants, replyTarget } = opts;
  if (!senderIsMind || !hasMessage) return false;
  if (isSpiritName(replyTarget)) return false;
  return (
    convType === "dm" &&
    participants.length === 2 &&
    participants.some((p) => p.userType === "system")
  );
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
  const isSpirit = isSpiritName(mindName);
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
 *
 * When the target is the spirit ("volute"), skips conversation persistence
 * since the spirit cannot DM itself, but still records the inbound to
 * mind_history and returns no conversationId.
 */
export async function sendSystemMessageDirect(
  mindName: string,
  text: string,
): Promise<{ conversationId?: string }> {
  // Spirit can't DM itself — record inbound only, no conversation persistence
  if (isSpiritName(mindName)) {
    await recordInbound(mindName, "@volute", "volute", text);
    return {};
  }

  const { conversationId } = await ensureSystemDM(mindName);

  await addMessage(conversationId, "user", "volute", [{ type: "text", text }]);
  await recordInbound(mindName, "@volute", "volute", text);

  return { conversationId };
}

/**
 * Check whether the system spirit will handle the mind's DM on its own, so the
 * AI fallback reply should be skipped. This is true when the spirit is running
 * (fan-out has already delivered the message) or sleeping (fan-out queued it via
 * the sleep queue, and it will reach the spirit on wake).
 */
async function spiritWillHandle(): Promise<boolean> {
  const spiritEntry = await findMind(SPIRIT_NAME);
  if (spiritEntry?.running && spiritEntry.mindType === "spirit") return true;

  try {
    const { getSleepManagerIfReady } = await import("../daemon/sleep-manager.js");
    const sm = getSleepManagerIfReady();
    if (sm?.isSleeping(SPIRIT_NAME)) return true;
  } catch (err) {
    slog.debug("could not check spirit sleep state", log.errorData(err));
  }

  return false;
}

/**
 * Generate an AI-powered fallback reply from the system user to a mind's message.
 *
 * When the spirit is running or sleeping it owns the reply — fan-out already
 * delivered (or queued) the message to it, so this returns without delivering to
 * avoid a duplicate. Only when the spirit is stopped (and fan-out therefore
 * skipped it) does this generate a reply via the utility model.
 */
export async function generateSystemFallbackReply(
  conversationId: string,
  mindName: string,
  message: string,
): Promise<void> {
  // The running/sleeping spirit already received the message via fan-out; don't
  // double-deliver or double-reply.
  if (await spiritWillHandle()) return;

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
