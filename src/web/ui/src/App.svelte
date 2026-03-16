<script lang="ts">
import type { Conversation, Mind } from "@volute/api";
import { onMount } from "svelte";
import ChannelBrowserModal from "./components/ChannelBrowserModal.svelte";
import ChannelMembersPanel from "./components/ChannelMembersPanel.svelte";
import ChatSidebar from "./components/ChatSidebar.svelte";
import LoginPage from "./components/LoginPage.svelte";
import MainFrame from "./components/MainFrame.svelte";
import MindRightPanel from "./components/MindRightPanel.svelte";
import SeedModal from "./components/SeedModal.svelte";
import SystemSidebar from "./components/SystemSidebar.svelte";
import TabSwitcher from "./components/TabSwitcher.svelte";
import UpdateBanner from "./components/UpdateBanner.svelte";
import UserSettingsModal from "./components/UserSettingsModal.svelte";
import { type AuthUser, fetchMe } from "./lib/auth";
import { deleteConversation } from "./lib/client";
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
import SetupPage from "./pages/SetupPage.svelte";

// Selection state
let selection = $state<Selection>(parseSelection(data.extensions));

// Mind section tabs for page header
const CORE_MIND_SECTIONS: { key: string; label: string; icon: string; defaultPath?: string }[] = [
  {
    key: "info",
    label: "Info",
    icon: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6"/><path d="M8 7v4"/><circle cx="8" cy="5" r="0.5" fill="currentColor"/></svg>',
  },
  {
    key: "files",
    label: "Files",
    icon: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4h5l2-2h5v11H2V4z"/></svg>',
  },
  {
    key: "settings",
    label: "Settings",
    icon: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="2"/><path d="M8 1v2M8 13v2M1 8h2M13 8h2M3.05 3.05l1.41 1.41M11.54 11.54l1.41 1.41M3.05 12.95l1.41-1.41M11.54 4.46l1.41-1.41"/></svg>',
  },
];

let allMindSections = $derived([
  ...CORE_MIND_SECTIONS,
  ...data.extensions.flatMap((ext) =>
    (ext.mindSections ?? []).map((s) => ({
      key: `ext:${ext.id}:${s.id}`,
      label: s.label,
      icon: s.icon,
      defaultPath: s.defaultPath,
    })),
  ),
]);

let activeMindName = $derived.by(() => {
  if (selection.tab !== "system") return null;
  if (selection.kind === "mind") return selection.name;
  return null;
});

let activeMindSection = $derived.by(() => {
  if (selection.tab !== "system") return null;
  if (selection.kind === "mind") return selection.section ?? "info";
  return null;
});

// System section tabs (shown when on system-level pages, not mind pages)
let onSystemPage = $derived(selection.tab === "system" && selection.kind !== "mind");

let activeSystemSection = $derived.by((): string | null => {
  if (!onSystemPage) return null;
  if (selection.kind === "home") return "home";
  if (selection.kind === "extension") return `ext:${selection.extensionId}`;
  if (selection.kind === "settings") return "settings";
  if (selection.kind === "shared-files") return "shared-files";
  return null;
});

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
type ModalType = "channelBrowser" | "seed" | "userSettings" | "mind" | null;
let activeModal = $state<ModalType>(null);
let selectedModalMind = $state<Mind | null>(null);

// Resize state
let resizing = $state(false);

// Typing state for channel members panel
let typingNames = $state<string[]>([]);

// Right panel: hidden on mobile unless explicitly opened
let rightPanelOpen = $state(false);
let rightPanelCollapsed = $state(false);

// Responsive viewport tracking
let narrowViewport = $state(false);

// User menu
let showUserMenu = $state(false);
let userAvatar = $state<string | null>(null);

// Auto-collapse right panel on narrow viewports
$effect(() => {
  if (narrowViewport) {
    rightPanelCollapsed = true;
  } else {
    rightPanelCollapsed = false;
  }
});

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
  if (!activeConv || activeConv.type === "channel") return "";
  return activeConv.mind_name ?? "";
});

let contextMind = $derived(
  contextMindName ? data.minds.find((m) => m.name === contextMindName) : undefined,
);

