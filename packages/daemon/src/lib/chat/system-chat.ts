import { getOrCreateMindUser, getOrCreateSystemUser } from "../auth.js";
import { createConversation, findDMConversation } from "../events/conversations.js";

const dmCache = new Map<string, string>();

/** Reset the DM cache (for testing). */
export function resetSystemDMCache(): void {
  dmCache.clear();
}

/**
 * Ensure a DM conversation exists between the system user (shared by the spirit) and a
 * mind, so the spirit can hand-write correspondence (e.g. nurture) later. Caches per-mind.
 *
 * Automated system traffic now goes through system events (`deliverEvent`), not this DM —
 * this only bootstraps the genuine spirit↔mind conversation.
 *
 * Returns null for the spirit itself: it shares the system user, so there's no one to DM.
 * `startMindFull` calls this for every mind including the spirit, so a no-op (not a throw)
 * keeps spirit starts out of the error log (#688).
 */
export async function ensureSystemDM(mindName: string): Promise<{ conversationId: string } | null> {
  const cached = dmCache.get(mindName);
  if (cached) return { conversationId: cached };

  const systemUser = await getOrCreateSystemUser();
  const mindUser = await getOrCreateMindUser(mindName);

  // The spirit shares the system user — can't DM yourself.
  if (systemUser.id === mindUser.id) {
    return null;
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
