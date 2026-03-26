import type { ActivityItem, ConversationWithParticipants, Mind } from "@volute/api";
import type { SSEEvent } from "@volute/api/events";
import { SvelteMap, SvelteSet } from "svelte/reactivity";
import { type AuthUser, fetchMe, logout } from "./auth";
import {
  type AiProvider,
  fetchAiProviders,
  fetchMinds,
  fetchSystemInfo,
  markAsRead,
} from "./client";
import { connect, connectionState, disconnect, subscribe } from "./connection.svelte";
import { type ExtensionInfo, fetchExtensions } from "./extensions";
import { showNotification } from "./notifications";
import { updateOauthErrors } from "./oauth-reauth.svelte";

// --- Auth ---

export const auth = $state({
  user: null as AuthUser | null,
  checked: false,
  systemName: null as string | null,
  localName: null as string | null,
  setupComplete: true,
  setupChecked: false,
  setupProgress: null as { hasSystem?: boolean; hasAccount?: boolean } | null,
});

export async function checkSetup() {
  try {
    const res = await fetch("/api/setup/status");
    if (res.ok) {
      const data = await res.json();
      auth.setupComplete = data.complete;
      if (!data.complete) {
        auth.setupProgress = { hasSystem: data.hasSystem, hasAccount: data.hasAccount };
      }
    }
  } catch {
    // If the endpoint doesn't exist, assume setup is complete (older daemon)
    auth.setupComplete = true;
  }
  auth.setupChecked = true;
}

export async function checkAuth() {
  await checkSetup();
  if (!auth.setupComplete && !auth.setupProgress?.hasAccount) {
    auth.checked = true;
    return;
  }
  try {
    const u = await fetchMe();
    auth.user = u;
    auth.checked = true;
    if (u) {
      const info = await fetchSystemInfo();
      auth.systemName = info.system;
      auth.localName = info.name;
    }
  } catch {
    auth.checked = true;
  }
}

export async function handleLogout() {
  try {
    await logout();
  } catch {
    // Best effort
  }
  auth.user = null;
}

export async function handleAuth(u: AuthUser) {
  auth.user = u;
  try {
    const info = await fetchSystemInfo();
    auth.systemName = info.system;
    auth.localName = info.name;
  } catch {
    // systemName remains null — non-critical
  }
}

// --- Data ---

export const data = $state({
  minds: [] as Mind[],
  conversations: [] as ConversationWithParticipants[],
  activity: [] as ActivityItem[],
  extensions: [] as ExtensionInfo[],
  oauthErrors: [] as AiProvider[],
  get connectionOk() {
    return connectionState.connected;
  },
});

// --- Real-time mind activity ---

/** Minds that are currently processing (between mind_active and mind_idle SSE events). */
export const activeMinds = new SvelteSet<string>();

/** Brains (human users) currently connected via SSE. */
export const onlineBrains = new SvelteSet<string>();

// --- Unread tracking ---

export const unreadCounts = new SvelteMap<string, number>();

const unreadState = $state({ activeConversationId: null as string | null });

let cachedMentionPattern: { username: string; displayName: string; regex: RegExp } | null = null;
function getMentionPattern(username: string, displayName: string): RegExp {
  if (
    cachedMentionPattern?.username === username &&
    cachedMentionPattern?.displayName === displayName
  ) {
    return cachedMentionPattern.regex;
  }
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`@(${esc(username)}${displayName ? `|${esc(displayName)}` : ""})`, "i");
  cachedMentionPattern = { username, displayName, regex };
  return regex;
}

export function setActiveConversation(id: string | null) {
  unreadState.activeConversationId = id;
  if (id) {
    unreadCounts.set(id, 0);
    markAsRead(id).catch((err) => console.warn("[stores] markAsRead failed:", err));
  }
}

// --- Unified SSE via connection.svelte.ts ---

