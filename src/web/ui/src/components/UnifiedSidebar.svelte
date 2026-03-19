<script lang="ts">
import type { ConversationWithParticipants, Mind } from "@volute/api";
import { mindDotColor } from "../lib/format";
import type { Selection } from "../lib/navigate";
import { activeMinds, unreadCounts } from "../lib/stores.svelte";
import ConversationList from "./ConversationList.svelte";
import Icon from "./Icon.svelte";
import ProfileHoverCard from "./ProfileHoverCard.svelte";

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
}: {
  minds: Mind[];
  conversations: ConversationWithParticipants[];
  selection: Selection;
  username: string;
  onHome: () => void;
  onSelectMind: (name: string) => void;
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

let channelConversations = $derived(conversations.filter((c) => c.type === "channel"));

let activeChannelId = $derived.by(() => {
  if (selection.kind !== "channel") return null;
  const conv = conversations.find((c) => c.type === "channel" && c.name === selection.slug);
  return conv?.id ?? null;
});

let isSystemActive = $derived(
  selection.kind === "home" ||
    selection.kind === "settings" ||
    selection.kind === "extension" ||
    selection.kind === "shared-files",
);
</script>

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
    padding-right: 8px;
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
  }

  .section-action svg {
    width: 14px;
    height: 14px;
  }

  .section-header-row:hover .section-action {
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
    transition: background 0.1s;
    cursor: pointer;
    background: none;
    text-align: left;
  }

  .nav-item:hover {
    background: var(--bg-2);
  }

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

    .status-dot {
      width: 8px;
      height: 8px;
    }
  }
</style>
