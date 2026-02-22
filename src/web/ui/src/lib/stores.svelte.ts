import { SvelteSet } from "svelte/reactivity";
import {
  type ConversationWithParticipants,
  fetchAllConversations,
  fetchMinds,
  fetchRecentPages,
  fetchSystemInfo,
  type Mind,
  type RecentPage,
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
  connectionOk: true,
});

export function refreshConversations() {
  fetchAllConversations()
    .then((c) => {
      data.conversations = c;
      data.connectionOk = true;
    })
    .catch(() => {
      data.connectionOk = false;
    });
}

let pollInterval: ReturnType<typeof setInterval> | null = null;

export function startPolling() {
  stopPolling();
  function refresh() {
    fetchMinds()
      .then((m) => {
        data.minds = m;
        data.connectionOk = true;
      })
      .catch(() => {
        data.connectionOk = false;
      });
    refreshConversations();
  }
  refresh();
  fetchRecentPages()
    .then((p) => {
      data.recentPages = p;
    })
    .catch(() => {
      data.connectionOk = false;
    });
  pollInterval = setInterval(refresh, 5000);
}

export function stopPolling() {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
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
