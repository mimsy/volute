<script lang="ts">
import type { Conversation, Mind } from "@volute/api";
import { onMount } from "svelte";
import AdminModal from "./components/AdminModal.svelte";
import ChannelBrowserModal from "./components/ChannelBrowserModal.svelte";
import ChannelMembersPanel from "./components/ChannelMembersPanel.svelte";
import ChatSidebar from "./components/ChatSidebar.svelte";
import LoginPage from "./components/LoginPage.svelte";
import MainFrame from "./components/MainFrame.svelte";
import MindModal from "./components/MindModal.svelte";
import MindPickerModal from "./components/MindPickerModal.svelte";
import SeedModal from "./components/SeedModal.svelte";
import StatusBar from "./components/StatusBar.svelte";
import SystemSidebar from "./components/SystemSidebar.svelte";
import TabSwitcher from "./components/TabSwitcher.svelte";
import UpdateBanner from "./components/UpdateBanner.svelte";
import UserSettingsModal from "./components/UserSettingsModal.svelte";
import { type AuthUser } from "./lib/auth";
import { deleteConversation, restartDaemon } from "./lib/client";
import {
  navigate,
  parseSelection,
  type Selection,
  selectionToPath,
  type Tab,
} from "./lib/navigate";
import { requestNotificationPermission } from "./lib/notifications";
import {
  auth,
  checkAuth,
  closeSidebar,
  connectActivity,
  data,
  disconnectActivity,
  handleAuth,
  handleLogout,
  hiddenConversationIds,
  hideConversation,
  layout,
  reconnectActivity,
  rightPanel,
  saveRightPanelWidth,
  saveSidebarWidth,
  setActiveConversation,
  sidebar,
  toggleSidebar,
  unhideConversation,
  unreadCounts,
} from "./lib/stores.svelte";

// Selection state
let selection = $state<Selection>(parseSelection());

// Tab context memory: remember last selection per tab
let lastSystemSelection = $state<Selection>({ tab: "system", kind: "home" });
let lastChatSelection = $state<Selection>({ tab: "chat", kind: "home" });

// Keep tab memory up to date
$effect(() => {
  if (selection.tab === "system") {
    lastSystemSelection = selection;
  } else {
    lastChatSelection = selection;
  }
});

// Derived
let activeTab = $derived<Tab>(selection.tab);

// Total unread for chat badge (exclude hidden conversations)
let chatUnreadCount = $derived.by(() => {
  let total = 0;
  for (const [id, count] of unreadCounts.entries()) {
    if (!hiddenConversationIds.has(id)) {
      total += count;
    }
  }
  return total;
});

// Modals
type ModalType = "newChat" | "channelBrowser" | "seed" | "admin" | "userSettings" | "mind" | null;
let activeModal = $state<ModalType>(null);
let selectedModalMind = $state<Mind | null>(null);

// Resize state
let resizing = $state(false);

// Typing state for channel members panel
let typingNames = $state<string[]>([]);

// Right panel: hidden on mobile unless explicitly opened
let rightPanelOpen = $state(false);

// Chat-specific derived values
let activeConversationId = $derived(
  selection.kind === "conversation" ? (selection.conversationId ?? null) : null,
);

// Sync active conversation for unread tracking
$effect(() => {
  setActiveConversation(activeConversationId);
  rightPanelOpen = false;
});

// Right panel: auto-show mind details for DMs, channel members for channels
let activeConv = $derived.by(() => {
  const sel = selection;
  if (sel.kind !== "conversation") return undefined;
  if (!sel.conversationId) return undefined;
  return data.conversations.find((c) => c.id === sel.conversationId);
});

let contextMindName = $derived.by(() => {
  if (selection.kind !== "conversation") return "";
  if (selection.mindName) return selection.mindName;
  if (!activeConv || activeConv.type === "channel" || activeConv.type === "group") return "";
  return activeConv.mind_name ?? "";
});

let contextMind = $derived(
  contextMindName ? data.minds.find((m) => m.name === contextMindName) : undefined,
);

let rightPanelMind = $derived(
  activeModal === "mind" && selectedModalMind ? selectedModalMind : (contextMind ?? undefined),
);

