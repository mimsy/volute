<script lang="ts">
import type { ConversationWithParticipants, Mind, RecentPage } from "../lib/api";
import ConversationList from "./ConversationList.svelte";
import MindList from "./MindList.svelte";
import PagesList from "./PagesList.svelte";

let {
  minds,
  conversations,
  pages,
  selectedMind,
  activeConversationId,
  username,
  onSelectMind,
  onSelectConversation,
  onDeleteConversation,
  onNewChat,
  onNewGroup,
  onBrowseChannels,
  onSeed,
}: {
  minds: Mind[];
  conversations: ConversationWithParticipants[];
  pages: RecentPage[];
  selectedMind: string | null;
  activeConversationId: string | null;
  username: string;
  onSelectMind: (name: string) => void;
  onSelectConversation: (id: string) => void;
  onDeleteConversation: (id: string) => void;
  onNewChat: () => void;
  onNewGroup: () => void;
  onBrowseChannels: () => void;
  onSeed: () => void;
} = $props();

type Section = "minds" | "chats" | "pages";

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
</script>

<div class="sidebar-inner">
  <div class="sidebar-actions">
    <button class="new-chat-btn" onclick={onNewChat}>+ new chat</button>
    <button class="group-btn" onclick={onNewGroup} title="New group">++</button>
  </div>

  <div class="sections">
    <!-- Minds -->
    <div class="section">
      <button class="section-toggle" onclick={() => toggleSection("minds")}>
        <span class="toggle-icon">{collapsed.has("minds") ? "\u25B8" : "\u25BE"}</span>
        <span>Minds</span>
        <span class="section-count">{minds.length}</span>
      </button>
      {#if !collapsed.has("minds")}
        <MindList {minds} {selectedMind} onSelect={onSelectMind} onSeed={onSeed} />
      {/if}
    </div>

    <!-- Conversations -->
    <div class="section">
      <button class="section-toggle" onclick={() => toggleSection("chats")}>
        <span class="toggle-icon">{collapsed.has("chats") ? "\u25B8" : "\u25BE"}</span>
        <span>Conversations</span>
        <span class="section-count">{conversations.length}</span>
      </button>
      {#if !collapsed.has("chats")}
        <ConversationList
          {conversations}
          {minds}
          activeId={activeConversationId}
          {username}
          onSelect={onSelectConversation}
          onDelete={onDeleteConversation}
          onBrowse={onBrowseChannels}
        />
      {/if}
    </div>

    <!-- Pages -->
    {#if pages.length > 0}
      <div class="section">
        <button class="section-toggle" onclick={() => toggleSection("pages")}>
          <span class="toggle-icon">{collapsed.has("pages") ? "\u25B8" : "\u25BE"}</span>
          <span>Pages</span>
          <span class="section-count">{pages.length}</span>
        </button>
        {#if !collapsed.has("pages")}
          <PagesList {pages} />
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

  .sidebar-actions {
    display: flex;
    gap: 4px;
    padding: 8px;
    flex-shrink: 0;
  }

  .new-chat-btn {
    flex: 1;
    padding: 6px 10px;
    background: var(--accent-dim);
    color: var(--accent);
    border-radius: var(--radius);
    font-size: 11px;
    font-weight: 500;
    text-align: left;
  }

  .group-btn {
    padding: 6px 8px;
    background: var(--bg-2);
    color: var(--text-1);
    border-radius: var(--radius);
    font-size: 11px;
    border: 1px solid var(--border);
  }

  .sections {
    flex: 1;
    overflow-y: auto;
    overflow-x: hidden;
  }

  .section {
    margin-bottom: 2px;
  }

  .section-toggle {
    display: flex;
    align-items: center;
    gap: 4px;
    width: 100%;
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

  .section-count {
    margin-left: auto;
    font-weight: 400;
    font-size: 10px;
    color: var(--text-2);
  }
</style>
