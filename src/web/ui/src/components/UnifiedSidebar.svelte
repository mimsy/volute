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
</script>

<div class="sidebar-inner">
  <div class="sections">
    <!-- System -->
    <div class="section">
      <div class="section-header-row">
        <button
          class="section-toggle"
          class:active={selection.kind === "home" || selection.kind === "settings" || selection.kind === "extension" || selection.kind === "shared-files"}
          onclick={onHome}
        >
          <span class="toggle-icon"></span>
          <span>System</span>
        </button>
      </div>
    </div>

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
        <div class="mind-list">
          {#each sortedMinds as mind}
            {@const dmId = mindDmMap.get(mind.name)}
            {@const mindUnread = dmId ? (unreadCounts.get(dmId) ?? 0) : 0}
            <button
              class="mind-item"
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
                  <span class="mind-item-name">{mind.displayName ?? mind.name}</span>
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
    padding-top: 4px;
  }

  .section {
    margin-bottom: 2px;
  }

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
    font-family: var(--display);
    font-size: 16px;
    font-weight: 300;
    letter-spacing: 0.02em;
    text-align: left;
    border-radius: var(--radius);
    margin: 0 4px;
  }

  .section-toggle:hover {
    color: var(--text-1);
  }

  .section-toggle.active {
    color: var(--text-0);
    background: var(--bg-2);
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

  .mind-list {
    display: flex;
    flex-direction: column;
  }

  .mind-item {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 6px 12px 6px 26px;
    font-size: 14px;
    color: var(--text-1);
    transition: background 0.1s;
    cursor: pointer;
    background: none;
    text-align: left;
    margin: 0 4px;
    border-radius: var(--radius);
  }

  .mind-item:hover {
    background: var(--bg-2);
  }

  .mind-item.active {
    background: var(--bg-2);
    color: var(--text-0);
  }

  .mind-item-name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 500;
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
    .mind-item {
      padding: 10px 12px 10px 26px;
      font-size: 14px;
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
