<script lang="ts">
import AdminModal from "./components/AdminModal.svelte";
import ChannelBrowserModal from "./components/ChannelBrowserModal.svelte";
import LoginPage from "./components/LoginPage.svelte";
import MainFrame from "./components/MainFrame.svelte";
import MindModal from "./components/MindModal.svelte";
import MindPickerModal from "./components/MindPickerModal.svelte";
import SeedModal from "./components/SeedModal.svelte";
import Sidebar from "./components/Sidebar.svelte";
import StatusBar from "./components/StatusBar.svelte";
import UpdateBanner from "./components/UpdateBanner.svelte";
import UserSettingsModal from "./components/UserSettingsModal.svelte";
import {
  type Conversation,
  type ConversationWithParticipants,
  deleteConversationById,
  fetchAllConversations,
  fetchMinds,
  fetchRecentPages,
  fetchSystemInfo,
  type Mind,
  type RecentPage,
  restartDaemon,
} from "./lib/api";
import { type AuthUser, fetchMe, logout } from "./lib/auth";
import { navigate, parseSelection, type Selection, selectionToPath } from "./lib/navigate";

// Auth state
let user = $state<AuthUser | null>(null);
let authChecked = $state(false);
let systemName = $state<string | null>(null);

// Selection state
let selection = $state<Selection>(parseSelection());

// Data
let minds = $state<Mind[]>([]);
let conversations = $state<ConversationWithParticipants[]>([]);
let recentPages = $state<RecentPage[]>([]);
let connectionOk = $state(true);

// Modals
let showNewChat = $state(false);
let showChannelBrowser = $state(false);
let showSeedModal = $state(false);
let showAdminModal = $state(false);
let showUserSettings = $state(false);
let showMindModal = $state(false);
let selectedModalMind = $state<Mind | null>(null);

// Hidden chats (persisted to localStorage)
function loadHiddenChats(): Set<string> {
  try {
    const stored = localStorage.getItem("volute:hidden-chats");
    return stored ? new Set(JSON.parse(stored)) : new Set();
  } catch {
    return new Set();
  }
}
let hiddenConversationIds = $state(loadHiddenChats());

function handleHideConversation(id: string) {
  hiddenConversationIds.add(id);
  hiddenConversationIds = new Set(hiddenConversationIds);
  localStorage.setItem("volute:hidden-chats", JSON.stringify([...hiddenConversationIds]));
  if (activeConversationId === id) {
    selection = { kind: "home" };
  }
}

// Resize state
let sidebarWidth = $state(loadSidebarWidth());
let resizing = $state(false);

function loadSidebarWidth(): number {
  try {
    const stored = localStorage.getItem("volute:sidebar-width");
    return stored ? Math.max(180, Math.min(400, Number(stored))) : 240;
  } catch {
    return 240;
  }
}

// Derived
let activeConversationId = $derived(
  selection.kind === "conversation" ? (selection.conversationId ?? null) : null,
);

// Auth
$effect(() => {
  fetchMe()
    .then(async (u) => {
      user = u;
      authChecked = true;
      if (u) {
        const info = await fetchSystemInfo();
        systemName = info.system;
      }
    })
    .catch(() => {
      authChecked = true;
    });
});

// Data helpers
function refreshConversations() {
  fetchAllConversations()
    .then((c) => {
      conversations = c;
      connectionOk = true;
    })
    .catch(() => {
      connectionOk = false;
    });
}

// Data polling
$effect(() => {
  if (!user) return;
  function refresh() {
    fetchMinds()
      .then((m) => {
        minds = m;
        connectionOk = true;
      })
      .catch(() => {
        connectionOk = false;
      });
    refreshConversations();
  }
  refresh();
  fetchRecentPages()
    .then((p) => {
      recentPages = p;
    })
    .catch(() => {});
  const interval = setInterval(refresh, 5000);
  return () => clearInterval(interval);
});

// Track whether selection change came from popstate (to avoid pushing duplicate history)
let fromPopstate = $state(false);

