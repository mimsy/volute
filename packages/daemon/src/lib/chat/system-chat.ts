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
 */
export async function ensureSystemDM(mindName: string): Promise<{ conversationId: string }> {
  const cached = dmCache.get(mindName);
  if (cached) return { conversationId: cached };

  const systemUser = await getOrCreateSystemUser();
  const mindUser = await getOrCreateMindUser(mindName);

  // The spirit shares the system user — can't DM yourself
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
