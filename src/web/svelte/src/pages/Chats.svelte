<script lang="ts">
import Chat from "../components/Chat.svelte";
import GroupModal from "../components/GroupModal.svelte";
import MindPickerModal from "../components/MindPickerModal.svelte";
import {
  type Conversation,
  deleteConversationById,
  fetchAllConversations,
  fetchMinds,
  type Mind,
  type Participant,
} from "../lib/api";
import { getConversationLabel } from "../lib/format";

let {
  conversationId: initialId,
  mindName: initialMind,
  username,
}: {
  conversationId?: string;
  mindName?: string;
  username: string;
} = $props();

type ConversationWithParticipants = Conversation & { participants: Participant[] };

let conversations = $state<ConversationWithParticipants[]>([]);
let activeId = $state<string | null>(initialId ?? null);
let showNewChat = $state(false);
let showGroupModal = $state(false);
let newChatMind = $state<string | null>(initialMind ?? null);
let minds = $state<Mind[]>([]);
let error = $state("");

let activeConv = $derived(conversations.find((c) => c.id === activeId));

$effect(() => {
  if (initialMind) newChatMind = initialMind;
});

function refresh() {
  fetchAllConversations()
    .then((c) => {
      conversations = c;
      error = "";
    })
    .catch(() => {
      error = "Failed to load conversations";
    });
  fetchMinds()
    .then((m) => {
      minds = m;
    })
    .catch(() => {});
}

$effect(() => {
  refresh();
  const interval = setInterval(refresh, 5000);
  return () => clearInterval(interval);
});

// Sync prop → state when navigating via URL
$effect(() => {
  activeId = initialId ?? null;
});

// Sync active conversation → URL
$effect(() => {
  if (activeId) {
    const expected = `/chats/${activeId}`;
    if (window.location.pathname !== expected) {
      window.history.replaceState(null, "", expected);
    }
  } else {
    if (window.location.pathname.startsWith("/chats/")) {
      window.history.replaceState(null, "", "/chats");
    }
  }
});

// Clear newChatMind once conversation list catches up
$effect(() => {
  if (activeId && activeConv) newChatMind = null;
});

function handleSelect(conv: ConversationWithParticipants) {
  activeId = conv.id;
}

function handleNew() {
  activeId = null;
  window.history.replaceState(null, "", "/chats");
}

async function handleDelete(e: Event, id: string) {
  e.stopPropagation();
  try {
    await deleteConversationById(id);
  } catch (err) {
    console.error("Failed to delete conversation:", err);
    return;
  }
  refresh();
  if (activeId === id) handleNew();
}

function handleConversationId(id: string) {
  activeId = id;
  refresh();
}

function handleNewChatCreated(mind: string) {
  showNewChat = false;
  activeId = null;
  newChatMind = mind;
}

function handleGroupCreated(conv: Conversation) {
  showGroupModal = false;
  refresh();
  activeId = conv.id;
}

function getParticipantBadges(conv: ConversationWithParticipants): Participant[] {
  return conv.participants?.filter((p) => p.userType === "mind") ?? [];
}

let chatMindName = $derived(newChatMind || activeConv?.mind_name || "");
let chatMind = $derived(minds.find((m) => m.name === chatMindName));
</script>

<div class="chats">
  <!-- Sidebar -->
  <div class="sidebar">
    <div class="sidebar-actions">
      <button class="new-chat-btn" onclick={() => (showNewChat = true)}>+ new chat</button>
      <button class="group-btn" onclick={() => (showGroupModal = true)} title="New group">++</button>
    </div>
    <div class="conv-list">
      {#each conversations as conv (conv.id)}
        {@const badges = getParticipantBadges(conv)}
        {@const isSeed = minds.find((m) => m.name === conv.mind_name)?.stage === "seed"}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
          class="conv-item"
          class:active={conv.id === activeId}
          onclick={() => handleSelect(conv)}
          onkeydown={() => {}}
        >
          <div class="conv-item-header">
            <div class="conv-item-label" class:active={conv.id === activeId}>
              <span class="conv-label-text">{getConversationLabel(conv.participants ?? [], conv.title, username)}</span>
              {#if isSeed}
                <span class="seed-tag">seed</span>
              {/if}
            </div>
            <button
              class="delete-btn"
              class:visible={conv.id === activeId}
              onclick={(e) => handleDelete(e, conv.id)}
            >
              x
            </button>
          </div>
          {#if badges.length > 0}
            <div class="badge-row">
              {#each badges as p}
                <span class="mind-badge">{p.username}</span>
              {/each}
            </div>
          {/if}
        </div>
      {/each}
      {#if error}
        <div class="empty error">{error}</div>
      {:else if conversations.length === 0}
        <div class="empty">No conversations yet</div>
      {/if}
    </div>
  </div>

  <!-- Chat panel -->
  <div class="chat-panel">
    {#if chatMindName}
      <Chat
        name={chatMindName}
        {username}
        conversationId={activeId}
        onConversationId={handleConversationId}
        stage={chatMind?.stage}
      />
    {:else}
      <div class="no-chat">Select a conversation or start a new chat</div>
    {/if}
  </div>

  {#if showNewChat}
    <MindPickerModal onClose={() => (showNewChat = false)} onPick={handleNewChatCreated} />
  {/if}
  {#if showGroupModal}
    <GroupModal onClose={() => (showGroupModal = false)} onCreated={handleGroupCreated} />
  {/if}
</div>

<style>
  .chats {
    display: flex;
    height: 100%;
    animation: fadeIn 0.2s ease both;
  }

  .sidebar {
    display: flex;
    flex-direction: column;
    width: 240px;
    flex-shrink: 0;
    border-right: 1px solid var(--border);
  }

  .sidebar-actions {
    display: flex;
    gap: 4px;
    padding: 8px;
  }

  .new-chat-btn {
    flex: 1;
    padding: 8px 12px;
    background: var(--accent-dim);
    color: var(--accent);
    border-radius: var(--radius);
    font-size: 12px;
    font-weight: 500;
    text-align: left;
  }

  .group-btn {
    padding: 8px 10px;
    background: var(--bg-2);
    color: var(--text-1);
    border-radius: var(--radius);
    font-size: 12px;
    border: 1px solid var(--border);
  }

  .conv-list {
    flex: 1;
    overflow: auto;
  }

  .conv-item {
    padding: 8px 12px;
    margin: 0 4px;
    cursor: pointer;
    border-radius: var(--radius);
    background: transparent;
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
    visibility: hidden;
  }

  .delete-btn.visible {
    visibility: visible;
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
    font-size: 12px;
    padding: 16px 12px;
    text-align: center;
  }

  .error {
    color: var(--red);
  }

  .chat-panel {
    flex: 1;
    padding-left: 16px;
    min-width: 0;
  }

  .no-chat {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    color: var(--text-2);
    font-size: 13px;
  }
</style>
