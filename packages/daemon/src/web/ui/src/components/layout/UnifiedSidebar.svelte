<script lang="ts">
import type { ConversationWithParticipants, Mind } from "@volute/api";
import { Icon, Modal, tooltip as tooltipAction } from "@volute/ui";
import { fetchMinds, startMind, stopMind } from "../../lib/client";
import { mindDotColor } from "../../lib/format";
import type { Selection } from "../../lib/navigate";
import {
  cancelReauth,
  oauthReauth,
  resetReauth,
  startReauth,
  submitCode,
} from "../../lib/oauth-reauth.svelte";
import { activeMinds, data, unreadCounts } from "../../lib/stores.svelte";
import ProfileHoverCard from "../ProfileHoverCard.svelte";
import ConversationList from "./ConversationList.svelte";

let hasOauthErrors = $derived(data.oauthErrors.length > 0);
let showReauthModal = $state(false);

function handleOauthWarningClick(e: MouseEvent) {
  e.stopPropagation();
  if (data.oauthErrors.length === 1) {
    // Single provider — start re-auth directly
    const p = data.oauthErrors[0];
    startReauth(p.id, p.oauthName ?? p.id);
  } else {
    showReauthModal = true;
  }
}

function handleReauthProvider(id: string, name?: string) {
  showReauthModal = false;
  startReauth(id, name ?? id);
}

function handleReauthDone() {
  resetReauth();
  showReauthModal = false;
}

let {
  minds,
  conversations,
  selection,
  username,
  onHome,
  onSelectMind,
  onSelectConversation,
  onDeleteConversation,
  onBrowseChannels,
  onOpenMind,
  onSeed,
  onHideConversation,
  onSelectMindSection,
  onSelectSystemSection,
}: {
  minds: Mind[];
  conversations: ConversationWithParticipants[];
  selection: Selection;
  username: string;
  onHome: () => void;
  onSelectMind: (name: string) => void;
  onSelectMindSection: (name: string, section: string) => void;
  onSelectSystemSection: (section: string) => void;
  onSelectConversation: (id: string) => void;
  onDeleteConversation: (id: string) => void;
  onBrowseChannels: () => void;
  onOpenMind: (mind: Mind) => void;
  onSeed: () => void;
  onHideConversation?: (id: string) => void;
} = $props();

type Section = "minds" | "channels";

function loadCollapsed(): Set<Section> {
  try {
    const stored = localStorage.getItem("volute:sidebar-collapsed");
    return stored ? new Set(JSON.parse(stored)) : new Set();
  } catch {
    return new Set();
  }
}

let collapsed = $state(loadCollapsed());

function toggleSection(section: Section) {
  if (collapsed.has(section)) {
    collapsed.delete(section);
  } else {
    collapsed.add(section);
  }
  collapsed = new Set(collapsed);
  localStorage.setItem("volute:sidebar-collapsed", JSON.stringify([...collapsed]));
}

let mindNames = $derived(new Set(minds.map((m) => m.name)));

let mindDmMap = $derived(
  new Map(
    conversations
      .filter((c) => {
        if (c.type === "channel") return false;
        const parts = c.participants ?? [];
        if (parts.length !== 2) return false;
        const other = parts.find((p) => p.username !== username);
        return other ? mindNames.has(other.username) : false;
      })
      .map((c) => {
        const other = c.participants!.find((p) => p.username !== username)!;
        return [other.username, c.id] as const;
      }),
  ),
);

let sortedMinds = $derived(
  [...minds].sort((a, b) => {
    const aActive = activeMinds.has(a.name) ? 0 : a.status === "running" ? 1 : 2;
    const bActive = activeMinds.has(b.name) ? 0 : b.status === "running" ? 1 : 2;
    if (aActive !== bActive) return aActive - bActive;
    return a.name.localeCompare(b.name);
  }),
);

let openMenu = $state<string | null>(null);
let menuPos = $state({ top: 0, left: 0 });

function handleDotsClick(e: MouseEvent, key: string = "__system__") {
  e.stopPropagation();
  if (openMenu === key) {
    openMenu = null;
  } else {
    const btn = e.currentTarget as HTMLElement;
    const rect = btn.getBoundingClientRect();
    menuPos = { top: rect.bottom + 2, left: rect.left };
    openMenu = key;
  }
}

