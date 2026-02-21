<script lang="ts">
import AdminModal from "./components/AdminModal.svelte";
import ChannelBrowserModal from "./components/ChannelBrowserModal.svelte";
import GroupModal from "./components/GroupModal.svelte";
import LoginPage from "./components/LoginPage.svelte";
import MainFrame from "./components/MainFrame.svelte";
import MindPickerModal from "./components/MindPickerModal.svelte";
import SeedModal from "./components/SeedModal.svelte";
import Sidebar from "./components/Sidebar.svelte";
import StatusBar from "./components/StatusBar.svelte";
import UpdateBanner from "./components/UpdateBanner.svelte";
import {
  type Conversation,
  deleteConversationById,
  fetchAllConversations,
  fetchMinds,
  fetchRecentPages,
  fetchSystemInfo,
  type Mind,
  type Participant,
  type RecentPage,
} from "./lib/api";
import { type AuthUser, fetchMe, logout } from "./lib/auth";
import { navigate, parseSelection, type Selection, selectionToPath } from "./lib/navigate";

type ConversationWithParticipants = Conversation & { participants: Participant[] };

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

// Modals
let showNewChat = $state(false);
let showGroupModal = $state(false);
let showChannelBrowser = $state(false);
let showSeedModal = $state(false);
let showAdminModal = $state(false);

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
let selectedMind = $derived(selection.kind === "mind" ? selection.name : null);
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

// Data polling
$effect(() => {
  if (!user) return;
  function refresh() {
    fetchMinds()
      .then((m) => {
        minds = m;
      })
      .catch(() => {});
    fetchAllConversations()
      .then((c) => {
        conversations = c;
      })
      .catch(() => {});
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
let fromPopstate = false;

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
function setSelection(sel: Selection) {
  selection = sel;
}

function handleSelectMind(name: string) {
  setSelection({ kind: "mind", name });
}

function handleSelectConversation(id: string) {
  setSelection({ kind: "conversation", conversationId: id });
}

async function handleDeleteConversation(id: string) {
  try {
    await deleteConversationById(id);
  } catch (err) {
    console.error("Failed to delete conversation:", err);
    return;
  }
  fetchAllConversations()
    .then((c) => {
      conversations = c;
    })
    .catch(() => {});
  if (activeConversationId === id) {
    setSelection({ kind: "home" });
  }
}

function handleConversationId(id: string) {
  setSelection({ kind: "conversation", conversationId: id });
  fetchAllConversations()
    .then((c) => {
      conversations = c;
    })
    .catch(() => {});
}

function handleNewChatCreated(mind: string) {
  showNewChat = false;
  setSelection({ kind: "conversation", mindName: mind });
}

function handleGroupCreated(conv: Conversation) {
  showGroupModal = false;
  fetchAllConversations()
    .then((c) => {
      conversations = c;
    })
    .catch(() => {});
  setSelection({ kind: "conversation", conversationId: conv.id });
}

function handleChannelJoined(conv: Conversation) {
  showChannelBrowser = false;
  fetchAllConversations()
    .then((c) => {
      conversations = c;
    })
    .catch(() => {});
  setSelection({ kind: "conversation", conversationId: conv.id });
}

function handleSeedCreated(mindName: string) {
  showSeedModal = false;
  setSelection({ kind: "conversation", mindName });
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
          {conversations}
          pages={recentPages}
          {selectedMind}
          {activeConversationId}
          username={user.username}
          onSelectMind={handleSelectMind}
          onSelectConversation={handleSelectConversation}
          onDeleteConversation={handleDeleteConversation}
          onNewChat={() => (showNewChat = true)}
          onNewGroup={() => (showGroupModal = true)}
          onBrowseChannels={() => (showChannelBrowser = true)}
          onSeed={() => (showSeedModal = true)}
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
          username={user.username}
          onConversationId={handleConversationId}
        />
      </div>
    </div>
    <StatusBar
      {minds}
      username={user.username}
      {systemName}
      isAdmin={user.role === "admin"}
      onAdminClick={() => (showAdminModal = true)}
      onLogout={handleLogout}
    />
  </div>

  {#if showNewChat}
    <MindPickerModal onClose={() => (showNewChat = false)} onPick={handleNewChatCreated} />
  {/if}
  {#if showGroupModal}
    <GroupModal onClose={() => (showGroupModal = false)} onCreated={handleGroupCreated} />
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