function handleSSEEvent(event: SSEEvent) {
  if (event.event === "snapshot") {
    data.conversations = event.conversations ?? [];
    data.activity = event.activity ?? [];
    activeMinds.clear();
    if (Array.isArray(event.activeMinds)) {
      for (const name of event.activeMinds) activeMinds.add(name);
    }
    onlineBrains.clear();
    if (Array.isArray(event.onlineBrains)) {
      for (const name of event.onlineBrains) onlineBrains.add(name);
    }
    // Populate unread counts from snapshot
    unreadCounts.clear();
    for (const conv of data.conversations) {
      if (conv.unreadCount) unreadCounts.set(conv.id, conv.unreadCount);
    }
    // Minds not in snapshot — fetch separately since they need health checks
    fetchMinds()
      .then((m) => {
        data.minds = m;
      })
      .catch((err) => {
        console.warn("[stores] failed to refresh minds:", err);
      });
    // Extensions — fetch metadata
    fetchExtensions()
      .then((ext) => {
        data.extensions = ext;
      })
      .catch((err) => {
        console.warn("[stores] failed to refresh extensions:", err);
      });
    // AI provider health — check for OAuth failures
    fetchAiProviders()
      .then(updateOauthErrors)
      .catch(() => {});
  } else if (event.event === "activity") {
    const { event: _, ...item } = event;
    data.activity = [item as ActivityItem, ...data.activity].slice(0, 50);
    // Track real-time active/idle state
    if (item.type === "mind_active") activeMinds.add(item.mind);
    if (
      item.type === "mind_idle" ||
      item.type === "mind_stopped" ||
      item.type === "mind_done" ||
      item.type === "mind_sleeping"
    )
      activeMinds.delete(item.mind);

    // Track brain online/offline
    if (item.type === "brain_online") onlineBrains.add(item.mind);
    if (item.type === "brain_offline") onlineBrains.delete(item.mind);

    // Refresh minds on status changes (mind_active/mind_idle handled by activeMinds set above)
    if (
      item.type === "mind_started" ||
      item.type === "mind_stopped" ||
      item.type === "mind_sleeping" ||
      item.type === "mind_waking" ||
      item.type === "profile_updated"
    ) {
      fetchMinds()
        .then((m) => {
          data.minds = m;
        })
        .catch((err) => {
          console.warn("[stores] failed to refresh minds:", err);
        });
    }
  } else if (event.event === "conversation") {
    const conv = data.conversations.find((c) => c.id === event.conversationId);
    if (conv && event.type === "message") {
      // Extract text from content blocks
      let text = "";
      if (Array.isArray(event.content)) {
        for (const block of event.content) {
          if (block.type === "text") text += block.text;
        }
      }
      (conv as any).lastMessage = {
        role: event.role,
        senderName: event.senderName,
        text,
        createdAt: event.createdAt,
      };
      (conv as any).updated_at = event.createdAt;

      // Unread tracking + notifications
      const isFromSelf = event.senderName === auth.user?.username;
      const isActive = event.conversationId === unreadState.activeConversationId;
      if (!isFromSelf && !isActive) {
        const current = unreadCounts.get(event.conversationId) ?? 0;
        unreadCounts.set(event.conversationId, current + 1);

        // Browser notifications
        const senderLabel = event.senderName ?? "Someone";
        const isDm = conv.type === "dm";
        if (isDm) {
          showNotification(senderLabel, text.slice(0, 200));
        } else if (conv.type === "channel") {
          // Notify on @mention
          const me = auth.user?.username ?? "";
          const displayName = auth.user?.display_name ?? "";
          if (getMentionPattern(me, displayName).test(text)) {
            showNotification(
              `${senderLabel} in #${conv.channel_name ?? "channel"}`,
              text.slice(0, 200),
            );
          }
        }
      } else if (!isFromSelf && isActive) {
        // Keep read cursor current for active conversation
        markAsRead(event.conversationId).catch((err) =>
          console.warn("[stores] markAsRead failed:", err),
        );
      }

      // Re-sort by triggering reactivity
      data.conversations = [...data.conversations];
    }
  }
}

let unsubscribeSSE: (() => void) | null = null;
let oauthHealthTimer: ReturnType<typeof setInterval> | null = null;

export function connectActivity() {
  disconnectActivity();
  unsubscribeSSE = subscribe(handleSSEEvent);
  connect();
  // Poll OAuth health every 60s to pick up credential failures
  oauthHealthTimer = setInterval(() => {
    fetchAiProviders()
      .then(updateOauthErrors)
      .catch(() => {});
  }, 60_000);
}

export function disconnectActivity() {
  unsubscribeSSE?.();
  unsubscribeSSE = null;
  if (oauthHealthTimer) {
    clearInterval(oauthHealthTimer);
    oauthHealthTimer = null;
  }
  disconnect();
}

// --- Hidden chats (persisted to localStorage) ---

function loadHiddenChats(): SvelteSet<string> {
  try {
    const stored = localStorage.getItem("volute:hidden-chats");
    return stored ? new SvelteSet(JSON.parse(stored)) : new SvelteSet();
  } catch {
    return new SvelteSet();
  }
}

export const hiddenConversationIds = loadHiddenChats();

function persistHidden() {
  localStorage.setItem("volute:hidden-chats", JSON.stringify([...hiddenConversationIds]));
}

export function hideConversation(id: string) {
  hiddenConversationIds.add(id);
  persistHidden();
}

export function unhideConversation(id: string) {
  hiddenConversationIds.delete(id);
  persistHidden();
}

// --- Layout (mobile sidebar) ---

export const layout = $state({ sidebarOpen: false });

export function toggleSidebar() {
  layout.sidebarOpen = !layout.sidebarOpen;
}

export function closeSidebar() {
  layout.sidebarOpen = false;
}

// --- Sidebar width ---

function loadSidebarWidth(): number {
  try {
    const stored = localStorage.getItem("volute:sidebar-width");
    return stored ? Math.max(180, Math.min(400, Number(stored))) : 240;
  } catch {
    return 240;
  }
}

export const sidebar = $state({ width: loadSidebarWidth() });

export function saveSidebarWidth() {
  localStorage.setItem("volute:sidebar-width", String(sidebar.width));
}

function loadRightPanelWidth(): number {
  try {
    const stored = localStorage.getItem("volute:right-panel-width");
    return stored ? Math.max(240, Math.min(600, Number(stored))) : 360;
  } catch {
    return 360;
  }
}

export const rightPanel = $state({ width: loadRightPanelWidth() });

export function saveRightPanelWidth() {
  localStorage.setItem("volute:right-panel-width", String(rightPanel.width));
}