// URL sync: popstate → selection
$effect(() => {
  const handler = () => {
    fromPopstate = true;
    selection = parseSelection();
  };
  window.addEventListener("popstate", handler);
  // Intercept internal link clicks for SPA navigation
  const handleClick = (e: MouseEvent) => {
    const link = (e.target as Element).closest("a");
    if (!link) return;
    const href = link.getAttribute("href");
    if (!href || href.startsWith("http") || href.startsWith("//") || link.target === "_blank")
      return;
    if (e.metaKey || e.ctrlKey || e.shiftKey) return;
    e.preventDefault();
    navigate(href);
  };
  document.addEventListener("click", handleClick);
  return () => {
    window.removeEventListener("popstate", handler);
    document.removeEventListener("click", handleClick);
  };
});

// Selection → URL sync
$effect(() => {
  const expected = selectionToPath(selection);
  const current = window.location.pathname + window.location.search;
  if (current !== expected) {
    if (fromPopstate) {
      window.history.replaceState(null, "", expected);
    } else {
      window.history.pushState(null, "", expected);
    }
  }
  fromPopstate = false;
});

// Actions
function handleOpenMindModal(mind: Mind) {
  selectedModalMind = mind;
  showMindModal = true;
}

function handleSelectConversation(id: string) {
  selection = { kind: "conversation", conversationId: id };
}

async function handleDeleteConversation(id: string) {
  try {
    await deleteConversationById(id);
  } catch (err) {
    console.error("Failed to delete conversation:", err);
    return;
  }
  refreshConversations();
  if (activeConversationId === id) {
    selection = { kind: "home" };
  }
}

function handleConversationId(id: string) {
  selection = { kind: "conversation", conversationId: id };
  refreshConversations();
}

function handleNewChatCreated(name: string) {
  showNewChat = false;
  // Check for existing 2-person DM with this user
  const existing = conversations.find((c) => {
    if (c.type === "channel") return false;
    const parts = c.participants ?? [];
    if (parts.length !== 2) return false;
    return parts.some((p) => p.username === name);
  });
  if (existing) {
    // Unhide if it was hidden
    if (hiddenConversationIds.has(existing.id)) {
      hiddenConversationIds.delete(existing.id);
      hiddenConversationIds = new Set(hiddenConversationIds);
      localStorage.setItem("volute:hidden-chats", JSON.stringify([...hiddenConversationIds]));
    }
    selection = { kind: "conversation", conversationId: existing.id };
  } else {
    selection = { kind: "conversation", mindName: name };
  }
}

function handleNewGroupCreated(conv: Conversation) {
  showNewChat = false;
  refreshConversations();
  selection = { kind: "conversation", conversationId: conv.id };
}

function handleChannelJoined(conv: Conversation) {
  showChannelBrowser = false;
  refreshConversations();
  selection = { kind: "conversation", conversationId: conv.id };
}

function handleSeedCreated(mindName: string) {
  showSeedModal = false;
  selection = { kind: "conversation", mindName };
}

function handleSelectPage(mind: string, path: string) {
  selection = { kind: "page", mind, path };
}

async function handleLogout() {
  try {
    await logout();
  } catch {
    // Best effort
  }
  user = null;
}

async function handleAuth(u: AuthUser) {
  user = u;
  const info = await fetchSystemInfo();
  systemName = info.system;
}

// Resize
function handleResizeStart(e: PointerEvent) {
  resizing = true;
  const target = e.currentTarget as HTMLElement;
  target.setPointerCapture(e.pointerId);
  document.body.style.userSelect = "none";
  document.body.style.cursor = "col-resize";
}

function handleResizeMove(e: PointerEvent) {
  if (!resizing) return;
  const shellBody = (e.currentTarget as HTMLElement).parentElement;
  if (!shellBody) return;
  const rect = shellBody.getBoundingClientRect();
  sidebarWidth = Math.max(180, Math.min(400, e.clientX - rect.left));
}

