<script lang="ts">
import type {
  ChannelSettings,
  ContentBlock,
  Message,
  Mind,
  Participant,
  SeedChecklist,
} from "@volute/api";
import { Icon } from "@volute/ui";
import { fetchChannelSettings, fetchConversationMessages, sendChat } from "../../lib/client";
import { subscribe } from "../../lib/connection.svelte";
import { auth } from "../../lib/stores.svelte";
import type { ChatEntry } from "../../lib/types";
import ChannelSettingsModal from "../modals/ChannelSettingsModal.svelte";
import ChatStatusBar from "./ChatStatusBar.svelte";
import MessageInput from "./MessageInput.svelte";
import MessageList from "./MessageList.svelte";
import SeedProgressCard from "./SeedProgressCard.svelte";

let {
  name,
  username,
  conversationId,
  onConversationId,
  stage,
  seedChecklist,
  convType = "dm",
  channelName = "",
  minds = [],
  participants = [],
  onOpenMind,
  onTypingNames,
}: {
  name: string;
  username?: string;
  conversationId: string | null;
  onConversationId: (id: string) => void;
  stage?: "seed" | "sprouted";
  seedChecklist?: SeedChecklist;
  convType?: string;
  channelName?: string;
  minds?: Mind[];
  participants?: Participant[];
  onOpenMind?: (mind: Mind) => void;
  onTypingNames?: (names: string[]) => void;
} = $props();

let nextEntryId = 0;
let entries = $state<ChatEntry[]>([]);
let loadError = $state("");
let sending = $state(false);
// Spirit availability surfaced from the last send (#434): shown while the spirit wakes
// or when it can't answer. Cleared on the next send, on conversation switch, and when a
// message from the spirit itself arrives.
let spiritNotice = $state("");
let spiritSender = $state("");
let typingNames = $state<string[]>([]);
let hasMore = $state(false);
let loadingOlder = $state(false);
let currentConvId: string | null = null;
let typingSafetyTimer = 0;
let messageList: MessageList;
// The DM's target mind, for the status bar (#574). Channels show nothing.
let dmMind = $derived(convType === "dm" ? minds.find((m) => m.name === name) : undefined);

// Channel settings (description/rules/char limit/private) for the header + editor
let channelSettings = $state<ChannelSettings | null>(null);
let settingsLoadFailed = $state(false);
let showSettings = $state(false);

$effect(() => {
  // Reset first so a failed or in-flight fetch can never leave another
  // channel's settings behind (the modal seeds its form from this state).
  channelSettings = null;
  settingsLoadFailed = false;
  if (convType !== "channel" || !channelName) return;
  const target = channelName;
  fetchChannelSettings(target)
    .then((res) => {
      // Guard against a stale response after the channel switched
      if (target === channelName) channelSettings = res.settings ?? null;
    })
    .catch((err) => {
      if (target !== channelName) return;
      console.error(`Failed to load settings for #${target}:`, err);
      settingsLoadFailed = true;
    });
});

// Notify parent of typing names changes
$effect(() => {
  onTypingNames?.(typingNames);
});

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
  spiritNotice = "";
  spiritSender = "";
  messageList?.resetToolState();
  if (!conversationId) {
    entries = [];
    hasMore = false;
    return;
  }
  loadMessages(conversationId, true);
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

      // The spirit itself spoke — its availability notice is obsolete.
      if (spiritSender && event.senderName === spiritSender) spiritNotice = "";

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
      if (typingNames.length > 0) {
        messageList?.scrollToBottom();
      }
      clearTimeout(typingSafetyTimer);
      if (typingNames.length > 0) {
        typingSafetyTimer = window.setTimeout(() => {
          // Mind typing state is authoritative (published on delivery, done, and
          // stop/crash) and a turn can far outlast this timer — only reap humans,
          // whose stop event may have been missed.
          typingNames = typingNames.filter((n) => minds.some((m) => m.name === n));
        }, 15_000);
      }
    }
  });

  return () => {
    unsubscribe();
    clearTimeout(typingSafetyTimer);
  };
});

