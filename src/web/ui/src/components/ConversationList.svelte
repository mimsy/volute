<script lang="ts">
import type { ConversationWithParticipants, Mind } from "../lib/api";
import { getConversationLabel, getDisplayStatus } from "../lib/format";

let {
  conversations,
  minds,
  activeId,
  username,
  mode,
  onSelect,
  onDelete,
  onBrowse,
  onOpenMind,
}: {
  conversations: ConversationWithParticipants[];
  minds: Mind[];
  activeId: string | null;
  username: string;
  mode?: "dms" | "channels";
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onBrowse?: () => void;
  onOpenMind: (mind: Mind) => void;
} = $props();

let channels = $derived(conversations.filter((c) => c.type === "channel"));
let directMessages = $derived(conversations.filter((c) => c.type !== "channel"));

function getDmInfo(conv: ConversationWithParticipants): {
  isMindDm: boolean;
  mind?: Mind;
  otherName?: string;
} {
  if (conv.type === "channel") return { isMindDm: false };
  const participants = conv.participants ?? [];
  if (participants.length !== 2) return { isMindDm: false };
  const other = participants.find((p) => p.username !== username);
  if (!other) return { isMindDm: false };
  const matchingMind = minds.find((m) => m.name === other.username);
  if (matchingMind) return { isMindDm: true, mind: matchingMind, otherName: other.username };
  return { isMindDm: false, otherName: other.username };
}

function mindDotColor(mind: Mind): string {
  const s = getDisplayStatus(mind);
  if (s === "running" || s === "active") return "var(--accent)";
  if (s === "starting") return "var(--yellow)";
  return "var(--text-2)";
}
</script>

<div class="conv-list">
  {#if mode !== "dms"}
    {#if !mode}
      <div class="section-header">
        <span>CHANNELS</span>
        {#if onBrowse}
          <button class="browse-btn" onclick={onBrowse}>browse</button>
        {/if}
      </div>
    {/if}
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
  {/if}

  {#if mode !== "channels"}
    {#if !mode}
      <div class="section-header">
        <span>DIRECT MESSAGES</span>
      </div>
    {/if}
    {#each directMessages as conv (conv.id)}
      {@const isSeed = minds.find((m) => m.name === conv.mind_name)?.stage === "seed"}
      {@const dmInfo = getDmInfo(conv)}
      {@const isGroup = (conv.participants?.length ?? 0) > 2}
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        class="conv-item"
        class:active={conv.id === activeId}
        onclick={() => onSelect(conv.id)}
        onkeydown={() => {}}
      >
        <div class="conv-item-header">
          <div class="conv-item-label" class:active={conv.id === activeId}>
            {#if dmInfo.isMindDm && dmInfo.mind}
              <button
                class="status-dot"
                title="Open {dmInfo.otherName}"
                style:background={mindDotColor(dmInfo.mind)}
                style:box-shadow={getDisplayStatus(dmInfo.mind) === "running" || getDisplayStatus(dmInfo.mind) === "active" ? `0 0 6px ${mindDotColor(dmInfo.mind)}` : "none"}
                onclick={(e) => { e.stopPropagation(); onOpenMind(dmInfo.mind!); }}
              ></button>
              <span class="conv-label-text">{dmInfo.otherName}</span>
            {:else if dmInfo.otherName}
              <span class="conv-label-text">@{dmInfo.otherName}</span>
            {:else}
              <span class="conv-label-text">{getConversationLabel(conv.participants ?? [], conv.title, username, conv)}</span>
            {/if}
            {#if isSeed}
              <span class="seed-tag">seed</span>
            {/if}
          </div>
          {#if conv.id === activeId}
            <button class="delete-btn" onclick={(e) => { e.stopPropagation(); onDelete(conv.id); }}>x</button>
          {/if}
        </div>
        {#if isGroup}
          <div class="member-count">{conv.participants?.length} members</div>
        {/if}
      </div>
    {/each}
    {#if directMessages.length === 0 && mode === "dms"}
      <div class="empty">No conversations yet</div>
    {/if}
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

  .member-count {
    font-size: 10px;
    color: var(--text-2);
    padding-left: 1px;
  }

  .status-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    flex-shrink: 0;
    border: none;
    padding: 0;
    cursor: pointer;
  }

  .status-dot:hover {
    transform: scale(1.3);
  }

  .empty {
    color: var(--text-2);
    font-size: 11px;
    padding: 8px 12px;
    text-align: center;
  }
</style>
