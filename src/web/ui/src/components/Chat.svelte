<script lang="ts">
import type { ContentBlock, Message, Mind } from "@volute/api";
import {
  fetchChannelMembers,
  fetchConversationMessages,
  reportTyping,
  sendChat,
  sendChatUnified,
} from "../lib/client";
import { subscribe } from "../lib/connection.svelte";
import MessageInput from "./MessageInput.svelte";
import MessageList from "./MessageList.svelte";
import TypingIndicator from "./TypingIndicator.svelte";

let {
  name,
  username,
  conversationId,
  onConversationId,
  stage,
  convType = "dm",
  channelName = "",
  minds = [],
  onOpenMind,
}: {
  name: string;
  username?: string;
  conversationId: string | null;
  onConversationId: (id: string) => void;
  stage?: "seed" | "sprouted";
  convType?: string;
  channelName?: string;
  minds?: Mind[];
  onOpenMind?: (mind: Mind) => void;
} = $props();

type ChatEntry = {
  id: number;
  serverId?: number;
  role: "user" | "assistant";
  blocks: ContentBlock[];
  senderName?: string;
  createdAt?: string;
};

let nextEntryId = 0;
let entries = $state<ChatEntry[]>([]);
let loadError = $state("");
let sending = $state(false);
let typingNames = $state<string[]>([]);
let hasMore = $state(false);
let loadingOlder = $state(false);
let memberCount = $state(0);
let currentConvId: string | null = null;
let typingSafetyTimer = 0;
let messageList: MessageList;

// Per-conversation message cache
const messageCache = new Map<string, { entries: ChatEntry[]; hasMore: boolean }>();

function normalizeContent(content: ContentBlock[] | string): ContentBlock[] {
  if (Array.isArray(content)) return content;
  return [{ type: "text", text: String(content) }];
}

function messagesToEntries(msgs: Message[]): ChatEntry[] {
  return msgs.map((m) => ({
    id: nextEntryId++,
    serverId: m.id,
    role: m.role,
    blocks: normalizeContent(m.content),
    senderName: m.sender_name ?? undefined,
    createdAt: m.created_at,
  }));
}

async function loadMessages(convId: string, forceScroll?: boolean) {
  // Check cache first
  const cached = messageCache.get(convId);
  if (cached && !forceScroll) {
    entries = cached.entries;
    hasMore = cached.hasMore;
    return;
  }

  try {
    const result = await fetchConversationMessages(convId, { limit: 50 });
    loadError = "";
    entries = messagesToEntries(result.items);
    hasMore = result.hasMore;
    messageCache.set(convId, { entries, hasMore });
    if (forceScroll) messageList?.scrollToBottom(true);
  } catch (e) {
    loadError = e instanceof Error ? e.message : "Failed to load messages";
  }
}

async function loadOlderMessages() {
  if (!currentConvId || loadingOlder || !hasMore) return;
  const cursor = entries[0]?.serverId;
  if (!cursor) return;

  loadingOlder = true;
  try {
    const result = await fetchConversationMessages(currentConvId, {
      before: cursor,
      limit: 50,
    });

    if (result.items.length > 0) {
      const olderEntries = messagesToEntries(result.items);
      entries = [...olderEntries, ...entries];
      hasMore = result.hasMore;
      messageCache.set(currentConvId, { entries, hasMore });
    } else {
      hasMore = false;
    }
  } catch (e) {
    loadError = e instanceof Error ? e.message : "Failed to load older messages";
  }
  loadingOlder = false;
}

// Load messages when conversationId changes
$effect(() => {
  currentConvId = conversationId;
  clearTimeout(typingSafetyTimer);
  typingNames = [];
  messageList?.resetToolState();
  if (!conversationId) {
    entries = [];
    hasMore = false;
    return;
  }
  loadMessages(conversationId, true);
});

// Load member count for channels
$effect(() => {
  if (convType !== "channel" || !channelName) {
    memberCount = 0;
    return;
  }
  fetchChannelMembers(channelName)
    .then((m) => {
      memberCount = m.length;
    })
    .catch((err) => {
      console.warn("[chat] failed to load member count:", err);
    });
});