function handleResizeEnd() {
  if (!resizing) return;
  resizing = false;
  document.body.style.userSelect = "";
  document.body.style.cursor = "";
  localStorage.setItem("volute:sidebar-width", String(sidebarWidth));
}
</script>

{#if !authChecked}
  <div class="app">
    <div class="loading">Loading...</div>
  </div>
{:else if !user}
  <div class="app full-height">
    <LoginPage onAuth={handleAuth} />
  </div>
{:else}
  <div class="shell">
    {#if user.role === "admin"}
      <UpdateBanner />
    {/if}
    <div class="shell-body">
      <div class="sidebar" style:width="{sidebarWidth}px">
        <Sidebar
          {minds}
          conversations={conversations.filter((c) => !hiddenConversationIds.has(c.id))}
          pages={recentPages}
          {activeConversationId}
          username={user.username}
          onSelectConversation={handleSelectConversation}
          onDeleteConversation={handleDeleteConversation}
          onNewChat={() => (showNewChat = true)}
          onBrowseChannels={() => (showChannelBrowser = true)}
          onOpenMind={handleOpenMindModal}
          onSelectPage={handleSelectPage}
          onHideConversation={handleHideConversation}
        />
      </div>
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        class="resize-handle"
        onpointerdown={handleResizeStart}
        onpointermove={handleResizeMove}
        onpointerup={handleResizeEnd}
        onpointercancel={handleResizeEnd}
      ></div>
      <div class="main-frame">
        <MainFrame
          {selection}
          {minds}
          {conversations}
          {recentPages}
          username={user.username}
          onConversationId={handleConversationId}
          onOpenMind={handleOpenMindModal}
          onSelectPage={handleSelectPage}
        />
      </div>
    </div>
    <StatusBar
      {minds}
      username={user.username}
      {systemName}
      {connectionOk}
      isAdmin={user.role === "admin"}
      onAdminClick={() => (showAdminModal = true)}
      onRestart={() => restartDaemon()}
      onLogout={handleLogout}
      onUserSettings={() => (showUserSettings = true)}
      onOpenMind={handleOpenMindModal}
      onSeed={() => (showSeedModal = true)}
    />
  </div>

  {#if showNewChat}
    <MindPickerModal {minds} onClose={() => (showNewChat = false)} onPick={handleNewChatCreated} onGroupCreated={handleNewGroupCreated} />
  {/if}
  {#if showChannelBrowser}
    <ChannelBrowserModal
      onClose={() => (showChannelBrowser = false)}
      onJoined={handleChannelJoined}
    />
  {/if}
  {#if showSeedModal}
    <SeedModal onClose={() => (showSeedModal = false)} onCreated={handleSeedCreated} />
  {/if}
  {#if showAdminModal}
    <AdminModal onClose={() => (showAdminModal = false)} />
  {/if}
  {#if showUserSettings}
    <UserSettingsModal onClose={() => (showUserSettings = false)} />
  {/if}
  {#if showMindModal && selectedModalMind}
    <MindModal
      mind={selectedModalMind}
      onClose={() => {
        showMindModal = false;
        selectedModalMind = null;
      }}
    />
  {/if}
{/if}

<style>
  .loading {
    color: var(--text-2);
    padding: 24px;
    text-align: center;
  }

  .full-height {
    height: 100%;
  }

  .shell {
    height: 100%;
    display: flex;
    flex-direction: column;
  }

  .shell-body {
    flex: 1;
    display: flex;
    overflow: hidden;
  }

  .sidebar {
    display: flex;
    flex-direction: column;
    flex-shrink: 0;
    border-right: 1px solid var(--border);
    background: var(--bg-1);
    overflow: hidden;
  }

  .resize-handle {
    width: 4px;
    cursor: col-resize;
    flex-shrink: 0;
    background: transparent;
    transition: background 0.15s;
  }

  .resize-handle:hover {
    background: var(--border);
  }

  .main-frame {
    flex: 1;
    overflow: hidden;
    min-width: 0;
  }
</style>
