import { SvelteSet } from "svelte/reactivity";
import {
  type ActivityItem,
  type ConversationWithParticipants,
  fetchMinds,
  fetchSystemInfo,
  type Mind,
  type RecentPage,
  type Site,
} from "./api";
import { type AuthUser, fetchMe, logout } from "./auth";

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

// --- Real-time mind activity ---

/** Minds that are currently processing (between mind_active and mind_idle SSE events). */
export const activeMinds = new SvelteSet<string>();

// --- Activity SSE ---

let sseController: AbortController | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

function handleSSEMessage(line: string) {
  let parsed: any;
  try {
    parsed = JSON.parse(line);
  } catch {
    return;
  }

  if (parsed.event === "snapshot") {
    data.conversations = parsed.conversations ?? [];
    data.activity = parsed.activity ?? [];
    data.sites = parsed.sites ?? [];
    data.recentPages = parsed.recentPages ?? [];
    data.connectionOk = true;
    activeMinds.clear();
    // Minds not in snapshot — fetch separately since they need health checks
    fetchMinds()
      .then((m) => {
        data.minds = m;
      })
      .catch(() => {});
  } else if (parsed.event === "activity") {
    const { event: _, ...item } = parsed;
    data.activity = [item, ...data.activity].slice(0, 50);
    // Track real-time active/idle state
    if (item.type === "mind_active") activeMinds.add(item.mind);
    if (item.type === "mind_idle" || item.type === "mind_stopped" || item.type === "mind_done")
      activeMinds.delete(item.mind);

    // Refresh minds on status changes
    if (
      item.type === "mind_started" ||
      item.type === "mind_stopped" ||
      item.type === "mind_active" ||
      item.type === "mind_idle"
    ) {
      fetchMinds()
        .then((m) => {
          data.minds = m;
        })
        .catch(() => {});
    }
    // Refresh pages on page updates
    if (item.type === "page_updated") {
      // Pages are now in the activity stream; sites/recentPages
      // will be refreshed on next snapshot (reconnect).
      // For immediate updates we could fetch, but the activity
      // timeline itself shows the update.
    }
  } else if (parsed.event === "conversation") {
    const { event: _, conversationId, ...msgEvent } = parsed;
    const conv = data.conversations.find((c) => c.id === conversationId);
    if (conv && msgEvent.type === "message") {
      // Extract text from content blocks
      let text = "";
      if (Array.isArray(msgEvent.content)) {
        for (const block of msgEvent.content) {
          if (block.type === "text") text += block.text;
        }
      }
      (conv as any).lastMessage = {
        role: msgEvent.role,
        senderName: msgEvent.senderName,
        text,
        createdAt: msgEvent.createdAt,
      };
      (conv as any).updated_at = msgEvent.createdAt;
      // Re-sort by triggering reactivity
      data.conversations = [...data.conversations];
    }
  }
}

function startSSE() {
  sseController?.abort();
  sseController = new AbortController();
  const signal = sseController.signal;

  fetch("/api/activity/events", { signal })
    .then(async (res) => {
      if (!res.ok) {
        data.connectionOk = false;
        scheduleReconnect();
        return;
      }
      if (!res.body) {
        data.connectionOk = false;
        scheduleReconnect();
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const payload = line.slice(6);
          if (payload) handleSSEMessage(payload);
        }
      }

      // Stream ended — reconnect
      if (!signal.aborted) {
        data.connectionOk = false;
        scheduleReconnect();
      }
    })
    .catch((err) => {
      if (err instanceof DOMException && err.name === "AbortError") return;
      data.connectionOk = false;
      scheduleReconnect();
    });
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    startSSE();
  }, 5000);
}

export function connectActivity() {
  disconnectActivity();
  startSSE();
}

export function disconnectActivity() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  sseController?.abort();
  sseController = null;
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
