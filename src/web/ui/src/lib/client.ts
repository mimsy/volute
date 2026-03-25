// Typed API client using plain fetch against /api/v1/ endpoints.
// No Hono RPC dependency — same interface works against daemon or Worker proxy.

import type {
  AvailableUser,
  ChannelInfo,
  Conversation,
  ConversationWithParticipants,
  HistoryMessage,
  HistorySession,
  Message,
  Mind,
  MindConfig,
  MindEnv,
  MindSkillInfo,
  Participant,
  Prompt,
  SharedSkill,
  TurnRow,
  UpdateResult,
  Variant,
} from "@volute/api";
import type { CursorResponse } from "@volute/api/pagination";
import type { ExtensionManagementInfo } from "./extensions";

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

export type ContextBreakdown = {
  systemPrompt: number;
  conversation: {
    userText: number;
    assistantText: number;
    thinking: number;
    toolUse: number;
    toolResult: number;
  };
};

export type ContextInfo = {
  sessions: Array<{
    name: string;
    contextTokens: number;
    contextWindow?: number;
    breakdown?: ContextBreakdown;
  }>;
  systemPrompt: number;
};

export function fetchMindContext(name: string): Promise<ContextInfo> {
  return get(`${V1}/minds/${enc(name)}/context`);
}

export function startMind(name: string): Promise<void> {
  return post(`${V1}/minds/${enc(name)}/start`);
}

export function stopMind(name: string): Promise<void> {
  return post(`${V1}/minds/${enc(name)}/stop`);
}