let rightPanelIsManual = $derived(!!(activeModal === "mind" && selectedModalMind));

// Right panel only in chat tab
let hasRightPanel = $derived(
  activeTab === "chat" &&
    (!!rightPanelMind || activeConv?.type === "channel" || activeConv?.type === "group"),
);

let showRightPanel = $derived(hasRightPanel);

// Auth — one-time fetch on mount
onMount(() => {
  checkAuth();
});

// Data polling
$effect(() => {
  if (!auth.user) return;
  connectActivity();
  return () => disconnectActivity();
});

// Request notification permission after login
$effect(() => {
  if (!auth.user) return;
  requestNotificationPermission();
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
function openRightPanel() {
  rightPanelOpen = true;
}

function closeRightPanel() {
  if (rightPanelIsManual) {
    activeModal = null;
    selectedModalMind = null;
  }
  rightPanelOpen = false;
}

function handleOpenMindModal(mind: Mind) {
  // In system tab, navigate to mind page. In chat tab, show right panel.
  if (activeTab === "system") {
    selection = { tab: "system", kind: "mind", name: mind.name };
    closeSidebar();
  } else {
    selectedModalMind = mind;
    activeModal = "mind";
    rightPanelOpen = true;
  }
}

function handleSelectConversation(id: string) {
  selection = { tab: "chat", kind: "conversation", conversationId: id };
  setActiveConversation(id);
  closeSidebar();
  if (activeModal === "mind") {
    activeModal = null;
    selectedModalMind = null;
  }
}

async function handleDeleteConversation(id: string) {
  try {
    await deleteConversation(id);
  } catch (err) {
    console.error("Failed to delete conversation:", err);
    return;
  }
  reconnectActivity();
  if (activeConversationId === id) {
    selection = { tab: "chat", kind: "home" };
  }
}

function handleConversationId(id: string) {
  selection = { tab: "chat", kind: "conversation", conversationId: id };
  setActiveConversation(id);
  reconnectActivity();
}

function handleNewChatCreated(name: string) {
  activeModal = null;
  selectedModalMind = null;
  closeSidebar();
  // Check for existing 2-person DM with this user
  const existing = data.conversations.find((c) => {
    if (c.type === "channel") return false;
    const parts = c.participants ?? [];
    if (parts.length !== 2) return false;
    return parts.some((p) => p.username === name);
  });
  if (existing) {
    if (hiddenConversationIds.has(existing.id)) {
      unhideConversation(existing.id);
    }
    selection = { tab: "chat", kind: "conversation", conversationId: existing.id };
  } else {
    selection = { tab: "chat", kind: "conversation", mindName: name };
  }
}

function handleNewGroupCreated(conv: Conversation) {
  activeModal = null;
  selectedModalMind = null;
  closeSidebar();
  reconnectActivity();
  selection = { tab: "chat", kind: "conversation", conversationId: conv.id };
}

function handleChannelJoined(conv: Conversation) {
  activeModal = null;
  selectedModalMind = null;
  closeSidebar();
  reconnectActivity();
  selection = { tab: "chat", kind: "conversation", conversationId: conv.id };
}

function handleSeedCreated(mindName: string) {
  activeModal = null;
  selectedModalMind = null;
  closeSidebar();
  selection = { tab: "chat", kind: "conversation", mindName };
}

function handleSelectPage(mind: string, path: string) {
  selection = { tab: "system", kind: "page", mind, path };
}

function handleSelectSite(name: string) {
  selection = { tab: "system", kind: "site", name };
}

function handleSelectPages() {
  selection = { tab: "system", kind: "pages" };
}

function onAuth(u: AuthUser) {
  handleAuth(u);
}

function handleHideConversation(id: string) {
  hideConversation(id);
  if (activeConversationId === id) {
    selection = { tab: "chat", kind: "home" };
  }
}

function handleTabSwitch(tab: Tab) {
  if (tab === selection.tab) return;
  selection = tab === "system" ? lastSystemSelection : lastChatSelection;
  closeSidebar();
}

function handleSystemHome() {
  selection = { tab: "system", kind: "home" };
}

function handleSelectMind(name: string) {
  selection = { tab: "system", kind: "mind", name };
  closeSidebar();
}

function handleSelectMindSection(name: string, section: string) {
  selection = { tab: "system", kind: "mind", name, section: section as any };
}

function handleSelectNotes() {
  selection = { tab: "system", kind: "notes" };
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

// Right panel resize
let resizingRight = $state(false);

function handleRightResizeStart(e: PointerEvent) {
  resizingRight = true;
  const target = e.currentTarget as HTMLElement;
  target.setPointerCapture(e.pointerId);
  document.body.style.userSelect = "none";
  document.body.style.cursor = "col-resize";
}

function handleRightResizeMove(e: PointerEvent) {
  if (!resizingRight) return;
  const shellBody = (e.currentTarget as HTMLElement).parentElement;
  if (!shellBody) return;
  const rect = shellBody.getBoundingClientRect();
  rightPanel.width = Math.max(240, Math.min(600, rect.right - e.clientX));
}

function handleRightResizeEnd() {
  if (!resizingRight) return;
  resizingRight = false;
  document.body.style.userSelect = "";
  document.body.style.cursor = "";
  saveRightPanelWidth();
}

function handleEscape(e: KeyboardEvent) {
  if (e.key !== "Escape") return;
  if (rightPanelOpen) {
    closeRightPanel();
    return;
  }
  if (layout.sidebarOpen) {
    closeSidebar();
    return;
  }
}
</script>

<svelte:window onkeydown={handleEscape} />

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
      <div class="sidebar" class:sidebar-open={layout.sidebarOpen} style:width="{sidebar.width}px">
        <button class="sidebar-header" onclick={handleSystemHome}>
          <span class="header-logo-wrap">
            <img src="/logo.png" alt="" class="sidebar-logo" />
            <span class="hover-dot"></span>
          </span>
          <span class="sidebar-title">volute</span>
        </button>
        <TabSwitcher {activeTab} onSwitch={handleTabSwitch} {chatUnreadCount} />
        {#if activeTab === "system"}
          <SystemSidebar
            minds={data.minds}
            sites={data.sites}
            {selection}
            onHome={handleSystemHome}
            onSelectMind={handleSelectMind}
            onSelectMindSection={handleSelectMindSection}
            onSelectNotes={handleSelectNotes}
            onSelectPages={handleSelectPages}
            onSeed={() => (activeModal = "seed")}
          />
        {:else}
          <ChatSidebar
            minds={data.minds}
            conversations={data.conversations.filter((c) => !hiddenConversationIds.has(c.id))}
            {activeConversationId}
            username={auth.user.username}
            onSelectConversation={handleSelectConversation}
            onDeleteConversation={handleDeleteConversation}
            onNewChat={() => (activeModal = "newChat")}
            onBrowseChannels={() => (activeModal = "channelBrowser")}
            onOpenMind={handleOpenMindModal}
            onSelectMind={handleNewChatCreated}
            onSeed={() => (activeModal = "seed")}
            onHideConversation={handleHideConversation}
          />
        {/if}
      </div>
      {#if layout.sidebarOpen}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div class="sidebar-backdrop" onclick={closeSidebar}></div>
      {/if}
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
          activity={data.activity}
          username={auth.user.username}
          onConversationId={handleConversationId}
          onSelectConversation={handleSelectConversation}
          onOpenMind={handleOpenMindModal}
          onSelectPage={handleSelectPage}
          onSelectSite={handleSelectSite}
          onSelectPages={handleSelectPages}
          onSelectNotes={handleSelectNotes}
          onTypingNames={(names) => { typingNames = names; }}
          onToggleSidebar={toggleSidebar}
          onOpenRightPanel={hasRightPanel ? openRightPanel : undefined}
        />
      </div>
      {#if showRightPanel}
        {#if rightPanelOpen}
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div class="right-panel-backdrop" onclick={closeRightPanel}></div>
        {/if}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
          class="resize-handle right-resize-handle"
          onpointerdown={handleRightResizeStart}
          onpointermove={handleRightResizeMove}
          onpointerup={handleRightResizeEnd}
          onpointercancel={handleRightResizeEnd}
        ></div>
        <div class="right-panel" class:right-panel-open={rightPanelOpen} style:width="{rightPanel.width}px">
          {#if rightPanelMind}
            {#key rightPanelMind.name}
              <MindModal
                mind={rightPanelMind}
                onClose={closeRightPanel}
                onViewProfile={() => { handleSelectMind(rightPanelMind!.name); closeRightPanel(); }}
              />
            {/key}
          {:else if activeConv?.type === "channel" || activeConv?.type === "group"}
            <ChannelMembersPanel
              conversation={activeConv}
              minds={data.minds}
              {typingNames}
              onOpenMind={handleOpenMindModal}
            />
          {/if}
        </div>
      {/if}
    </div>
    <StatusBar
      username={auth.user.username}
      systemName={auth.systemName}
      connectionOk={data.connectionOk}
      isAdmin={auth.user.role === "admin"}
      onAdminClick={() => (activeModal = "admin")}
      onRestart={() => restartDaemon()}
      onLogout={handleLogout}
      onUserSettings={() => (activeModal = "userSettings")}
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
    <AdminModal onClose={() => (activeModal = null)} minds={data.minds} />
  {/if}
  {#if activeModal === "userSettings"}
    <UserSettingsModal onClose={() => (activeModal = null)} />
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

  .sidebar-header {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 12px 12px;
    flex-shrink: 0;
    background: none;
    cursor: pointer;
    border-bottom: 1px solid var(--border);
  }

  .header-logo-wrap {
    position: relative;
    width: 30px;
    height: 30px;
    flex-shrink: 0;
  }

  .sidebar-logo {
    width: 30px;
    height: 30px;
    filter: invert(1);
    transition: opacity 0.15s;
  }

  .hover-dot {
    position: absolute;
    inset: 0;
    margin: auto;
    width: 10px;
    height: 10px;
    border-radius: 50%;
    opacity: 0;
    transition: opacity 0.15s;
    animation: iridescent 3s ease-in-out infinite;
  }

  .sidebar-header:hover .sidebar-logo {
    opacity: 0;
  }

  .sidebar-header:hover .hover-dot {
    opacity: 1;
  }

  .sidebar-title {
    font-family: var(--display);
    font-size: 26px;
    font-weight: 300;
    color: var(--text-0);
    letter-spacing: 0.04em;
    margin-top: -4px;
    margin-left: -4px;
  }

  @keyframes iridescent {
    0%   { background: #4ade80; }
    16%  { background: #60a5fa; }
    33%  { background: #c084fc; }
    50%  { background: #f472b6; }
    66%  { background: #fbbf24; }
    83%  { background: #34d399; }
    100% { background: #4ade80; }
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

  .right-panel {
    flex-shrink: 0;
    border-left: 1px solid var(--border);
    overflow: hidden;
  }

  .right-panel-backdrop {
    display: none;
  }

  .sidebar-backdrop {
    display: none;
  }

  /* Right panel: hide on small screens, show on toggle */
  @media (max-width: 1024px) {
    .right-panel {
      display: none;
    }

    .right-panel.right-panel-open {
      display: block;
      position: fixed;
      top: 0;
      right: 0;
      bottom: 0;
      z-index: 40;
      width: min(360px, 100vw) !important;
    }

    .right-resize-handle {
      display: none;
    }

    .right-panel-backdrop {
      display: block;
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.5);
      z-index: 39;
    }
  }

  /* Mobile */
  @media (max-width: 767px) {
    .sidebar {
      position: fixed;
      top: 0;
      left: 0;
      bottom: 0;
      z-index: 50;
      width: 280px !important;
      transform: translateX(-100%);
      transition: transform 0.2s ease;
    }

    .sidebar.sidebar-open {
      transform: translateX(0);
      overflow: visible;
    }

    .sidebar-backdrop {
      display: block;
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.5);
      z-index: 49;
    }

    .resize-handle {
      display: none;
    }
  }

  @media (max-width: 767px) {
    .sidebar-header {
      display: none;
    }
  }

  /* Tablet */
  @media (min-width: 768px) and (max-width: 1024px) {
    .sidebar {
      width: 200px !important;
    }

    .resize-handle {
      display: none;
    }
  }
</style>