let rightPanelMind = $derived(
  activeModal === "mind" && selectedModalMind ? selectedModalMind : (contextMind ?? undefined),
);

let rightPanelIsManual = $derived(!!(activeModal === "mind" && selectedModalMind));

// Show chat button in right panel unless already in a DM with that mind
let showRightPanelChat = $derived.by(() => {
  if (!rightPanelMind) return false;
  // In chat tab: hide if this is the natural DM context (not manually opened)
  if (!rightPanelIsManual && activeConv?.type === "dm") return false;
  return true;
});

// Show mind page button in right panel
let showRightPanelProfile = $derived(!!rightPanelMind);

let hasRightPanel = $derived(
  activeTab === "chat" && (!!rightPanelMind || activeConv?.type === "channel"),
);

let showRightPanel = $derived(
  hasRightPanel && (!rightPanelCollapsed || (narrowViewport && rightPanelOpen)),
);

// Breadcrumb label for chat conversations
let chatBreadcrumbLabel = $derived.by(() => {
  if (selection.kind !== "conversation") return "";
  if (activeConv?.type === "channel" && activeConv.name) return `#${activeConv.name}`;
  if (contextMind) return contextMind.displayName ?? contextMind.name;
  if (contextMindName) return contextMindName;
  return "";
});

// Page breadcrumbs
type Breadcrumb = { label: string; action?: () => void };
let breadcrumbs = $derived.by((): Breadcrumb[] => {
  const sel = selection;
  const crumbs: Breadcrumb[] = [];
  if (sel.tab === "system") {
    crumbs.push({ label: "system", action: handleSystemHome });
    if (sel.kind === "mind") {
      crumbs.push({ label: sel.name, action: () => navigate(`/minds/${sel.name}`) });
      if (sel.section && sel.section !== "info") {
        // Strip ext: prefix for display (e.g. "ext:notes:notes" → "notes")
        let sectionLabel = sel.section;
        if (sectionLabel.startsWith("ext:")) {
          const parts = sectionLabel.split(":");
          sectionLabel = parts[2] ?? parts[1];
        }
        crumbs.push({
          label: sectionLabel,
          action: sel.subpath ? () => navigate(`/minds/${sel.name}/${sectionLabel}`) : undefined,
        });
        if (sel.subpath) {
          crumbs.push({ label: sel.subpath });
        }
      }
    } else if (sel.kind === "extension") {
      const ext = data.extensions.find((e) => e.id === sel.extensionId);
      const extBase = ext?.systemSection?.urlPatterns?.[0];
      crumbs.push({
        label: ext?.name ?? sel.extensionId,
        action: sel.path ? () => navigate(extBase ?? `/ext/${sel.extensionId}`) : undefined,
      });
      if (sel.path) {
        const pathParts = sel.path.split("/");
        for (let i = 0; i < pathParts.length; i++) {
          const isLast = i === pathParts.length - 1;
          const partialPath = pathParts.slice(0, i + 1).join("/");
          crumbs.push({
            label: pathParts[i],
            action: !isLast && extBase ? () => navigate(`${extBase}/${partialPath}`) : undefined,
          });
        }
      }
    } else if (sel.kind === "settings") {
      crumbs.push({ label: "settings" });
    } else if (sel.kind === "shared-files") {
      crumbs.push({ label: "shared files" });
    }
  } else {
    crumbs.push({ label: "chat" });
    if (sel.kind === "conversation" && chatBreadcrumbLabel) {
      crumbs.push({ label: chatBreadcrumbLabel });
    }
  }
  return crumbs;
});