// Subscribe to unified SSE for real-time updates
$effect(() => {
  if (!conversationId) return;

  const unsubscribe = subscribe((event) => {
    if (event.event !== "conversation") return;
    if (event.conversationId !== conversationId) return;

    if (event.type === "message") {
      // Skip user messages from ourselves — already added optimistically in handleSend
      if (event.role === "user" && event.senderName === username) return;

      // Append new message directly from SSE (no re-fetch needed)
      const newEntry: ChatEntry = {
        id: nextEntryId++,
        role: event.role,
        blocks: normalizeContent(event.content),
        senderName: event.senderName ?? undefined,
        createdAt: event.createdAt,
      };
      entries = [...entries, newEntry];
      if (currentConvId) {
        messageCache.set(currentConvId, { entries, hasMore });
      }
      messageList?.scrollToBottom();
    } else if (event.type === "typing") {
      const senders: string[] = event.senders;
      typingNames = senders.filter((n) => n !== username);
      clearTimeout(typingSafetyTimer);
      if (typingNames.length > 0) {
        typingSafetyTimer = window.setTimeout(() => {
          typingNames = [];
        }, 15_000);
      }
    }
  });

  return () => {
    unsubscribe();
    clearTimeout(typingSafetyTimer);
  };
});

async function handleSend(message: string, images: Array<{ media_type: string; data: string }>) {
  // Build user blocks for optimistic UI
  const userBlocks: ContentBlock[] = [];
  if (message) userBlocks.push({ type: "text", text: message });
  for (const img of images) {
    userBlocks.push({ type: "image", media_type: img.media_type, data: img.data });
  }

  entries = [
    ...entries,
    {
      id: nextEntryId++,
      role: "user",
      blocks: userBlocks,
      senderName: username,
      createdAt: new Date().toISOString(),
    },
  ];
  sending = true;
  messageList?.scrollToBottom(true);

  try {
    let resultConvId: string;
    if (convType === "channel" && currentConvId) {
      const result = await sendChatUnified(
        currentConvId,
        message,
        images.length > 0 ? images : undefined,
      );
      resultConvId = result.conversationId;
    } else {
      const result = await sendChat(
        name,
        message,
        currentConvId ?? undefined,
        images.length > 0 ? images : undefined,
      );
      resultConvId = result.conversationId;
    }
    currentConvId = resultConvId;
    onConversationId(resultConvId);
  } catch (err) {
    console.error("Failed to send message:", err);
    entries = [
      ...entries,
      {
        id: nextEntryId++,
        role: "assistant",
        blocks: [{ type: "text", text: "*Failed to send message. Please try again.*" }],
        senderName: "system",
      },
    ];
  }
  sending = false;
}
</script>

<div class="chat">
  {#if stage === "seed"}
    <div class="orientation-bar">orientation</div>
  {/if}

  {#if convType === "channel" && channelName}
    <div class="channel-header">
      <span class="channel-title">#{channelName}</span>
      <span class="channel-members">{memberCount} member{memberCount === 1 ? "" : "s"}</span>
    </div>
  {/if}

  <MessageList
    bind:this={messageList}
    {entries}
    {loadError}
    {hasMore}
    {loadingOlder}
    onLoadOlder={loadOlderMessages}
    {minds}
    {onOpenMind}
  />

  <TypingIndicator names={typingNames} />

  <MessageInput
    {sending}
    onSend={handleSend}
    mindName={name}
    {conversationId}
    {username}
  />
</div>

<style>
  .chat {
    display: flex;
    flex-direction: column;
    height: 100%;
    padding: 0;
  }

  .orientation-bar {
    padding: 6px 12px;
    text-align: center;
    color: var(--yellow);
    font-size: 11px;
    font-weight: 500;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    opacity: 0.6;
    border-bottom: 1px solid var(--yellow-bg);
  }

  .channel-header {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 12px;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }

  .channel-title {
    font-size: 13px;
    font-weight: 600;
    color: var(--text-0);
  }

  .channel-members {
    font-size: 11px;
    color: var(--text-2);
    flex: 1;
  }
</style>
