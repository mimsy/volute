<script lang="ts">
import type { ConversationWithParticipants, Mind, Site } from "../lib/api";
import ConversationList from "./ConversationList.svelte";

let {
  minds,
  conversations,
  sites,
  activeConversationId,
  username,
  onSelectConversation,
  onDeleteConversation,
  onNewChat,
  onBrowseChannels,
  onOpenMind,
  onSelectSite,
  onSelectPages,
  onHideConversation,
  onHome,
}: {
  minds: Mind[];
  conversations: ConversationWithParticipants[];
  sites: Site[];
  activeConversationId: string | null;
  username: string;
  onSelectConversation: (id: string) => void;
  onDeleteConversation: (id: string) => void;
  onNewChat: () => void;
  onBrowseChannels: () => void;
  onOpenMind: (mind: Mind) => void;
  onSelectSite: (name: string) => void;
  onSelectPages: () => void;
  onHideConversation?: (id: string) => void;
  onHome: () => void;
} = $props();

type Section = "minds" | "groups" | "channels" | "pages";

function loadCollapsed(): Set<Section> {
  try {
    const stored = localStorage.getItem("volute:sidebar-collapsed");
    return stored ? new Set(JSON.parse(stored)) : new Set();
  } catch {
    return new Set();
  }
}

let collapsed = $state(loadCollapsed());

let mindNames = $derived(new Set(minds.map((m) => m.name)));

let mindConversations = $derived(
  conversations.filter((c) => {
    if (c.type === "channel") return false;
    const parts = c.participants ?? [];
    if (parts.length !== 2) return false;
    const other = parts.find((p) => p.username !== username);
    return other ? mindNames.has(other.username) : false;
  }),
);

let groupConversations = $derived(
  conversations.filter((c) => {
    if (c.type === "channel") return false;
    const parts = c.participants ?? [];
    if (parts.length !== 2) return true;
    const other = parts.find((p) => p.username !== username);
    return other ? !mindNames.has(other.username) : true;
  }),
);

let channelConversations = $derived(conversations.filter((c) => c.type === "channel"));

function toggleSection(section: Section) {
  if (collapsed.has(section)) {
    collapsed.delete(section);
  } else {
    collapsed.add(section);
  }
  collapsed = new Set(collapsed);
  localStorage.setItem("volute:sidebar-collapsed", JSON.stringify([...collapsed]));
}
</script>

<div class="sidebar-inner">
  <button class="sidebar-header" onclick={onHome}>Volute</button>
  <div class="sections">
    <!-- Minds (1-on-1 DMs with minds) -->
    <div class="section">
      <div class="section-header-row">
        <button class="section-toggle" onclick={() => toggleSection("minds")}>
          <span class="toggle-icon">{collapsed.has("minds") ? "\u25B8" : "\u25BE"}</span>
          <span>Minds</span>
        </button>
        <button class="section-add" onclick={onNewChat} title="New chat">+</button>
      </div>
      {#if !collapsed.has("minds")}
        <ConversationList
          conversations={mindConversations}
          {minds}
          activeId={activeConversationId}
          {username}
          mode="dms"
          onSelect={onSelectConversation}
          onDelete={onDeleteConversation}
          {onOpenMind}
          onHide={onHideConversation}
        />
      {/if}
    </div>

    <!-- Groups -->
    {#if groupConversations.length > 0}
      <div class="section">
        <div class="section-header-row">
          <button class="section-toggle" onclick={() => toggleSection("groups")}>
            <span class="toggle-icon">{collapsed.has("groups") ? "\u25B8" : "\u25BE"}</span>
            <span>Groups</span>
          </button>
          <button class="section-add" onclick={onNewChat} title="New group">+</button>
        </div>
        {#if !collapsed.has("groups")}
          <ConversationList
            conversations={groupConversations}
            {minds}
            activeId={activeConversationId}
            {username}
            mode="dms"
            onSelect={onSelectConversation}
            onDelete={onDeleteConversation}
            {onOpenMind}
            onHide={onHideConversation}
          />
        {/if}
      </div>
    {/if}

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
          activeId={activeConversationId}
          {username}
          mode="channels"
          onSelect={onSelectConversation}
          onDelete={onDeleteConversation}
          {onOpenMind}
        />
      {/if}
    </div>

    <!-- Pages -->
    {#if sites.length > 0}
      <div class="section">
        <div class="section-header-row">
          <button class="section-toggle" onclick={() => toggleSection("pages")}>
            <span class="toggle-icon">{collapsed.has("pages") ? "\u25B8" : "\u25BE"}</span>
            <span>Pages</span>
          </button>
          <button class="section-add" onclick={onSelectPages} title="All pages">{"\u229E"}</button>
        </div>
        {#if !collapsed.has("pages")}
          <div class="site-list">
            {#each sites as site}
              <button class="site-item" onclick={() => onSelectSite(site.name)}>
                {site.label}
              </button>
            {/each}
          </div>
        {/if}
      </div>
    {/if}
  </div>
</div>

<style>
  .sidebar-inner {
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow: hidden;
  }

  .sidebar-header {
    padding: 12px 12px 8px;
    font-size: 13px;
    font-weight: 600;
    color: var(--text-1);
    letter-spacing: 0.02em;
    flex-shrink: 0;
    background: none;
    text-align: left;
    cursor: pointer;
  }

  .sidebar-header:hover {
    color: var(--text-0);
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
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
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
    font-size: 14px;
    padding: 2px 6px;
    border-radius: var(--radius);
    flex-shrink: 0;
  }

  .section-add:hover {
    color: var(--text-0);
    background: var(--bg-2);
  }

  .site-list {
    display: flex;
    flex-direction: column;
  }

  .site-item {
    display: block;
    width: 100%;
    padding: 6px 12px 6px 26px;
    font-size: 11px;
    color: var(--text-1);
    border-radius: var(--radius);
    transition: background 0.1s;
    cursor: pointer;
    background: none;
    text-align: left;
    margin: 0 4px;
  }

  .site-item:hover {
    background: var(--bg-2);
  }
</style>