function handleMenuAction(name: string, section: string) {
  openMenu = null;
  if (name === "__system__") {
    onSelectSystemSection(section);
  } else {
    onSelectMindSection(name, section);
  }
}

function handleClickOutside(e: MouseEvent) {
  if (openMenu && !(e.target as HTMLElement).closest(".menu-container")) {
    openMenu = null;
  }
}

function handleWindowBlur() {
  if (openMenu) openMenu = null;
}

let menuMind = $derived(openMenu ? minds.find((m) => m.name === openMenu) : null);

async function handleMindStart() {
  if (!openMenu) return;
  const name = openMenu;
  openMenu = null;
  await startMind(name);
  data.minds = await fetchMinds();
}

async function handleMindStop() {
  if (!openMenu) return;
  const name = openMenu;
  openMenu = null;
  await stopMind(name);
  data.minds = await fetchMinds();
}

async function handleMindRestart() {
  if (!openMenu) return;
  const name = openMenu;
  openMenu = null;
  await stopMind(name);
  await startMind(name);
  data.minds = await fetchMinds();
}

let channelConversations = $derived(conversations.filter((c) => c.type === "channel"));

let activeChannelId = $derived.by(() => {
  if (selection.kind !== "channel") return null;
  const conv = conversations.find((c) => c.type === "channel" && c.name === selection.slug);
  return conv?.id ?? null;
});

let isSystemActive = $derived(
  selection.kind === "system-history" ||
    selection.kind === "system-chat" ||
    selection.kind === "extension",
);
</script>

<svelte:window onclick={handleClickOutside} onblur={handleWindowBlur} />