export function deleteMind(name: string, force = false): Promise<void> {
  return del(`${V1}/minds/${enc(name)}${force ? "?force=true" : ""}`);
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

// --- Mind conversations (all channels) ---

export function fetchMindConversations(name: string): Promise<ConversationWithParticipants[]> {
  return get(`${V1}/minds/${enc(name)}/conversations`);
}

export function fetchMindConversationMessages(
  mindName: string,
  conversationId: string,
  opts?: { before?: number; limit?: number },
): Promise<CursorResponse<Message>> {
  const params = new URLSearchParams();
  if (opts?.before != null) params.set("before", String(opts.before));
  if (opts?.limit != null) params.set("limit", String(opts.limit));
  const qs = params.toString();
  return get(
    `${V1}/minds/${enc(mindName)}/conversations/${enc(conversationId)}/messages${qs ? `?${qs}` : ""}`,
  );
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

export function deleteConversation(conversationId: string): Promise<void> {
  return del(`${V1}/conversations/${enc(conversationId)}`);
}

export function markAsRead(conversationId: string): Promise<void> {
  return post(`${V1}/conversations/${enc(conversationId)}/read`);
}

export function setConversationPrivate(id: string, isPrivate: boolean): Promise<void> {
  return put(`${V1}/conversations/${enc(id)}/private`, { private: isPrivate });
}

// --- Chat ---

export function sendChat(opts: {
  message: string;
  conversationId?: string;
  targetMind?: string;
  images?: Array<{ media_type: string; data: string }>;
  files?: Array<{ filename: string; data: string }>;
}): Promise<{ ok: boolean; conversationId: string }> {
  return post(`${V1}/chat`, {
    message: opts.message || undefined,
    conversationId: opts.conversationId,
    targetMind: opts.targetMind,
    images: opts.images && opts.images.length > 0 ? opts.images : undefined,
    files: opts.files && opts.files.length > 0 ? opts.files : undefined,
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
  opts?: {
    channel?: string;
    session?: string;
    preset?: "summary" | "conversation" | "detailed" | "all";
    limit?: number;
    offset?: number;
  },
): Promise<HistoryMessage[]> {
  const params = new URLSearchParams();
  if (opts?.channel) params.set("channel", opts.channel);
  if (opts?.session) params.set("session", opts.session);
  if (opts?.preset) params.set("preset", opts.preset);
  if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
  if (opts?.offset !== undefined) params.set("offset", String(opts.offset));
  const qs = params.toString();
  return get(`${V1}/minds/${enc(name)}/history${qs ? `?${qs}` : ""}`);
}

export function fetchTurnEvents(
  name: string,
  opts: ({ turnId: string } | { session: string; fromId: number; toId: number }) & {
    detail?: boolean;
  },
): Promise<HistoryMessage[]> {
  const params = new URLSearchParams();
  if ("turnId" in opts) {
    params.set("turn_id", opts.turnId);
  } else {
    params.set("session", opts.session);
    params.set("from_id", String(opts.fromId));
    params.set("to_id", String(opts.toId));
  }
  if (opts.detail) params.set("detail", "1");
  return get(`${V1}/minds/${enc(name)}/history/turn?${params}`);
}

export function fetchHistorySessions(name: string): Promise<HistorySession[]> {
  return get(`${V1}/minds/${enc(name)}/history/sessions`);
}

export function fetchHistoryChannels(name: string): Promise<string[]> {
  return get(`${V1}/minds/${enc(name)}/history/channels`);
}

export function fetchTurns(opts?: {
  mind?: string;
  limit?: number;
  offset?: number;
  turnId?: string;
}): Promise<TurnRow[]> {
  const params = new URLSearchParams();
  if (opts?.mind) params.set("mind", opts.mind);
  if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
  if (opts?.offset !== undefined) params.set("offset", String(opts.offset));
  if (opts?.turnId) params.set("turnId", opts.turnId);
  const qs = params.toString();
  return get(`${V1}/history/turns${qs ? `?${qs}` : ""}`);
}

// --- Variants ---

export function fetchVariants(name: string): Promise<Variant[]> {
  return get(`${V1}/minds/${enc(name)}/variants`);
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
    maxThinkingTokens?: number | null;
    tokenBudget?: number | null;
    tokenBudgetPeriodMinutes?: number | null;
    compaction?: { maxContextTokens?: number | null } | null;
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

export function fetchDefaultSkills(): Promise<string[]> {
  return get<{ skills: string[] }>(`${V1}/skills/defaults/list`).then((r) => r.skills);
}

export function addDefaultSkill(skill: string): Promise<string[]> {
  return post<{ skills: string[] }>(`${V1}/skills/defaults/list`, { skill }).then((r) => r.skills);
}

export async function removeDefaultSkill(skill: string): Promise<string[]> {
  const res = await fetch(`${V1}/skills/defaults/list/${enc(skill)}`, { method: "DELETE" });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error || `Request failed: ${res.status}`);
  }
  const body = (await res.json()) as { skills: string[] };
  return body.skills;
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

// --- System ---

export function restartDaemon(): Promise<void> {
  return post(`${V1}/system/restart`);
}

export async function fetchSystemInfo(): Promise<{ system: string | null; name: string | null }> {
  try {
    return await get<{ system: string | null; name: string | null }>(`${V1}/system/info`);
  } catch {
    return { system: null, name: null };
  }
}

export async function updateSystemName(name: string): Promise<void> {
  await put(`${V1}/system/info`, { name });
}

export function systemRegister(name: string): Promise<{ system: string }> {
  return post(`${V1}/system/register`, { name });
}

export function systemLogin(key: string): Promise<{ system: string }> {
  return post(`${V1}/system/login`, { key });
}

export function systemLogout(): Promise<void> {
  return post(`${V1}/system/logout`);
}

// --- AI Service ---

export type AiProvider = {
  id: string;
  oauth: boolean;
  oauthName?: string;
  usesCallbackServer: boolean;
  configured: boolean;
  authMethod: "api_key" | "oauth" | "env_var" | null;
};

export type AiModel = {
  id: string;
  name: string;
  provider: string;
  contextWindow: number;
  maxTokens: number;
  enabled: boolean;
};

export function fetchAiProviders(): Promise<AiProvider[]> {
  return get(`${V1}/system/ai/providers`);
}

export function fetchAiModels(): Promise<AiModel[]> {
  return get(`${V1}/system/ai/models`);
}

export function saveProviderConfig(providerId: string, apiKey: string): Promise<void> {
  return put(`${V1}/system/ai/providers/${enc(providerId)}`, { apiKey });
}

export function removeProviderConfig(providerId: string): Promise<void> {
  return del(`${V1}/system/ai/providers/${enc(providerId)}`);
}

export function startAiOAuth(
  provider: string,
): Promise<{ flowId: string; url?: string; instructions?: string; needsManualCode?: boolean }> {
  return post(`${V1}/system/ai/oauth/start`, { provider });
}

export function pollAiOAuthStatus(
  flowId: string,
): Promise<{ status: "pending" | "complete" | "error"; error?: string; waitingForCode?: boolean }> {
  return get(`${V1}/system/ai/oauth/status/${enc(flowId)}`);
}

export function submitAiOAuthCode(flowId: string, code: string): Promise<void> {
  return post(`${V1}/system/ai/oauth/code/${enc(flowId)}`, { code });
}

export function saveEnabledModels(models: string[]): Promise<void> {
  return put(`${V1}/system/ai/models`, { models });
}

export type AiDefaults = { spiritModel?: string | null; utilityModel: string | null };

export function fetchAiDefaults(): Promise<AiDefaults> {
  return get(`${V1}/system/ai/defaults`);
}

export function saveAiDefaults(defaults: AiDefaults): Promise<void> {
  return put(`${V1}/system/ai/defaults`, defaults);
}

// --- Imagegen ---

export type ImagegenProvider = {
  id: string;
  configured: boolean;
  authMethod: "api_key" | "env_var" | null;
};

export type ImagegenModelSearchResult = {
  id: string;
  name: string;
  description?: string;
  owner: string;
};

export function fetchImagegenProviders(): Promise<ImagegenProvider[]> {
  return get(`${V1}/system/imagegen/providers`);
}

export function saveImagegenProviderConfig(id: string, apiKey: string): Promise<void> {
  return put(`${V1}/system/imagegen/providers/${enc(id)}`, { apiKey });
}

export function removeImagegenProviderConfig(id: string): Promise<void> {
  return del(`${V1}/system/imagegen/providers/${enc(id)}`);
}

export function fetchImagegenModels(): Promise<{ models: string[]; defaultModel: string | null }> {
  return get(`${V1}/system/imagegen/models`);
}

export function saveEnabledImagegenModels(
  models: string[],
  defaultModel?: string | null,
): Promise<void> {
  return put(`${V1}/system/imagegen/models`, { models, defaultModel });
}

export function searchImagegenModels(
  query: string,
  provider?: string,
): Promise<ImagegenModelSearchResult[]> {
  const params = new URLSearchParams({ q: query });
  if (provider) params.set("provider", provider);
  return get(`${V1}/system/imagegen/models/search?${params}`);
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

// --- Clock ---

export interface ClockStatus {
  sleep: {
    sleeping: boolean;
    sleepingSince: string | null;
    scheduledWakeAt: string | null;
    wokenByTrigger: boolean;
    voluntaryWakeAt: string | null;
    queuedMessageCount: number;
  } | null;
  sleepConfig: {
    enabled?: boolean;
    schedule?: { sleep: string; wake: string };
  } | null;
  schedules: {
    id: string;
    cron?: string;
    fireAt?: string;
    message?: string;
    script?: string;
    enabled: boolean;
    whileSleeping?: string;
    channel?: string;
  }[];
  upcoming: { id: string; at: string; type: "cron" | "timer" }[];
  previous: { id: string; at: string }[];
}

export function fetchClockStatus(name: string): Promise<ClockStatus> {
  return get(`${V1}/minds/${enc(name)}/clock/status`);
}

// --- Sleep & Schedules ---

export type SleepConfig = {
  enabled?: boolean;
  schedule?: { sleep: string; wake: string };
  wakeTriggers?: {
    mentions?: boolean;
    dms?: boolean;
    channels?: string[];
    senders?: string[];
  };
};

export type ScheduleEntry = {
  id: string;
  cron?: string;
  fireAt?: string;
  message?: string;
  script?: string;
  enabled: boolean;
  whileSleeping?: string;
  session?: string;
};

export function fetchSleepConfig(name: string): Promise<SleepConfig> {
  return get(`${V1}/minds/${enc(name)}/sleep/config`);
}

export function updateSleepConfig(name: string, config: Partial<SleepConfig>): Promise<void> {
  return put(`${V1}/minds/${enc(name)}/sleep/config`, config);
}

export function fetchSchedules(name: string): Promise<ScheduleEntry[]> {
  return get(`${V1}/minds/${enc(name)}/schedules`);
}

export function addSchedule(name: string, schedule: Partial<ScheduleEntry>): Promise<void> {
  return post(`${V1}/minds/${enc(name)}/schedules`, schedule);
}

export function updateSchedule(
  name: string,
  id: string,
  updates: Partial<ScheduleEntry>,
): Promise<void> {
  return put(`${V1}/minds/${enc(name)}/schedules/${enc(id)}`, updates);
}

export function deleteSchedule(name: string, id: string): Promise<void> {
  return del(`${V1}/minds/${enc(name)}/schedules/${enc(id)}`);
}

// --- Profile ---

export async function updateMindProfile(
  name: string,
  updates: { displayName?: string; description?: string },
): Promise<void> {
  const res = await fetch(`${V1}/minds/${enc(name)}/profile`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(updates),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error || "Failed to update profile");
  }
}

export async function uploadMindAvatar(name: string, file: File): Promise<void> {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch(`${V1}/minds/${enc(name)}/avatar`, { method: "POST", body: form });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error || "Failed to upload avatar");
  }
}

// --- Extensions management ---

export function fetchAllExtensions(): Promise<ExtensionManagementInfo[]> {
  return get("/api/extensions/all");
}

export async function setExtensionEnabled(id: string, enabled: boolean): Promise<void> {
  await put(`/api/extensions/${enc(id)}/enabled`, { enabled });
}

export async function installExtension(pkg: string): Promise<void> {
  await post("/api/extensions/install", { package: pkg });
}

export async function uninstallExtension(pkg: string): Promise<void> {
  await del(`/api/extensions/uninstall/${enc(pkg)}`);
}

// --- Helpers ---

function enc(s: string): string {
  return encodeURIComponent(s);
}
