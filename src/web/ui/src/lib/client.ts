// Typed API client using plain fetch against /api/v1/ endpoints.
// No Hono RPC dependency — same interface works against daemon or Worker proxy.

import type {
  AvailableUser,
  ChannelInfo,
  Conversation,
  ConversationWithParticipants,
  FileContent,
  HistoryMessage,
  HistorySession,
  Message,
  Mind,
  MindConfig,
  MindEnv,
  MindSkillInfo,
  Participant,
  Prompt,
  RecentPage,
  SharedSkill,
  Site,
  UpdateResult,
  Variant,
} from "@volute/api";
import type { CursorResponse } from "@volute/api/pagination";

const V1 = "/api/v1";

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error || `Request failed: ${res.status}`);
  }
  return res.json();
}

async function post<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error || `Request failed: ${res.status}`);
  }
  return res.json();
}

async function put(path: string, body?: unknown): Promise<void> {
  const res = await fetch(path, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error || `Request failed: ${res.status}`);
  }
}

async function del(path: string): Promise<void> {
  const res = await fetch(path, { method: "DELETE" });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error || `Request failed: ${res.status}`);
  }
}

// --- Minds ---

export function fetchMinds(): Promise<Mind[]> {
  return get(`${V1}/minds`);
}

export function fetchMind(name: string): Promise<Mind> {
  return get(`${V1}/minds/${enc(name)}`);
}

export function startMind(name: string): Promise<void> {
  return post(`${V1}/minds/${enc(name)}/start`);
}

export function stopMind(name: string): Promise<void> {
  return post(`${V1}/minds/${enc(name)}/stop`);
}

export function createSeedMind(
  name: string,
  opts?: {
    description?: string;
    template?: string;
    model?: string;
    seedSoul?: string;
    skills?: string[];
  },
): Promise<{ name: string; port: number }> {
  return post(`${V1}/minds`, { name, stage: "seed", ...opts });
}

// --- Conversations ---

export function fetchConversations(): Promise<ConversationWithParticipants[]> {
  return get(`${V1}/conversations`);
}

export function fetchConversationMessages(
  conversationId: string,
  opts?: { before?: number; limit?: number },
): Promise<CursorResponse<Message>> {
  const params = new URLSearchParams();
  if (opts?.before != null) params.set("before", String(opts.before));
  if (opts?.limit != null) params.set("limit", String(opts.limit));
  const qs = params.toString();
  return get(`${V1}/conversations/${enc(conversationId)}/messages${qs ? `?${qs}` : ""}`);
}

export function fetchConversationParticipants(conversationId: string): Promise<Participant[]> {
  return get(`${V1}/conversations/${enc(conversationId)}/participants`);
}

export function createConversation(
  participantNames: string[],
  title?: string,
): Promise<Conversation> {
  return post(`${V1}/conversations`, { participantNames, title });
}

export function deleteConversation(conversationId: string): Promise<void> {
  return del(`${V1}/conversations/${enc(conversationId)}`);
}

// --- Chat ---

export function sendChat(
  name: string,
  message: string,
  conversationId?: string,
  images?: Array<{ media_type: string; data: string }>,
): Promise<{ ok: boolean; conversationId: string }> {
  return post(`${V1}/minds/${enc(name)}/chat`, {
    message: message || undefined,
    conversationId,
    images: images && images.length > 0 ? images : undefined,
  });
}

export function sendChatUnified(
  conversationId: string,
  message: string,
  images?: Array<{ media_type: string; data: string }>,
): Promise<{ ok: boolean; conversationId: string }> {
  return post(`${V1}/chat`, {
    message: message || undefined,
    conversationId,
    images: images && images.length > 0 ? images : undefined,
  });
}

// --- Typing ---

export function reportTyping(
  mindName: string,
  channel: string,
  sender: string,
  active: boolean,
): void {
  fetch(`${V1}/minds/${enc(mindName)}/typing`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ channel, sender, active }),
  }).catch(() => {});
}

// --- History ---

export function fetchHistory(
  name: string,
  opts?: { channel?: string; session?: string; full?: boolean; limit?: number; offset?: number },
): Promise<HistoryMessage[]> {
  const params = new URLSearchParams();
  if (opts?.channel) params.set("channel", opts.channel);
  if (opts?.session) params.set("session", opts.session);
  if (opts?.full) params.set("full", "true");
  if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
  if (opts?.offset !== undefined) params.set("offset", String(opts.offset));
  const qs = params.toString();
  return get(`${V1}/minds/${enc(name)}/history${qs ? `?${qs}` : ""}`);
}

export function fetchHistorySessions(name: string): Promise<HistorySession[]> {
  return get(`${V1}/minds/${enc(name)}/history/sessions`);
}

export function fetchHistoryChannels(name: string): Promise<string[]> {
  return get(`${V1}/minds/${enc(name)}/history/channels`);
}

// --- Variants ---

