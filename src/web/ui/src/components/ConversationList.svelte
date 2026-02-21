<script lang="ts">
import type { ConversationWithParticipants, Mind, Participant } from "../lib/api";
import { getConversationLabel } from "../lib/format";

let {
  conversations,
  minds,
  activeId,
  username,
  onSelect,
  onDelete,
  onBrowse,
}: {
  conversations: ConversationWithParticipants[];
  minds: Mind[];
  activeId: string | null;
  username: string;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onBrowse: () => void;
} = $props();

let channels = $derived(conversations.filter((c) => c.type === "channel"));
let directMessages = $derived(conversations.filter((c) => c.type !== "channel"));

function getParticipantBadges(conv: ConversationWithParticipants): Participant[] {
  return conv.participants?.filter((p) => p.userType === "mind") ?? [];
}
</script>

<div class="conv-list">
  <div class="section-header">
    <span>CHANNELS</span>
    <button class="browse-btn" onclick={onBrowse}>browse</button>
  </div>
  {#each channels as conv (conv.id)}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="conv-item"
      class:active={conv.id === activeId}
      onclick={() => onSelect(conv.id)}
      onkeydown={() => {}}
    >
      <div class="conv-item-header">
        <div class="conv-item-label" class:active={conv.id === activeId}>
          <span class="conv-label-text">{getConversationLabel(conv.participants ?? [], conv.title, username, conv)}</span>
        </div>
        {#if conv.id === activeId}
          <button class="delete-btn" onclick={(e) => { e.stopPropagation(); onDelete(conv.id); }}>x</button>
        {/if}
      </div>
    </div>
  {/each}

  <div class="section-header">
    <span>DIRECT MESSAGES</span>
  </div>
  {#each directMessages as conv (conv.id)}
    {@const badges = getParticipantBadges(conv)}
    {@const isSeed = minds.find((m) => m.name === conv.mind_name)?.stage === "seed"}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="conv-item"
      class:active={conv.id === activeId}
      onclick={() => onSelect(conv.id)}
      onkeydown={() => {}}
    >
      <div class="conv-item-header">
        <div class="conv-item-label" class:active={conv.id === activeId}>
          <span class="conv-label-text">{getConversationLabel(conv.participants ?? [], conv.title, username, conv)}</span>
          {#if isSeed}
            <span class="seed-tag">seed</span>
          {/if}
        </div>
        {#if conv.id === activeId}
          <button class="delete-btn" onclick={(e) => { e.stopPropagation(); onDelete(conv.id); }}>x</button>
        {/if}
      </div>
      {#if badges.length > 0}
        <div class="badge-row">
          {#each badges as p (p.username)}
            <span class="mind-badge">{p.username}</span>
          {/each}
        </div>
      {/if}
    </div>
  {/each}
  {#if directMessages.length === 0}
    <div class="empty">No conversations yet</div>
  {/if}
</div>

<style>
  .conv-list {
    display: flex;
    flex-direction: column;
  }

  .section-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 12px 4px;
    font-size: 10px;
    font-weight: 600;
    color: var(--text-2);
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }

  .browse-btn {
    font-size: 10px;
    color: var(--accent);
    background: none;
    padding: 0;
    text-transform: lowercase;
    letter-spacing: 0;
    font-weight: 500;
  }

  .conv-item {
    padding: 6px 12px;
    margin: 0 4px;
    cursor: pointer;
    border-radius: var(--radius);
    display: flex;
    flex-direction: column;
    gap: 2px;
    transition: background 0.1s;
  }

  .conv-item:hover {
    background: var(--bg-2);
  }

  .conv-item.active {
    background: var(--bg-3);
  }

  .conv-item-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 4px;
  }

  .conv-item-label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 12px;
    color: var(--text-1);
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .conv-item-label.active {
    color: var(--text-0);
  }

  .conv-label-text {
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .seed-tag {
    font-size: 9px;
    color: var(--yellow);
    flex-shrink: 0;
  }

  .delete-btn {
    background: transparent;
    color: var(--text-2);
    font-size: 11px;
    padding: 0 4px;
    flex-shrink: 0;
  }

  .badge-row {
    display: flex;
    gap: 4px;
    flex-wrap: wrap;
  }

  .mind-badge {
    font-size: 10px;
    color: var(--accent);
    background: var(--accent-bg);
    padding: 1px 5px;
    border-radius: 3px;
  }

  .empty {
    color: var(--text-2);
    font-size: 11px;
    padding: 8px 12px;
    text-align: center;
  }
</style>
