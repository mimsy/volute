<script lang="ts">
import type { ConversationWithParticipants, Mind } from "@volute/api";
import { mindDotColor } from "../lib/format";
import type { Selection } from "../lib/navigate";
import { activeMinds, unreadCounts } from "../lib/stores.svelte";
import ConversationList from "./ConversationList.svelte";
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

// Map mind names to their DM conversation IDs for unread tracking
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
    <button
      class="system-item"
      class:active={isSystemActive}
      onclick={onHome}
    >
      System
    </button>

    <!-- Minds -->
    <div class="section">
      <div class="section-header-row">
        <button class="section-toggle" onclick={() => toggleSection("minds")}>
          <span class="toggle-icon">{collapsed.has("minds") ? "\u25B8" : "\u25BE"}</span>
          <span>Minds</span>
        </button>
        <button class="section-add" onclick={onSeed} title="Plant a seed">+</button>
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
          <span class="toggle-icon">{collapsed.has("channels") ? "\u25B8" : "\u25BE"}</span>
          <span>Channels</span>
        </button>
        <button class="section-add" onclick={onBrowseChannels} title="Browse channels">+</button>
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

  /* System — top-level category button */
  .system-item {
    display: block;
    width: 100%;
    padding: 10px 16px;
    background: none;
    color: var(--text-2);
    font-size: 14px;
    font-weight: 500;
    text-align: left;
    cursor: pointer;
    border-bottom: 1px solid var(--border);
    transition: color 0.1s, background 0.1s;
  }

  .system-item:hover {
    color: var(--text-1);
    background: var(--bg-2);
  }

  .system-item.active {
    color: var(--text-0);
    background: var(--bg-2);
  }

  /* Section headers — collapsible group labels */
  .section-header-row {
    display: flex;
    align-items: center;
    padding-right: 8px;
  }

  .section-toggle {
    display: flex;
    align-items: center;
    gap: 4px;
    flex: 1;
    padding: 6px 12px;
    background: none;
    color: var(--text-2);
    font-size: 12px;
    font-weight: 500;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    text-align: left;
  }

  .section-toggle:hover {
    color: var(--text-1);
  }

  .toggle-icon {
    font-size: 9px;
    width: 10px;
  }

  .section-add {
    background: none;
    color: var(--text-2);
    font-size: 15px;
    padding: 2px 6px;
    border-radius: var(--radius);
    flex-shrink: 0;
  }

  .section-add:hover {
    color: var(--text-0);
    background: var(--bg-2);
  }

  /* Nav items — shared style for minds and channels */
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
    margin: 0 4px;
    border-radius: var(--radius);
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

    .system-item {
      padding: 12px 16px;
    }

    .section-toggle {
      padding: 8px 12px;
    }

    .status-dot {
      width: 8px;
      height: 8px;
    }
  }
</style>