async function handleSend(
  message: string,
  images: Array<{ media_type: string; data: string }>,
  files: Array<{ filename: string; data: string }>,
) {
  // Build user blocks for optimistic UI
  const userBlocks: ContentBlock[] = [];
  if (message) userBlocks.push({ type: "text", text: message });
  for (const img of images) {
    userBlocks.push({ type: "image", media_type: img.media_type, data: img.data });
  }
  for (const file of files) {
    userBlocks.push({ type: "text", text: `[file] ${file.filename}` });
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
  spiritNotice = "";
  messageList?.scrollToBottom(true);

  try {
    const result = await sendChat({
      message,
      conversationId: currentConvId ?? undefined,
      targetMind: convType === "channel" ? undefined : name,
      images: images.length > 0 ? images : undefined,
      files: files.length > 0 ? files : undefined,
    });
    if (result.spirit && result.spiritName) {
      spiritSender = result.spiritName;
      // Prefer the spirit's display name; the daemon returns its username.
      const spiritLabel =
        participants.find((p) => p.username === result.spiritName)?.displayName ??
        result.spiritName;
      if (result.spirit === "waking") {
        spiritNotice = `${spiritLabel} is waking — a reply is on its way.`;
      } else if (result.spirit === "sleeping") {
        spiritNotice = `${spiritLabel} is sleeping — they'll reply when they wake.`;
      } else if (result.spirit === "unavailable") {
        spiritNotice = `${spiritLabel} is unavailable. An admin can fix this in Settings.`;
      }
    }
    const resultConvId = result.conversationId;
    // Only notify the parent when the conversation is actually new. Firing on
    // every send used to rebuild the whole realtime layer (SSE reconnect +
    // full refetch); the live stream already delivers messages incrementally.
    const isNewConversation = resultConvId !== currentConvId;
    currentConvId = resultConvId;
    if (isNewConversation) onConversationId(resultConvId);
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
    {#if seedChecklist}
      <SeedProgressCard checklist={seedChecklist} />
    {:else}
      <div class="orientation-bar">orientation</div>
    {/if}
  {/if}

  {#if convType === "channel" && channelName}
    <div class="channel-header">
      <div class="channel-info">
        <span class="channel-title">#{channelName}</span>
        {#if channelSettings?.description}
          <span class="channel-description">{channelSettings.description}</span>
        {/if}
      </div>
      <button class="settings-btn" title="Channel settings" onclick={() => (showSettings = true)}>
        <Icon kind="gear" />
      </button>
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
    {participants}
    {onOpenMind}
    {typingNames}
  />

  <!-- Keyed on the mind name so switching DMs resets in-flight Start state;
       minds refreshes replace objects but keep the name, so no remount then. -->
  {#key dmMind?.name}
    <ChatStatusBar mind={dmMind} isAdmin={auth.user?.role === "admin"} />
  {/key}

  {#if spiritNotice}
    <div class="spirit-notice">{spiritNotice}</div>
  {/if}

  <MessageInput
    {sending}
    onSend={handleSend}
    mindName={name}
    {conversationId}
    {username}
  />
</div>

{#if showSettings}
  <ChannelSettingsModal
    {channelName}
    settings={channelSettings}
    loadFailed={settingsLoadFailed}
    onClose={() => (showSettings = false)}
    onSaved={(next) => {
      channelSettings = next;
      settingsLoadFailed = false;
    }}
  />
{/if}

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
    font-size: 12px;
    font-weight: 500;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    opacity: 0.6;
    border-bottom: 1px solid var(--yellow-bg);
  }

  .spirit-notice {
    padding: 6px 12px;
    text-align: center;
    color: var(--text-1);
    font-size: 12px;
    opacity: 0.8;
    flex-shrink: 0;
  }

  .channel-header {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 12px;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }

  .channel-info {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
    flex: 1;
  }

  .channel-title {
    font-size: 14px;
    font-weight: 600;
    color: var(--text-0);
  }

  .channel-description {
    font-size: 12px;
    color: var(--text-2);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .settings-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    background: none;
    border: none;
    color: var(--text-2);
    cursor: pointer;
    padding: 4px;
    border-radius: var(--radius);
    flex-shrink: 0;
  }

  .settings-btn:hover {
    color: var(--text-0);
    background: var(--bg-2);
  }

  @media (max-width: 1024px) {
    .channel-header {
      display: none;
    }
  }
</style>
