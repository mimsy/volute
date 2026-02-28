import type {
  ActivityItem,
  ConversationWithParticipants,
  Mind,
  RecentPage,
  Site,
} from "@volute/api";
import type { SSEEvent } from "@volute/api/events";
import { SvelteSet } from "svelte/reactivity";
import { type AuthUser, fetchMe, logout } from "./auth";
import { fetchMinds, fetchSystemInfo } from "./client";
import { connect, connectionState, disconnect, subscribe } from "./connection.svelte";

// --- Auth ---

export const auth = $state({
  user: null as AuthUser | null,
  checked: false,
  systemName: null as string | null,
});

export async function checkAuth() {
  try {
    const u = await fetchMe();
    auth.user = u;
    auth.checked = true;
    if (u) {
      const info = await fetchSystemInfo();
      auth.systemName = info.system;
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
  } catch {
    // systemName remains null — non-critical
  }
}

// --- Data ---

export const data = $state({
  minds: [] as Mind[],
  conversations: [] as ConversationWithParticipants[],
  recentPages: [] as RecentPage[],
  sites: [] as Site[],
  activity: [] as ActivityItem[],
  connectionOk: true,
});

// Sync SSE connection state to data.connectionOk
$effect.root(() => {
  $effect(() => {
    data.connectionOk = connectionState.connected;
  });
});

// --- Real-time mind activity ---

/** Minds that are currently processing (between mind_active and mind_idle SSE events). */
export const activeMinds = new SvelteSet<string>();

// --- Unified SSE via connection.svelte.ts ---

function handleSSEEvent(event: SSEEvent) {
  if (event.event === "snapshot") {
    data.conversations = event.conversations ?? [];
    data.activity = event.activity ?? [];
    data.sites = event.sites ?? [];
    data.recentPages = event.recentPages ?? [];
    activeMinds.clear();
    if (Array.isArray(event.activeMinds)) {
      for (const name of event.activeMinds) activeMinds.add(name);
    }
    // Minds not in snapshot — fetch separately since they need health checks
    fetchMinds()
      .then((m) => {
        data.minds = m;
      })
      .catch((err) => {
        console.warn("[stores] failed to refresh minds:", err);
      });
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

    // Refresh minds on status changes
    if (
      item.type === "mind_started" ||
      item.type === "mind_stopped" ||
      item.type === "mind_active" ||
      item.type === "mind_idle" ||
      item.type === "mind_sleeping" ||
      item.type === "mind_waking"
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
      // Re-sort by triggering reactivity
      data.conversations = [...data.conversations];
    }
  }
}

let unsubscribeSSE: (() => void) | null = null;

export function connectActivity() {
  disconnectActivity();
  unsubscribeSSE = subscribe(handleSSEEvent);
  connect();
}

export function disconnectActivity() {
  unsubscribeSSE?.();
  unsubscribeSSE = null;
  disconnect();
}

/** Force reconnect — call after creating a new conversation to pick up the new subscription. */
export function reconnectActivity() {
  connectActivity();
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