// Auth — one-time fetch on mount
onMount(() => {
  checkAuth();

  const mql = window.matchMedia("(max-width: 1024px)");
  narrowViewport = mql.matches;
  const mqlHandler = (e: MediaQueryListEvent) => {
    narrowViewport = e.matches;
  };
  mql.addEventListener("change", mqlHandler);

  // Listen for navigation messages from extension iframes.
  // Only process when current selection is an extension view, so that
  // late-arriving messages from iframes being hidden don't override tab switches.
  const messageHandler = (e: MessageEvent) => {
    if (e.origin !== window.location.origin) return;
    if (e.data?.type === "navigate" && typeof e.data.path === "string") {
      const sel = selection;
      const isExtView =
        sel.kind === "extension" || (sel.kind === "mind" && sel.section?.startsWith("ext:"));
      if (!isExtView) return;
      navigate(e.data.path);
    }
  };
  window.addEventListener("message", messageHandler);

  return () => {
    mql.removeEventListener("change", mqlHandler);
    window.removeEventListener("message", messageHandler);
  };
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

// Fetch user avatar
$effect(() => {
  if (!auth.user) return;
  fetchMe()
    .then((me) => {
      userAvatar = me?.avatar ? `/api/auth/avatars/${me.avatar}` : null;
    })
    .catch((err) => {
      console.warn("Failed to fetch user profile:", err);
    });
});

// Re-parse selection when extensions load (handles /notes, /pages URLs and
// mind section URLs that couldn't resolve before extensions were fetched)
$effect(() => {
  if (data.extensions.length > 0) {
    const fresh = parseSelection(data.extensions);
    // Extension URLs that initially parsed as "home"
    if (fresh.kind === "extension" && selection.kind === "home") {
      selection = fresh;
    }
    // Mind section URLs that couldn't resolve ext: prefix without extensions.
    // Only upgrade if the current section matches the URL section (e.g. "notes" → "ext:notes:notes"),
    // not if the user intentionally navigated to a different section like "info".
    if (
      fresh.kind === "mind" &&
      selection.kind === "mind" &&
      fresh.section?.startsWith("ext:") &&
      selection.section &&
      !selection.section.startsWith("ext:") &&
      fresh.section.endsWith(":" + selection.section)
    ) {
      selection = fresh;
    }
  }
});

// Track whether selection change came from popstate (to avoid pushing duplicate history)
let fromPopstate = $state(false);

// URL sync: popstate → selection
$effect(() => {
  const handler = () => {
    fromPopstate = true;
    selection = parseSelection(data.extensions);
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
  const expected = selectionToPath(selection, data.extensions);
  const current = window.location.pathname + window.location.search;
  if (current !== expected) {
    // Don't rewrite unknown URLs to "/" before extensions have loaded —
    // they may resolve to an extension once the metadata arrives
    if (selection.kind === "home" && data.extensions.length === 0 && current !== "/") {
      // Skip — wait for extensions to load before deciding
    } else if (fromPopstate) {
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
  rightPanelCollapsed = true;
}

function toggleRightPanel() {
  if (narrowViewport) {
    rightPanelOpen = !rightPanelOpen;
  } else {
    rightPanelCollapsed = !rightPanelCollapsed;
  }
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

function handleSelectMindSection(name: string, section: string, defaultPath?: string) {
  selection = { tab: "system", kind: "mind", name, section: section as any, subpath: defaultPath };
}

function handleSelectSettings() {
  selection = { tab: "system", kind: "settings" };
}

function handleSelectExtension(extensionId: string, path?: string) {
  selection = { tab: "system", kind: "extension", extensionId, path: path ?? "" };
  closeSidebar();
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
  if (showUserMenu) {
    showUserMenu = false;
    return;
  }
  if (rightPanelOpen) {
    closeRightPanel();
    return;
  }
  if (layout.sidebarOpen) {
    closeSidebar();
    return;
  }
}

function handleGlobalClick(e: MouseEvent) {
  if (showUserMenu && !(e.target as HTMLElement).closest(".user-menu-anchor")) {
    showUserMenu = false;
  }
}
</script>

<svelte:window onkeydown={handleEscape} />
<svelte:document onclick={handleGlobalClick} />

{#if !auth.checked}
  <div class="app">
    <div class="loading">Loading...</div>
  </div>
{:else if !auth.setupComplete}
  <div class="app full-height">
    <SetupPage onComplete={() => { auth.setupComplete = true; }} />
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
            {selection}
            onHome={handleSystemHome}
            onSelectMind={handleSelectMind}
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
      <div class="content-area">
        <div class="main-column" class:has-right-panel={showRightPanel}>
          <div class="page-header">
            <button class="header-hamburger" onclick={toggleSidebar}>&#9776;</button>
            <div class="page-breadcrumbs">
              {#each breadcrumbs as crumb, i}
                {#if i > 0}
                  <span class="crumb-sep">/</span>
                {/if}
                {#if crumb.action && i < breadcrumbs.length - 1}
                  <button class="crumb-link" onclick={crumb.action}>{crumb.label}</button>
                {:else}
                  <span class="crumb-current">{crumb.label}</span>
                {/if}
              {/each}
            </div>
            {#if activeMindName}
              <div class="mind-section-tabs">
                {#each allMindSections as sec}
                  <button
                    class="mind-section-tab"
                    class:active={activeMindSection === sec.key}
                    onclick={() => handleSelectMindSection(activeMindName!, sec.key, sec.defaultPath)}
                  >
                    {#if sec.icon}<span class="tab-icon">{@html sec.icon}</span>{/if}
                    <span class="tab-tooltip">{sec.label}</span>
                  </button>
                {/each}
                <button
                  class="mind-section-tab mind-chat-btn"
                  onclick={() => handleNewChatCreated(activeMindName!)}
                  title="Chat"
                >
                  <span class="tab-icon"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h12v8H5l-3 3V3z"/></svg></span>
                  <span class="tab-tooltip">Chat</span>
                </button>
              </div>
            {:else if onSystemPage}
              <div class="mind-section-tabs">
                {#each data.extensions as ext}
                  {#if ext.systemSection}
                    <button
                      class="mind-section-tab"
                      class:active={activeSystemSection === `ext:${ext.id}`}
                      onclick={() => handleSelectExtension(ext.id)}
                    >
                      <span class="tab-icon">{@html ext.systemSection.icon ?? '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 2h5v5H2zM9 2h5v5H9zM2 9h5v5H2zM9 9h5v5H9z"/></svg>'}</span>
                      <span class="tab-tooltip">{ext.systemSection.label}</span>
                    </button>
                  {/if}
                {/each}
                <button
                  class="mind-section-tab"
                  class:active={activeSystemSection === "shared-files"}
                  onclick={() => { selection = { tab: "system", kind: "shared-files" }; }}
                >
                  <span class="tab-icon"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4h5l2-2h5v11H2V4z"/></svg></span>
                  <span class="tab-tooltip">Shared Files</span>
                </button>
                <button
                  class="mind-section-tab"
                  class:active={activeSystemSection === "settings"}
                  onclick={handleSelectSettings}
                >
                  <span class="tab-icon"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="2"/><path d="M8 1v2M8 13v2M1 8h2M13 8h2M3.05 3.05l1.41 1.41M11.54 11.54l1.41 1.41M3.05 12.95l1.41-1.41M11.54 4.46l1.41-1.41"/></svg></span>
                  <span class="tab-tooltip">Settings</span>
                </button>
              </div>
            {/if}
            <div class="header-actions">
              <div class="user-menu-anchor">
                <button class="user-avatar-btn" onclick={() => { showUserMenu = !showUserMenu; }} title={auth.user?.username}>
                  {#if userAvatar}
                    <img src={userAvatar} alt="" class="user-avatar-img" />
                  {:else}
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21v-1a6 6 0 0 1 12 0v1"/></svg>
                  {/if}
                </button>
                {#if showUserMenu}
                  <!-- svelte-ignore a11y_no_static_element_interactions -->
                  <div class="user-dropdown">
                    <button class="user-dropdown-item" onclick={() => { showUserMenu = false; activeModal = "userSettings"; }}>Profile</button>
                    <button class="user-dropdown-item" onclick={() => { showUserMenu = false; handleLogout(); }}>Logout</button>
                  </div>
                {/if}
              </div>
              {#if hasRightPanel && rightPanelCollapsed}
                <button class="panel-reopen" onclick={toggleRightPanel} title="Show sidebar">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="15" y1="3" x2="15" y2="21"/></svg>
                </button>
              {/if}
            </div>
          </div>
          <div class="main-frame">
            <MainFrame
              {selection}
              minds={data.minds}
              conversations={data.conversations}
              username={auth.user.username}
              onConversationId={handleConversationId}
              onSelectConversation={handleSelectConversation}
              onOpenMind={handleOpenMindModal}
              onTypingNames={(names) => { typingNames = names; }}
              onToggleSidebar={toggleSidebar}
              onOpenRightPanel={hasRightPanel ? openRightPanel : undefined}
            />
          </div>
        </div>
        {#if showRightPanel}
          {#if narrowViewport && rightPanelOpen}
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
          <div class="right-panel" class:right-panel-open={narrowViewport && rightPanelOpen} style:width="{rightPanel.width}px">
            <button class="panel-close" onclick={closeRightPanel} title="Close">&times;</button>
            {#if rightPanelMind}
              {#key rightPanelMind.name}
                <MindRightPanel
                  mind={rightPanelMind}
                  onProfile={showRightPanelProfile ? () => {
                    selection = { tab: "system", kind: "mind", name: rightPanelMind.name };
                    if (activeModal === "mind") { activeModal = null; selectedModalMind = null; }
                  } : undefined}
                  onChat={showRightPanelChat ? () => handleNewChatCreated(rightPanelMind.name) : undefined}
                />
              {/key}
            {:else if activeConv?.type === "channel"}
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
    </div>
  </div>

  {#if activeModal === "channelBrowser"}
    <ChannelBrowserModal
      onClose={() => (activeModal = null)}
      onJoined={handleChannelJoined}
    />
  {/if}
  {#if activeModal === "seed"}
    <SeedModal onClose={() => (activeModal = null)} onCreated={handleSeedCreated} />
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

  .content-area {
    flex: 1;
    display: flex;
    overflow: hidden;
    min-width: 0;
  }

  .main-column {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    min-width: 0;
    padding: 0 8px 8px 3px;
  }

  .main-column.has-right-panel {
    padding-right: 3px;
  }

  .main-frame {
    flex: 1;
    overflow: hidden;
    min-width: 0;
    background: var(--bg-1);
    border-radius: var(--radius-lg);
    border: 1px solid var(--border);
  }

  .page-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 16px;
    flex-shrink: 0;
  }

  .header-hamburger {
    display: none;
    align-items: center;
    justify-content: center;
    background: none;
    border: none;
    color: var(--text-1);
    font-size: 18px;
    padding: 4px 8px;
    border-radius: var(--radius);
    cursor: pointer;
    flex-shrink: 0;
  }

  .header-hamburger:hover {
    background: var(--bg-2);
  }

  .page-breadcrumbs {
    display: flex;
    align-items: baseline;
    gap: 8px;
    font-family: var(--display);
    font-size: 18px;
    font-weight: 300;
    color: var(--text-0);
    letter-spacing: 0.02em;
    min-width: 0;
    overflow: hidden;
  }

  .crumb-sep {
    color: var(--text-2);
    font-size: 14px;
  }

  .crumb-link {
    background: none;
    border: none;
    padding: 0;
    font: inherit;
    color: var(--text-2);
    cursor: pointer;
  }

  .crumb-link:hover {
    color: var(--text-0);
  }

  .crumb-current {
    color: var(--text-0);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .mind-section-tabs {
    display: flex;
    align-items: center;
    gap: 2px;
  }

  .mind-section-tab {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    background: none;
    border: none;
    padding: 5px 7px;
    color: var(--text-2);
    cursor: pointer;
    border-radius: var(--radius);
    transition: color 0.15s, background 0.15s;
  }

  .mind-section-tab:hover {
    color: var(--text-1);
    background: var(--bg-2);
  }

  .mind-section-tab.active {
    color: var(--text-0);
    background: var(--bg-2);
  }

  .tab-icon {
    width: 16px;
    height: 16px;
  }

  .tab-icon :global(svg) {
    width: 16px;
    height: 16px;
  }

  .tab-tooltip {
    position: absolute;
    top: 100%;
    left: 50%;
    transform: translateX(-50%);
    margin-top: 6px;
    padding: 4px 10px;
    background: var(--bg-3);
    color: var(--text-0);
    font-family: var(--sans);
    font-size: 12px;
    border-radius: var(--radius);
    white-space: nowrap;
    pointer-events: none;
    opacity: 0;
    transition: opacity 0.15s;
    border: 1px solid var(--border);
    z-index: 10;
  }

  .mind-section-tab:hover .tab-tooltip {
    opacity: 1;
  }

  .header-actions {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .user-menu-anchor {
    position: relative;
  }

  .user-avatar-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    border-radius: 50%;
    background: none;
    border: 1px solid var(--border);
    padding: 0;
    cursor: pointer;
    overflow: hidden;
    color: var(--text-2);
  }

  .user-avatar-btn:hover {
    border-color: var(--border-bright);
    color: var(--text-1);
  }

  .user-avatar-img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .user-avatar-btn svg {
    width: 14px;
    height: 14px;
  }

  .user-dropdown {
    position: absolute;
    top: calc(100% + 4px);
    right: 0;
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    min-width: 120px;
    padding: 4px 0;
    z-index: 100;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
  }

  .user-dropdown-item {
    display: block;
    width: 100%;
    text-align: left;
    padding: 6px 12px;
    background: none;
    color: var(--text-1);
    font-size: 13px;
    white-space: nowrap;
    border: none;
    cursor: pointer;
  }

  .user-dropdown-item:hover {
    background: var(--bg-3);
    color: var(--text-0);
  }

  .panel-reopen {
    background: none;
    border: none;
    color: var(--text-2);
    padding: 4px;
    cursor: pointer;
    border-radius: var(--radius);
    display: flex;
    align-items: center;
  }

  .panel-reopen:hover {
    color: var(--text-1);
    background: var(--bg-2);
  }

  .panel-reopen svg {
    width: 16px;
    height: 16px;
  }

  .right-panel {
    flex-shrink: 0;
    border-left: 1px solid var(--border);
    overflow: hidden;
    position: relative;
  }

  .panel-close {
    position: absolute;
    top: 8px;
    right: 8px;
    z-index: 1;
    background: none;
    border: none;
    color: var(--text-2);
    font-size: 18px;
    padding: 4px 8px;
    cursor: pointer;
    border-radius: var(--radius);
  }

  .panel-close:hover {
    color: var(--text-0);
    background: var(--bg-2);
  }

  .right-panel-backdrop {
    display: none;
  }

  .sidebar-backdrop {
    display: none;
  }

  /* Right panel: overlay on narrow viewports */
  @media (max-width: 1024px) {
    .right-panel {
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

    .main-column {
      padding-left: 8px;
    }
  }

  @media (max-width: 767px) {
    .sidebar-header {
      display: none;
    }

    .header-hamburger {
      display: flex;
    }

    .page-breadcrumbs {
      font-size: 15px;
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

    .main-column {
      padding-left: 8px;
    }
  }

  /* Electron: titlebar safe area and window drag */
  :global(html.electron) .sidebar-header {
    padding-left: var(--traffic-light-width, 0px);
    justify-content: flex-start;
    min-height: var(--titlebar-height, 38px);
    padding-top: 0;
    padding-bottom: 0;
    gap: 4px;
    -webkit-app-region: drag;
    cursor: default;
  }

  :global(html.electron) .sidebar-header .sidebar-logo {
    width: 16px;
    height: 16px;
  }

  :global(html.electron) .sidebar-header .header-logo-wrap {
    width: 16px;
    height: 16px;
  }

  :global(html.electron) .sidebar-header .hover-dot {
    width: 6px;
    height: 6px;
  }

  :global(html.electron) .sidebar-header .sidebar-title {
    font-size: 15px;
    margin-top: -1px;
    margin-left: 0;
  }

  :global(html.electron) .page-header {
    -webkit-app-region: drag;
  }

  :global(html.electron) .page-header button,
  :global(html.electron) .page-header a,
  :global(html.electron) .page-header .user-menu-anchor {
    -webkit-app-region: no-drag;
  }
</style>
