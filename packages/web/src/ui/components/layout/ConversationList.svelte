<script lang="ts">
import type { ConversationWithParticipants, Mind } from "@volute/api";
import { Dropdown } from "@volute/ui";
import { setConversationPrivate } from "../../lib/client";
import { getConversationLabel, mindDotColor } from "../../lib/format";
import { activeMinds, unreadCounts } from "../../lib/stores.svelte";

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
  onHide,
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
  onHide?: (id: string) => void;
} = $props();

let channels = $derived(conversations.filter((c) => c.type === "channel"));
let directMessages = $derived(conversations.filter((c) => c.type !== "channel"));

let contextMenu = $state<{ id: string; x: number; y: number } | null>(null);

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

function openMenu(e: MouseEvent, convId: string) {
  e.stopPropagation();
  const btn = e.currentTarget as HTMLElement;
  const rect = btn.getBoundingClientRect();
  contextMenu = { id: convId, x: rect.right + 4, y: rect.top };
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
      {@const unread = unreadCounts.get(conv.id) ?? 0}
      <div
        class="conv-item"
        class:active={conv.id === activeId}
        role="button"
        tabindex="0"
        onclick={() => onSelect(conv.id)}
        onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(conv.id); } }}
      >
        <div class="conv-item-header">
          <div class="conv-item-label" class:active={conv.id === activeId} class:unread={unread > 0}>
            <span class="conv-label-text">{getConversationLabel(conv.participants ?? [], username, conv)}</span>
            {#if conv.private === 1}
              <svg class="lock-icon" viewBox="0 0 16 16" fill="currentColor"><path d="M11 7V5a3 3 0 0 0-6 0v2H4v6h8V7h-1zm-4-2a1 1 0 1 1 2 0v2H7V5z"/></svg>
            {/if}
          </div>
          {#if unread > 0}
            <span class="unread-badge">{unread}</span>
          {:else}
            <button class="delete-btn" onclick={(e) => { e.stopPropagation(); onDelete(conv.id); }} aria-label="Remove">
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>
            </button>
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
      {@const otherMind = conv.participants?.find((p) => p.userType === "mind" && p.username !== username)}
      {@const isSeed = otherMind ? minds.find((m) => m.name === otherMind.username)?.stage === "seed" : false}
      {@const dmInfo = getDmInfo(conv)}
      {@const isGroup = (conv.participants?.length ?? 0) > 2}
      {@const unread = unreadCounts.get(conv.id) ?? 0}
      <div
        class="conv-item"
        class:active={conv.id === activeId}
        role="button"
        tabindex="0"
        onclick={() => onSelect(conv.id)}
        onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(conv.id); } }}
      >
        <div class="conv-item-header">
          <div class="conv-item-label" class:active={conv.id === activeId} class:unread={unread > 0}>
            {#if dmInfo.isMindDm && dmInfo.mind}
              <button
                class="status-dot"
                class:iridescent={activeMinds.has(dmInfo.mind.name)}
                title="Open {dmInfo.otherName}"
                style:background={activeMinds.has(dmInfo.mind.name) ? undefined : mindDotColor(dmInfo.mind)}
                onclick={(e) => { e.stopPropagation(); onOpenMind(dmInfo.mind!); }}
              ></button>
              <button class="conv-label-mind" onclick={(e) => { e.stopPropagation(); onOpenMind(dmInfo.mind!); }}>{dmInfo.otherName}</button>
            {:else if dmInfo.otherName}
              <span class="conv-label-text">@{dmInfo.otherName}</span>
            {:else}
              <span class="conv-label-text">{getConversationLabel(conv.participants ?? [], username, conv)}</span>
            {/if}
            {#if conv.private === 1}
              <svg class="lock-icon" viewBox="0 0 16 16" fill="currentColor"><path d="M11 7V5a3 3 0 0 0-6 0v2H4v6h8V7h-1zm-4-2a1 1 0 1 1 2 0v2H7V5z"/></svg>
            {/if}
            {#if isSeed}
              <span class="seed-tag">seed</span>
            {/if}
          </div>
          <button
            class="menu-btn"
            class:visible={conv.id === activeId || conv.id === contextMenu?.id}
            onclick={(e) => openMenu(e, conv.id)}
          >...</button>
          {#if unread > 0}
            <span class="unread-badge">{unread}</span>
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

{#if contextMenu}
  {@const menuId = contextMenu.id}
  {@const menuConv = conversations.find((c) => c.id === menuId)}
  {@const menuDmInfo = menuConv ? getDmInfo(menuConv) : { isMindDm: false }}
  <Dropdown open={!!contextMenu} onclose={() => (contextMenu = null)} position={{ x: contextMenu.x, y: contextMenu.y }}>
    {#if menuDmInfo.isMindDm && menuDmInfo.mind}
      <button class="context-item" onclick={() => { onOpenMind(menuDmInfo.mind!); contextMenu = null; }}>
        Open mind
      </button>
    {/if}
    <button class="context-item" onclick={async () => {
      const id = contextMenu!.id;
      const conv = conversations.find((c) => c.id === id);
      if (conv) {
        const newPrivate = conv.private !== 1;
        try {
          await setConversationPrivate(id, newPrivate);
          conv.private = newPrivate ? 1 : 0;
        } catch (err) {
          console.error("Failed to update conversation privacy:", err);
        }
      }
      contextMenu = null;
    }}>
      {menuConv?.private === 1 ? "Make public" : "Make private"}
    </button>
    {#if onHide}
      <button class="context-item" onclick={() => { onHide(contextMenu!.id); contextMenu = null; }}>
        Close chat
      </button>
    {/if}
  </Dropdown>
{/if}

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
    font-size: 11px;
    font-weight: 600;
    color: var(--text-2);
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }

  .browse-btn {
    font-size: 11px;
    color: var(--accent);
    background: none;
    padding: 0;
    text-transform: lowercase;
    letter-spacing: 0;
    font-weight: 500;
  }

  .conv-item {
    padding: 6px 8px 6px 24px;
    cursor: pointer;
    display: flex;
    flex-direction: column;
    gap: 2px;
    transition: background 0.1s;
  }

  .conv-item:hover {
    background: var(--bg-2);
  }

  .conv-item.active {
    background: var(--bg-2);
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
    font-size: 14px;
    color: var(--text-1);
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .conv-item-label.active {
    color: var(--text-0);
  }

  .conv-item-label.unread {
    font-weight: 600;
    color: var(--text-0);
  }

  .unread-badge {
    background: var(--accent);
    color: var(--bg-0);
    font-size: 11px;
    font-weight: 600;
    min-width: 16px;
    height: 16px;
    border-radius: 8px;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0 4px;
    flex-shrink: 0;
  }

  .conv-label-text {
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .conv-label-mind {
    overflow: hidden;
    text-overflow: ellipsis;
    background: none;
    border: none;
    padding: 0;
    font: inherit;
    color: inherit;
    cursor: pointer;
  }

  .conv-label-mind:hover {
    text-decoration: underline;
  }

  .lock-icon {
    width: 12px;
    height: 12px;
    color: var(--text-2);
    flex-shrink: 0;
  }

  .seed-tag {
    font-size: 9px;
    color: var(--yellow);
    flex-shrink: 0;
  }

  .delete-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    background: transparent;
    color: var(--text-2);
    flex-shrink: 0;
    opacity: 0;
    transition: opacity 0.1s, color 0.1s;
    padding: 0;
  }

  .delete-btn svg {
    width: 12px;
    height: 12px;
  }

  .conv-item:hover .delete-btn {
    opacity: 1;
  }

  .delete-btn:hover {
    color: var(--text-0);
  }

  .menu-btn {
    background: transparent;
    color: var(--text-2);
    font-size: 12px;
    padding: 0 4px;
    flex-shrink: 0;
    opacity: 0;
    transition: opacity 0.1s;
    letter-spacing: 1px;
  }

  .conv-item:hover .menu-btn,
  .menu-btn.visible {
    opacity: 1;
  }

  .menu-btn:hover {
    color: var(--text-0);
  }

  .member-count {
    font-size: 11px;
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

  .status-dot:hover {
    transform: scale(1.3);
  }

  .empty {
    color: var(--text-2);
    font-size: 12px;
    padding: 8px 12px;
    text-align: center;
  }

  .context-item {
    display: block;
    width: 100%;
    padding: 6px 12px;
    background: none;
    color: var(--text-1);
    font-size: 13px;
    text-align: left;
    white-space: nowrap;
  }

  .context-item:hover {
    background: var(--bg-2);
    color: var(--text-0);
  }

  @media (max-width: 767px) {
    .conv-item {
      padding: 10px 8px 10px 24px;
    }

    .delete-btn {
      opacity: 1;
    }

    .menu-btn {
      opacity: 1;
    }

    .context-item {
      padding: 10px 16px;
    }
  }
</style>
