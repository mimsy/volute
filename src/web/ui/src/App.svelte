<script lang="ts">
import { onMount } from "svelte";
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
import { type Conversation, deleteConversationById, type Mind, restartDaemon } from "./lib/api";
import { type AuthUser } from "./lib/auth";
import { navigate, parseSelection, type Selection, selectionToPath } from "./lib/navigate";
import {
  auth,
  checkAuth,
  data,
  handleAuth,
  handleLogout,
  hiddenConversationIds,
  hideConversation,
  refreshConversations,
  saveSidebarWidth,
  sidebar,
  startPolling,
  stopPolling,
  unhideConversation,
} from "./lib/stores.svelte";

// Selection state
let selection = $state<Selection>(parseSelection());

// Modals
type ModalType = "newChat" | "channelBrowser" | "seed" | "admin" | "userSettings" | "mind" | null;
let activeModal = $state<ModalType>(null);
let selectedModalMind = $state<Mind | null>(null);

// Resize state
let resizing = $state(false);

// Derived
let activeConversationId = $derived(
  selection.kind === "conversation" ? (selection.conversationId ?? null) : null,
);

// Auth — one-time fetch on mount
onMount(() => {
  checkAuth();
});

// Data polling
$effect(() => {
  if (!auth.user) return;
  startPolling();
  return () => stopPolling();
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
  activeModal = "mind";
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
  activeModal = null;
  // Check for existing 2-person DM with this user
  const existing = data.conversations.find((c) => {
    if (c.type === "channel") return false;
    const parts = c.participants ?? [];
    if (parts.length !== 2) return false;
    return parts.some((p) => p.username === name);
  });
  if (existing) {
    // Unhide if it was hidden
    if (hiddenConversationIds.has(existing.id)) {
      unhideConversation(existing.id);
    }
    selection = { kind: "conversation", conversationId: existing.id };
  } else {
    selection = { kind: "conversation", mindName: name };
  }
}

function handleNewGroupCreated(conv: Conversation) {
  activeModal = null;
  refreshConversations();
  selection = { kind: "conversation", conversationId: conv.id };
}

function handleChannelJoined(conv: Conversation) {
  activeModal = null;
  refreshConversations();
  selection = { kind: "conversation", conversationId: conv.id };
}

function handleSeedCreated(mindName: string) {
  activeModal = null;
  selection = { kind: "conversation", mindName };
}

function handleSelectPage(mind: string, path: string) {
  selection = { kind: "page", mind, path };
}

function handleSelectSite(name: string) {
  selection = { kind: "site", name };
}

function handleSelectPages() {
  selection = { kind: "pages" };
}

function onAuth(u: AuthUser) {
  handleAuth(u);
}

function handleHideConversation(id: string) {
  hideConversation(id);
  if (activeConversationId === id) {
    selection = { kind: "home" };
  }
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
  sidebar.width = Math.max(180, Math.min(400, e.clientX - rect.left));
}

function handleResizeEnd() {
  if (!resizing) return;
  resizing = false;
  document.body.style.userSelect = "";
  document.body.style.cursor = "";
  saveSidebarWidth();
}
</script>

{#if !auth.checked}
  <div class="app">
    <div class="loading">Loading...</div>
  </div>
{:else if !auth.user}
  <div class="app full-height">
    <LoginPage {onAuth} />
  </div>
{:else}
  <div class="shell">
    {#if auth.user.role === "admin"}
      <UpdateBanner />
    {/if}
    <div class="shell-body">
      <div class="sidebar" style:width="{sidebar.width}px">
        <Sidebar
          minds={data.minds}
          conversations={data.conversations.filter((c) => !hiddenConversationIds.has(c.id))}
          sites={data.sites}
          {activeConversationId}
          username={auth.user.username}
          onSelectConversation={handleSelectConversation}
          onDeleteConversation={handleDeleteConversation}
          onNewChat={() => (activeModal = "newChat")}
          onBrowseChannels={() => (activeModal = "channelBrowser")}
          onOpenMind={handleOpenMindModal}
          onSelectSite={handleSelectSite}
          onSelectPages={handleSelectPages}
          onHideConversation={handleHideConversation}
          onHome={() => (selection = { kind: "home" })}
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
          minds={data.minds}
          conversations={data.conversations}
          recentPages={data.recentPages}
          sites={data.sites}
          username={auth.user.username}
          onConversationId={handleConversationId}
          onOpenMind={handleOpenMindModal}
          onSelectPage={handleSelectPage}
          onSelectSite={handleSelectSite}
          onSelectPages={handleSelectPages}
        />
      </div>
    </div>
    <StatusBar
      minds={data.minds}
      username={auth.user.username}
      systemName={auth.systemName}
      connectionOk={data.connectionOk}
      isAdmin={auth.user.role === "admin"}
      onAdminClick={() => (activeModal = "admin")}
      onRestart={() => restartDaemon()}
      onLogout={handleLogout}
      onUserSettings={() => (activeModal = "userSettings")}
      onOpenMind={handleOpenMindModal}
      onSeed={() => (activeModal = "seed")}
    />
  </div>

  {#if activeModal === "newChat"}
    <MindPickerModal minds={data.minds} onClose={() => (activeModal = null)} onPick={handleNewChatCreated} onGroupCreated={handleNewGroupCreated} />
  {/if}
  {#if activeModal === "channelBrowser"}
    <ChannelBrowserModal
      onClose={() => (activeModal = null)}
      onJoined={handleChannelJoined}
    />
  {/if}
  {#if activeModal === "seed"}
    <SeedModal onClose={() => (activeModal = null)} onCreated={handleSeedCreated} />
  {/if}
  {#if activeModal === "admin"}
    <AdminModal onClose={() => (activeModal = null)} />
  {/if}
  {#if activeModal === "userSettings"}
    <UserSettingsModal onClose={() => (activeModal = null)} />
  {/if}
  {#if activeModal === "mind" && selectedModalMind}
    <MindModal
      mind={selectedModalMind}
      onClose={() => {
        activeModal = null;
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