export function fetchVariants(name: string): Promise<Variant[]> {
  return get(`${V1}/minds/${enc(name)}/variants`);
}

// --- Files ---

export function fetchFiles(name: string): Promise<string[]> {
  return get(`${V1}/minds/${enc(name)}/files`);
}

export function fetchFile(name: string, filename: string): Promise<FileContent> {
  return get(`${V1}/minds/${enc(name)}/files/${enc(filename)}`);
}

// --- Config ---

export function fetchMindConfig(name: string): Promise<MindConfig> {
  return get(`${V1}/minds/${enc(name)}/config`);
}

export function updateMindConfig(
  name: string,
  updates: {
    model?: string;
    thinkingLevel?: string;
    tokenBudget?: number | null;
    tokenBudgetPeriodMinutes?: number | null;
  },
): Promise<void> {
  return put(`${V1}/minds/${enc(name)}/config`, updates);
}

// --- Env ---

export function fetchMindEnv(name: string): Promise<MindEnv> {
  return get(`${V1}/minds/${enc(name)}/env`);
}

export function setMindEnvVar(name: string, key: string, value: string): Promise<void> {
  return put(`${V1}/minds/${enc(name)}/env/${enc(key)}`, { value });
}

export function deleteMindEnvVar(name: string, key: string): Promise<void> {
  return del(`${V1}/minds/${enc(name)}/env/${enc(key)}`);
}

export function deleteSharedEnvVar(key: string): Promise<void> {
  return del(`${V1}/env/${enc(key)}`);
}

// --- Channels ---

export function fetchChannels(): Promise<ChannelInfo[]> {
  return get(`${V1}/channels`);
}

export function createVoluteChannel(name: string): Promise<Conversation> {
  return post(`${V1}/channels`, { name });
}

export function joinVoluteChannel(name: string): Promise<{ conversationId: string }> {
  return post(`${V1}/channels/${enc(name)}/join`);
}

export function leaveVoluteChannel(name: string): Promise<void> {
  return post(`${V1}/channels/${enc(name)}/leave`);
}

export function inviteToChannel(channelName: string, username: string): Promise<void> {
  return post(`${V1}/channels/${enc(channelName)}/invite`, { username });
}

export function fetchChannelMembers(channelName: string): Promise<Participant[]> {
  return get(`${V1}/channels/${enc(channelName)}/members`);
}

// --- Skills ---

export function fetchSharedSkills(): Promise<SharedSkill[]> {
  return get(`${V1}/skills`);
}

export function fetchMindSkills(mindName: string): Promise<MindSkillInfo[]> {
  return get(`${V1}/minds/${enc(mindName)}/skills`);
}

export function installMindSkill(mindName: string, skillId: string): Promise<void> {
  return post(`${V1}/minds/${enc(mindName)}/skills/install`, { skillId });
}

export function updateMindSkill(mindName: string, skillId: string): Promise<UpdateResult> {
  return post(`${V1}/minds/${enc(mindName)}/skills/update`, { skillId });
}

export function publishMindSkill(mindName: string, skillId: string): Promise<void> {
  return post(`${V1}/minds/${enc(mindName)}/skills/publish`, { skillId });
}

export function uninstallMindSkill(mindName: string, skillId: string): Promise<void> {
  return del(`${V1}/minds/${enc(mindName)}/skills/${enc(skillId)}`);
}

export function removeSharedSkill(id: string): Promise<void> {
  return del(`${V1}/skills/${enc(id)}`);
}

// --- Prompts ---

export function fetchPrompts(): Promise<Prompt[]> {
  return get(`${V1}/prompts`);
}

export function updatePrompt(key: string, content: string): Promise<void> {
  return put(`${V1}/prompts/${enc(key)}`, { content });
}

export function resetPrompt(key: string): Promise<void> {
  return del(`${V1}/prompts/${enc(key)}`);
}

// --- Pages ---

export function fetchRecentPages(): Promise<RecentPage[]> {
  return get(`${V1}/minds/pages/recent`);
}

export function fetchSites(): Promise<Site[]> {
  return get(`${V1}/minds/pages/sites`);
}

// --- System ---

export function restartDaemon(): Promise<void> {
  return post(`${V1}/system/restart`);
}

export async function fetchSystemInfo(): Promise<{ system: string | null }> {
  try {
    return await get<{ system: string | null }>(`${V1}/system/info`);
  } catch {
    return { system: null };
  }
}

// --- Auth (these stay on /api/ since they're not mind-scoped) ---

export function fetchAvailableUsers(type?: string): Promise<AvailableUser[]> {
  const qs = type ? `?type=${enc(type)}` : "";
  return get(`/api/auth/users${qs}`);
}

// --- Upload ---

export async function uploadSkillZip(file: File): Promise<SharedSkill> {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch(`${V1}/skills/upload`, { method: "POST", body: form });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error || "Failed to upload skill");
  }
  return res.json();
}

// --- Helpers ---

function enc(s: string): string {
  return encodeURIComponent(s);
}