<div class="sidebar-inner">
  <div class="sections">
    <!-- System -->
    <div class="section">
      <div class="section-header-row" class:active={isSystemActive}>
        <button
          class="section-toggle"
          class:active={isSystemActive}
          onclick={onHome}
        >
          <Icon kind="spiral" class="section-icon" />
          <span>System</span>
        </button>
        <div class="menu-container">
          <button
            class="mind-dots-btn"
            class:visible={openMenu === "__system__"}
            onclick={(e) => handleDotsClick(e)}
            title="More options"
          >
            <svg viewBox="0 0 16 16" fill="currentColor"><circle cx="8" cy="3" r="1.5"/><circle cx="8" cy="8" r="1.5"/><circle cx="8" cy="13" r="1.5"/></svg>
          </button>
        </div>
        {#if hasOauthErrors}
          <button
            class="oauth-warning-btn"
            use:tooltipAction={{ text: "AI provider credentials expired — click to re-authenticate", position: "right" }}
            onclick={handleOauthWarningClick}
          >!</button>
        {/if}
      </div>
    </div>

    <!-- Minds -->
    <div class="section">
      <div class="section-header-row">
        <button class="section-toggle" onclick={() => toggleSection("minds")}>
          <Icon kind="mind" class="section-icon" />
          <span>Minds</span>
        </button>
        <button class="section-action" onclick={(e) => { e.stopPropagation(); onSeed(); }} title="Plant a seed">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M8 3v10M3 8h10"/></svg>
        </button>
      </div>
      {#if !collapsed.has("minds")}
        <div class="item-list">
          {#each sortedMinds as mind}
            {@const dmId = mindDmMap.get(mind.name)}
            {@const mindUnread = dmId ? (unreadCounts.get(dmId) ?? 0) : 0}
            <div class="mind-item-row">
              <button
                class="nav-item"
                class:active={selection.kind === "mind" && selection.name === mind.name}
                onclick={() => onSelectMind(mind.name)}
              >
                <ProfileHoverCard profile={{
                  name: mind.name,
                  displayName: mind.displayName,
                  description: mind.description,
                  avatarUrl: mind.avatar ? `/api/minds/${encodeURIComponent(mind.name)}/avatar` : null,
                  userType: "mind",
                  created: mind.created,
                }}>
                  {#snippet children()}
                    <span
                      class="status-dot"
                      class:iridescent={activeMinds.has(mind.name)}
                      style:background={activeMinds.has(mind.name) ? undefined : mindDotColor(mind)}
                    ></span>
                    <span class="nav-label">{mind.displayName ?? mind.name}</span>
                    {#if mindUnread > 0}
                      <span class="unread-dot"></span>
                    {/if}
                  {/snippet}
                </ProfileHoverCard>
              </button>
              <div class="menu-container">
                <button
                  class="mind-dots-btn"
                  class:visible={openMenu === mind.name}
                  onclick={(e) => handleDotsClick(e, mind.name)}
                  title="More options"
                >
                  <svg viewBox="0 0 16 16" fill="currentColor"><circle cx="8" cy="3" r="1.5"/><circle cx="8" cy="8" r="1.5"/><circle cx="8" cy="13" r="1.5"/></svg>
                </button>
              </div>
            </div>
          {/each}
        </div>
      {/if}
    </div>

    <!-- Channels -->
    <div class="section">
      <div class="section-header-row">
        <button class="section-toggle" onclick={() => toggleSection("channels")}>
          <svg class="section-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6.5 3L5.5 13M10.5 3l-1 10M3 6h10M3 10h10"/></svg>
          <span>Channels</span>
        </button>
        <button class="section-action" onclick={(e) => { e.stopPropagation(); onBrowseChannels(); }} title="Browse channels">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M8 3v10M3 8h10"/></svg>
        </button>
      </div>
      {#if !collapsed.has("channels")}
        <ConversationList
          conversations={channelConversations}
          {minds}
          activeId={activeChannelId}
          {username}
          mode="channels"
          onSelect={onSelectConversation}
          onDelete={onDeleteConversation}
          {onOpenMind}
        />
      {/if}
    </div>
  </div>
</div>

{#if openMenu === "__system__"}
  <div
    class="mind-menu"
    role="menu"
    tabindex="-1"
    style:top="{menuPos.top}px"
    style:left="{menuPos.left}px"
    onclick={(e) => e.stopPropagation()}
    onkeydown={(e) => { if (e.key === "Escape") openMenu = null; }}
  >
    <button class="mind-menu-item" onclick={() => handleMenuAction("__system__", "settings")}>
      <Icon kind="gear" class="menu-icon" />
      Settings
    </button>
    <button class="mind-menu-item" onclick={() => handleMenuAction("__system__", "logs")}>
      <Icon kind="document-lines" class="menu-icon" />
      Logs
    </button>
  </div>
{:else if openMenu}
  <div
    class="mind-menu"
    role="menu"
    tabindex="-1"
    style:top="{menuPos.top}px"
    style:left="{menuPos.left}px"
    onclick={(e) => e.stopPropagation()}
    onkeydown={(e) => { if (e.key === "Escape") openMenu = null; }}
  >
    <button class="mind-menu-item" onclick={() => handleMenuAction(openMenu!, "files")}>
      <Icon kind="folder" class="menu-icon" />
      Files
    </button>
    <button class="mind-menu-item" onclick={() => handleMenuAction(openMenu!, "settings")}>
      <Icon kind="gear" class="menu-icon" />
      Settings
    </button>
    {#if menuMind?.status === "running"}
      <button class="mind-menu-item" onclick={() => handleMenuAction(openMenu!, "context")}>
        <Icon kind="document-lines" class="menu-icon" />
        Context
      </button>
    {/if}
    <div class="mind-menu-divider"></div>
    {#if menuMind?.status === "stopped"}
      <button class="mind-menu-item" onclick={handleMindStart}>
        <Icon kind="play" class="menu-icon" />
        Start
      </button>
    {:else}
      <button class="mind-menu-item" onclick={handleMindRestart}>
        <Icon kind="restart" class="menu-icon" />
        Restart
      </button>
      <button class="mind-menu-item danger" onclick={handleMindStop}>
        <Icon kind="stop" class="menu-icon" />
        Stop
      </button>
    {/if}
  </div>
{/if}

<!-- OAuth re-auth: provider picker (multiple unhealthy providers) -->
{#if showReauthModal}
  <Modal onClose={() => { showReauthModal = false; }} size="360px" title="Re-authenticate">
    <div class="reauth-body">
      <p class="reauth-desc">The following providers need re-authentication:</p>
      {#each data.oauthErrors as provider}
        <button class="reauth-provider-btn" onclick={() => handleReauthProvider(provider.id, provider.oauthName)}>
          <span class="reauth-provider-name">{provider.oauthName ?? provider.id}</span>
          {#if provider.oauthError}
            <span class="reauth-provider-error">{provider.oauthError}</span>
          {/if}
        </button>
      {/each}
    </div>
  </Modal>
{/if}

<!-- OAuth re-auth: in-progress -->
{#if oauthReauth.active}
  <Modal onClose={() => { if (!oauthReauth.polling) handleReauthDone(); }} size="400px" title="Re-authenticate {oauthReauth.providerName}">
    <div class="reauth-body">
      {#if oauthReauth.success}
        <p class="reauth-msg reauth-msg-success">Credentials refreshed successfully.</p>
        <button class="reauth-btn reauth-btn-primary" onclick={handleReauthDone}>Done</button>
      {:else if oauthReauth.error && !oauthReauth.polling}
        <p class="reauth-msg reauth-msg-error">{oauthReauth.error}</p>
        <button class="reauth-btn" onclick={handleReauthDone}>Close</button>
      {:else}
        <p class="reauth-msg">Complete sign-in in the browser window that opened.</p>
        {#if oauthReauth.needsCode || oauthReauth.waitingForCode}
          <p class="reauth-desc">If the browser is on another machine, paste the redirect URL here:</p>
          <input
            type="text"
            class="reauth-input"
            bind:value={oauthReauth.codeInput}
            placeholder="Paste redirect URL"
            onpaste={() => {
              setTimeout(() => {
                if (/^https?:\/\//.test(oauthReauth.codeInput.trim())) submitCode();
              });
            }}
          />
        {/if}
        <span class="reauth-dim">Waiting for authorization...</span>
        <button class="reauth-btn" onclick={() => { cancelReauth(); }}>Cancel</button>
      {/if}
    </div>
  </Modal>
{/if}

<style>
  .sidebar-inner {
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow: hidden;
  }

  .sections {
    flex: 1;
    overflow-y: auto;
    overflow-x: hidden;
  }

  .section {
    margin-bottom: 2px;
  }

  /* Section headers */
  .section-header-row {
    display: flex;
    align-items: center;
    transition: background 0.1s;
  }

  .section-header-row:hover {
    background: var(--bg-2);
  }

  .section-header-row.active {
    background: var(--bg-2);
  }

  .section-toggle {
    display: flex;
    align-items: center;
    gap: 6px;
    flex: 1;
    padding: 6px 12px;
    background: none;
    color: var(--text-2);
    font-size: 12px;
    font-weight: 500;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    text-align: left;
    transition: color 0.1s;
  }

  .section-header-row:hover .section-toggle {
    color: var(--text-1);
  }

  .section-toggle.active {
    color: var(--text-0);
  }

  .section-toggle :global(.section-icon) {
    width: 14px;
    height: 14px;
    flex-shrink: 0;
    opacity: 0.6;
  }

  .section-toggle.active :global(.section-icon) {
    opacity: 1;
  }

  .section-action {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    background: none;
    color: var(--text-2);
    flex-shrink: 0;
    opacity: 0;
    transition: opacity 0.1s, color 0.1s;
    cursor: pointer;
    margin-right: 8px;
  }

  .section-action svg {
    width: 14px;
    height: 14px;
  }

  .section-header-row:hover .section-action,
  .section-header-row:hover .mind-dots-btn {
    opacity: 1;
  }

  .section-action:hover {
    color: var(--text-0);
  }

  /* Nav items */
  .nav-item {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 6px 12px 6px 24px;
    font-size: 14px;
    font-weight: 500;
    color: var(--text-1);
    cursor: pointer;
    background: none;
    text-align: left;
  }

  .mind-item-row:hover,
  .nav-item:hover {
    background: var(--bg-2);
  }

  .mind-item-row:has(.nav-item.active),
  .nav-item.active {
    background: var(--bg-2);
    color: var(--text-0);
  }

  .nav-label {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .item-list {
    display: flex;
    flex-direction: column;
  }

  .unread-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--accent);
    flex-shrink: 0;
  }

  .mind-item-row {
    display: flex;
    align-items: center;
    position: relative;
  }

  .mind-item-row .nav-item {
    flex: 1;
    min-width: 0;
  }

  .menu-container {
    position: relative;
    flex-shrink: 0;
  }

  .mind-dots-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    background: none;
    color: var(--text-2);
    opacity: 0;
    transition: opacity 0.1s, color 0.1s;
    cursor: pointer;
    margin-right: 8px;
  }

  .mind-dots-btn svg {
    width: 12px;
    height: 12px;
  }

  .mind-item-row:hover .mind-dots-btn,
  .mind-dots-btn.visible {
    opacity: 1;
  }

  .mind-dots-btn:hover {
    color: var(--text-0);
  }

  .mind-menu {
    position: fixed;
    z-index: 300;
    background: var(--bg-1);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 4px;
    min-width: 120px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
  }

  .mind-menu-item {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 6px 10px;
    background: none;
    color: var(--text-1);
    font-size: 13px;
    border-radius: 4px;
    cursor: pointer;
    white-space: nowrap;
    text-align: left;
  }

  .mind-menu-item:hover {
    background: var(--bg-2);
    color: var(--text-0);
  }

  .mind-menu-item.danger:hover {
    color: var(--red);
  }

  .mind-menu-divider {
    height: 1px;
    background: var(--border);
    margin: 4px 0;
  }

  .mind-menu-item :global(.menu-icon) {
    width: 14px;
    height: 14px;
    flex-shrink: 0;
  }

  .status-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .status-dot.iridescent {
    animation: iridescent 3s ease-in-out infinite;
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

  @media (max-width: 767px) {
    .nav-item {
      padding: 10px 12px 10px 24px;
    }

    .section-toggle {
      padding: 8px 12px;
    }

    .section-action {
      opacity: 1;
    }

    .mind-dots-btn {
      opacity: 1;
    }

    .status-dot {
      width: 8px;
      height: 8px;
    }
  }

  /* OAuth warning */
  .oauth-warning-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    background: none;
    color: var(--yellow);
    flex-shrink: 0;
    cursor: pointer;
    margin-right: 8px;
    font-size: 13px;
    font-weight: 700;
    line-height: 1;
    animation: pulse-warning 2s ease-in-out infinite;
  }

  .oauth-warning-btn:hover {
    color: var(--yellow-bright, var(--yellow));
  }

  @keyframes pulse-warning {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.5; }
  }

  /* Re-auth modals */
  .reauth-body {
    padding: 16px 20px 20px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .reauth-desc {
    font-size: 13px;
    color: var(--text-2);
    margin: 0;
  }

  .reauth-msg {
    font-size: 14px;
    color: var(--text-1);
    margin: 0;
  }

  .reauth-msg-success { color: var(--green, var(--text-0)); }
  .reauth-msg-error { color: var(--red, var(--text-0)); }

  .reauth-dim {
    font-size: 13px;
    color: var(--text-2);
  }

  .reauth-provider-btn {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 10px 12px;
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    cursor: pointer;
    text-align: left;
    transition: border-color 0.15s;
  }

  .reauth-provider-btn:hover {
    border-color: var(--border-bright);
  }

  .reauth-provider-name {
    font-size: 14px;
    color: var(--text-0);
    font-weight: 500;
  }

  .reauth-provider-error {
    font-size: 12px;
    color: var(--text-2);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .reauth-btn {
    padding: 6px 16px;
    border-radius: var(--radius);
    font-size: 13px;
    cursor: pointer;
    align-self: flex-end;
    background: var(--bg-2);
    color: var(--text-1);
    border: 1px solid var(--border);
  }

  .reauth-btn:hover {
    border-color: var(--border-bright);
  }

  .reauth-btn-primary {
    background: var(--accent);
    color: var(--bg-0);
    border-color: var(--accent);
  }

  .reauth-input {
    width: 100%;
    padding: 8px 10px;
    background: var(--bg-1);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    color: var(--text-0);
    font-size: 13px;
    box-sizing: border-box;
  }
</style>
