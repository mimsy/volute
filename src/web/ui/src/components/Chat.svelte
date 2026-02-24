<script lang="ts">
import {
  type ContentBlock,
  fetchChannelMembers,
  fetchConversationMessages,
  fetchConversationMessagesById,
  type Mind,
  reportTyping,
} from "../lib/api";
import { renderMarkdown } from "../lib/markdown";
import { sendChat, sendChatUnified } from "../lib/streams";
import InviteModal from "./InviteModal.svelte";

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

let mindsByName = $derived(new Map(minds.map((m) => [m.name, m])));

let nextEntryId = 0;
type ChatEntry = {
  id: number;
  role: "user" | "assistant";
  blocks: ContentBlock[];
  senderName?: string;
};

type ToolBlock = {
  name: string;
  input: unknown;
  output?: string;
  isError?: boolean;
};

function normalizeContent(content: ContentBlock[] | string): ContentBlock[] {
  if (Array.isArray(content)) return content;
  return [{ type: "text", text: String(content) }];
}

let entries = $state<ChatEntry[]>([]);
let loadError = $state("");
let input = $state("");
let sending = $state(false);
let pendingImages = $state<Array<{ media_type: string; data: string; preview: string }>>([]);
let typingNames = $state<string[]>([]);
let scrollEl: HTMLDivElement;
let inputEl: HTMLTextAreaElement;
let fileEl: HTMLInputElement;
let typingTimer = 0;
let typingSafetyTimer = 0;
let lastPollFingerprint = "";
let currentConvId: string | null = null;
let showInviteModal = $state(false);
let memberCount = $state(0);

// Tool open state tracking
let openTools = $state<Set<number>>(new Set());

const SENDER_COLORS = [
  "var(--blue)",
  "var(--purple)",
  "var(--yellow)",
  "var(--red)",
  "var(--accent)",
];

let colorMap = $derived.by(() => {
  const map = new Map<string, string>();
  for (const entry of entries) {
    const n = entry.senderName;
    if (n && !map.has(n)) {
      map.set(n, SENDER_COLORS[map.size % SENDER_COLORS.length]);
    }
  }
  return map;
});

function scrollToBottom(force?: boolean) {
  requestAnimationFrame(() => {
    if (!scrollEl) return;
    if (force) {
      scrollEl.scrollTop = scrollEl.scrollHeight;
      return;
    }
    const isNearBottom = scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight < 100;
    if (isNearBottom) {
      scrollEl.scrollTop = scrollEl.scrollHeight;
    }
  });
}

function loadMessages(convId: string, forceScroll?: boolean) {
  const fetchFn = name
    ? fetchConversationMessages(name, convId)
    : fetchConversationMessagesById(convId);
  return fetchFn
    .then((msgs) => {
      const fingerprint = `${msgs.length}:${msgs[msgs.length - 1]?.id ?? ""}`;
      if (!forceScroll && fingerprint === lastPollFingerprint) return;
      lastPollFingerprint = fingerprint;

      loadError = "";
      entries = msgs.map((m) => ({
        id: nextEntryId++,
        role: m.role as "user" | "assistant",
        blocks: normalizeContent(m.content),
        senderName: m.sender_name ?? undefined,
      }));
      if (forceScroll) scrollToBottom(true);
    })
    .catch((e) => {
      loadError = e instanceof Error ? e.message : "Failed to load messages";
    });
}

// Load messages when conversationId changes
$effect(() => {
  currentConvId = conversationId;
  lastPollFingerprint = "";
  openTools = new Set();
  clearTimeout(typingSafetyTimer);
  typingNames = [];
  if (!conversationId) {
    entries = [];
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

// SSE subscription for real-time updates
$effect(() => {
  if (!conversationId) return;
  if (convType !== "channel" && !name) return;
  const sseUrl =
    convType === "channel"
      ? `/api/conversations/${encodeURIComponent(conversationId)}/events`
      : `/api/minds/${encodeURIComponent(name)}/conversations/${encodeURIComponent(conversationId)}/events`;
  const eventSource = new EventSource(sseUrl);
  eventSource.onmessage = (ev) => {
    if (!ev.data) return;
    try {
      const event = JSON.parse(ev.data);
      if (event.type === "message") {
        loadMessages(conversationId, false);
        scrollToBottom();
      } else if (event.type === "typing") {
        const senders: string[] = event.senders;
        typingNames = senders.filter((n) => n !== username);
        // Reset safety timers — clear stale entries after 15s of no updates
        clearTimeout(typingSafetyTimer);
        if (typingNames.length > 0) {
          typingSafetyTimer = window.setTimeout(() => {
            typingNames = [];
          }, 15_000);
        }
      }
    } catch (err) {
      console.warn("[chat] failed to parse SSE event:", err);
    }
  };
  eventSource.onopen = () => {
    loadMessages(conversationId, false);
  };
  eventSource.onerror = () => {
    console.warn("[chat] SSE connection error, browser will attempt reconnect");
  };
  return () => {
    eventSource.close();
    clearTimeout(typingSafetyTimer);
  };
});

// Clear typing on unmount
$effect(() => {
  return () => {
    if (currentConvId && name && username && typingTimer > 0) {
      reportTyping(name, `volute:${currentConvId}`, username, false);
    }
  };
});

async function handleSend() {
  const message = input.trim();
  if (!message && pendingImages.length === 0) return;
  if (sending) return;

  const images = pendingImages.map(({ media_type, data }) => ({ media_type, data }));

  // Build user blocks for optimistic UI
  const userBlocks: ContentBlock[] = [];
  if (message) {
    userBlocks.push({ type: "text", text: message });
  }
  for (const img of pendingImages) {
    userBlocks.push({ type: "image", media_type: img.media_type, data: img.data });
  }

  input = "";
  pendingImages = [];
  if (inputEl) {
    inputEl.style.height = "auto";
    inputEl.style.overflow = "hidden";
  }
  entries = [
    ...entries,
    { id: nextEntryId++, role: "user", blocks: userBlocks, senderName: username },
  ];
  sending = true;
  if (currentConvId && name && username) {
    reportTyping(name, `volute:${currentConvId}`, username, false);
    typingTimer = 0;
  }
  scrollToBottom(true);

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
    sending = false;
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
    sending = false;
  }
}

function handleKeyDown(e: KeyboardEvent) {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    handleSend();
  }
}

function handleFiles(files: FileList | null) {
  if (!files) return;
  for (const file of Array.from(files)) {
    if (!file.type.startsWith("image/")) continue;
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const base64 = result.split(",")[1];
      pendingImages = [...pendingImages, { media_type: file.type, data: base64, preview: result }];
    };
    reader.readAsDataURL(file);
  }
}

function handleInput(e: Event) {
  const el = e.currentTarget as HTMLTextAreaElement;
  // Report typing (debounced to every 3s)
  if (currentConvId && name && username) {
    const now = Date.now();
    if (now - typingTimer > 3000) {
      typingTimer = now;
      reportTyping(name, `volute:${currentConvId}`, username, true);
    }
  }
  // Auto-resize
  el.style.height = "auto";
  const maxH = 120;
  el.style.height = `${Math.min(el.scrollHeight, maxH)}px`;
  el.style.overflow = el.scrollHeight > maxH ? "auto" : "hidden";
}

function handleBlur() {
  if (currentConvId && name && username && typingTimer > 0) {
    reportTyping(name, `volute:${currentConvId}`, username, false);
    typingTimer = 0;
  }
}

function getToolSummary(tool: ToolBlock): { label: string; color: string } {
  const inp = tool.input as Record<string, unknown>;
  switch (tool.name) {
    case "Read":
      return { label: `Read ${inp.file_path ?? ""}`, color: "var(--blue)" };
    case "Write":
      return { label: `Write ${inp.file_path ?? ""}`, color: "var(--blue)" };
    case "Edit":
      return { label: `Edit ${inp.file_path ?? ""}`, color: "var(--blue)" };
    case "Glob":
      return { label: `Glob ${inp.pattern ?? ""}`, color: "var(--yellow)" };
    case "Grep":
      return {
        label: `Grep "${inp.pattern ?? ""}"${inp.path ? ` in ${inp.path}` : ""}`,
        color: "var(--yellow)",
      };
    case "Bash":
      return {
        label: `Bash: ${String(inp.command ?? "").split("\n")[0]}`,
        color: "var(--red)",
      };
    case "WebSearch":
      return { label: `Search: "${inp.query ?? ""}"`, color: "var(--purple)" };
    case "WebFetch":
      return { label: `Fetch: ${inp.url ?? ""}`, color: "var(--purple)" };
    case "Task":
      return { label: `Task: ${inp.description ?? ""}`, color: "var(--accent)" };
    default:
      return { label: tool.name, color: "var(--purple)" };
  }
}

function buildAssistantItems(
  blocks: ContentBlock[],
): Array<
  | { kind: "text"; text: string }
  | { kind: "tool"; tool: ToolBlock }
  | { kind: "image"; media_type: string; data: string }
> {
  const items: Array<
    | { kind: "text"; text: string }
    | { kind: "tool"; tool: ToolBlock }
    | { kind: "image"; media_type: string; data: string }
  > = [];

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (block.type === "text") {
      items.push({ kind: "text", text: block.text });
    } else if (block.type === "tool_use") {
      const tool: ToolBlock = { name: block.name, input: block.input };
      const next = blocks[i + 1];
      if (next && next.type === "tool_result") {
        tool.output = next.output;
        tool.isError = next.is_error;
        i++;
      }
      items.push({ kind: "tool", tool });
    } else if (block.type === "tool_result") {
      // Orphaned tool_result — skip
    } else if (block.type === "image") {
      items.push({ kind: "image", media_type: block.media_type, data: block.data });
    }
  }
  return items;
}

function toggleTool(idx: number) {
  const next = new Set(openTools);
  if (next.has(idx)) next.delete(idx);
  else next.add(idx);
  openTools = next;
}
</script>

<div class="chat">
  <!-- Orientation header -->
  {#if stage === "seed"}
    <div class="orientation-bar">orientation</div>
  {/if}

  <!-- Channel header -->
  {#if convType === "channel" && channelName}
    <div class="channel-header">
      <span class="channel-title">#{channelName}</span>
      <span class="channel-members">{memberCount} member{memberCount === 1 ? "" : "s"}</span>
      <button class="invite-btn" onclick={() => { showInviteModal = true; }}>invite</button>
    </div>
  {/if}

  {#if showInviteModal && channelName}
    <InviteModal {channelName} onClose={() => {
      showInviteModal = false;
      if (channelName) fetchChannelMembers(channelName).then((m) => { memberCount = m.length; }).catch((err) => { console.warn("[chat] failed to refresh member count:", err); });
    }} />
  {/if}

  <!-- Messages -->
  <div class="messages" bind:this={scrollEl}>
    {#if loadError}
      <div class="empty error">{loadError}</div>
    {:else if entries.length === 0}
      <div class="empty">Send a message to start chatting.</div>
    {/if}
    {#each entries as entry, i (entry.id)}
      <!-- System divider -->
      {#if entry.senderName === "system" && entry.blocks.length === 1 && entry.blocks[0].type === "text"}
        {@const text = entry.blocks[0].text}
        {@const dividerMatch = text.match(/^\[(.+)\]$/)}
        {#if dividerMatch}
          <div class="divider">
            <div class="divider-line"></div>
            <span>{dividerMatch[1]}</span>
            <div class="divider-line"></div>
          </div>
        {:else if entry.role === "user"}
          <div class="entry">
            {#if entry.senderName && mindsByName.has(entry.senderName) && onOpenMind}
              <button class="sender sender-link user" style:color={colorMap.get(entry.senderName) ?? "var(--blue)"} onclick={() => onOpenMind(mindsByName.get(entry.senderName!)!)}>{entry.senderName}</button>
            {:else}
              <span class="sender user" style:color={entry.senderName ? colorMap.get(entry.senderName) : "var(--blue)"}>{entry.senderName || "you"}</span>
            {/if}
            <div class="entry-content">
              <div class="user-text">{text}</div>
            </div>
          </div>
        {:else}
          <div class="entry">
            {#if entry.senderName && mindsByName.has(entry.senderName) && onOpenMind}
              <button class="sender sender-link" style:color={colorMap.get(entry.senderName) ?? "var(--accent)"} onclick={() => onOpenMind(mindsByName.get(entry.senderName!)!)}>{entry.senderName}</button>
            {:else}
              <span class="sender" style:color={entry.senderName ? colorMap.get(entry.senderName) : "var(--accent)"}>{entry.senderName || "mind"}</span>
            {/if}
            <div class="entry-content">
              <div class="markdown-body">{@html renderMarkdown(text)}</div>
            </div>
          </div>
        {/if}
      {:else}
        <div class="entry">
          {#if entry.role === "user"}
            {#if entry.senderName && mindsByName.has(entry.senderName) && onOpenMind}
              <button class="sender sender-link user" style:color={colorMap.get(entry.senderName) ?? "var(--blue)"} onclick={() => onOpenMind(mindsByName.get(entry.senderName!)!)}>{entry.senderName}</button>
            {:else}
              <span class="sender user" style:color={entry.senderName ? colorMap.get(entry.senderName) : "var(--blue)"}>{entry.senderName || "you"}</span>
            {/if}
            <div class="entry-content">
              {#each entry.blocks as block}
                {#if block.type === "text"}
                  <div class="user-text">{block.text}</div>
                {:else if block.type === "image"}
                  <img src={`data:${block.media_type};base64,${block.data}`} alt="" class="chat-image" />
                {/if}
              {/each}
            </div>
          {:else}
            {@const items = buildAssistantItems(entry.blocks)}
            {#if entry.senderName && mindsByName.has(entry.senderName) && onOpenMind}
              <button class="sender sender-link" style:color={colorMap.get(entry.senderName) ?? "var(--accent)"} onclick={() => onOpenMind(mindsByName.get(entry.senderName!)!)}>{entry.senderName}</button>
            {:else}
              <span class="sender" style:color={entry.senderName ? colorMap.get(entry.senderName) : "var(--accent)"}>{entry.senderName || "mind"}</span>
            {/if}
            <div class="entry-content">
              {#each items as item, j}
                {#if item.kind === "text"}
                  <div class="markdown-body">{@html renderMarkdown(item.text)}</div>
                {:else if item.kind === "tool"}
                  {@const summary = getToolSummary(item.tool)}
                  {@const toolKey = i * 1000 + j}
                  {@const isOpen = openTools.has(toolKey)}
                  <div class="tool-block">
                    <button class="tool-header" onclick={() => toggleTool(toolKey)} style:color={summary.color}>
                      <span class="tool-label">
                        <span class="tool-arrow">{isOpen ? "\u25BE" : "\u25B8"}</span>
                        {summary.label}
                      </span>
                      {#if item.tool.output !== undefined}
                        <span class="tool-status" class:error={item.tool.isError}>
                          {item.tool.isError ? "error" : "done"}
                        </span>
                      {/if}
                    </button>
                    {#if isOpen}
                      <div class="tool-detail">
                        <div class="tool-section-label">input:</div>
                        <pre class="tool-pre">{JSON.stringify(item.tool.input, null, 2)}</pre>
                        {#if item.tool.output !== undefined}
                          <div class="tool-section-label" style="margin-top: 8px">output:</div>
                          <pre class="tool-pre tool-output" class:error={item.tool.isError}>{item.tool.output}</pre>
                        {/if}
                      </div>
                    {/if}
                  </div>
                {:else if item.kind === "image"}
                  <img src={`data:${item.media_type};base64,${item.data}`} alt="" class="chat-image" />
                {/if}
              {/each}
            </div>
          {/if}
        </div>
      {/if}
    {/each}
  </div>

  <!-- Image preview strip -->
  {#if pendingImages.length > 0}
    <div class="image-strip">
      {#each pendingImages as img, i (img.preview)}
        <div class="image-preview">
          <img src={img.preview} alt="" class="preview-thumb" />
          <button class="remove-image" onclick={() => { pendingImages = pendingImages.filter((_, j) => j !== i); }}>x</button>
        </div>
      {/each}
    </div>
  {/if}

  <!-- Typing indicator -->
  {#if typingNames.length > 0}
    <div class="typing">
      {typingNames.length === 1
        ? `${typingNames[0]} is typing...`
        : `${typingNames.join(", ")} are typing...`}
    </div>
  {/if}

  <!-- Hidden file input -->
  <input
    bind:this={fileEl}
    type="file"
    accept="image/*"
    multiple
    style="display: none"
    onchange={(e) => handleFiles((e.currentTarget as HTMLInputElement).files)}
  />

  <!-- Input area -->
  <div class="input-area">
    <button class="attach-btn" onclick={() => fileEl?.click()}>+</button>
    <textarea
      bind:this={inputEl}
      bind:value={input}
      onkeydown={handleKeyDown}
      oninput={handleInput}
      onblur={handleBlur}
      placeholder="Send a message..."
      rows={1}
      class="chat-input"
    ></textarea>
    <button
      onclick={handleSend}
      disabled={sending || (!input.trim() && pendingImages.length === 0)}
      class="send-btn"
      class:active={!!input.trim() || pendingImages.length > 0}
    >
      {sending ? "sending..." : "send"}
    </button>
  </div>
</div>

<style>
  .chat {
    display: flex;
    flex-direction: column;
    height: 100%;
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

  .channel-header .invite-btn {
    padding: 4px 12px;
    font-size: 11px;
    border-radius: var(--radius);
    background: var(--bg-3);
    color: var(--text-1);
    font-weight: 500;
  }

  .channel-header .invite-btn:hover {
    background: var(--accent-dim);
    color: var(--accent);
  }

  .messages {
    flex: 1;
    overflow: auto;
    padding: 16px 0;
  }

  .empty {
    color: var(--text-2);
    text-align: center;
    padding: 40px;
    font-size: 13px;
  }

  .error {
    color: var(--red);
  }

  .entry {
    display: flex;
    gap: 10px;
    margin-bottom: 16px;
    animation: fadeIn 0.2s ease both;
  }

  .sender {
    font-size: 11px;
    font-weight: 600;
    flex-shrink: 0;
    margin-top: 2px;
    text-transform: uppercase;
  }

  .sender-link {
    background: none;
    border: none;
    padding: 0;
    font: inherit;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    cursor: pointer;
  }

  .sender-link:hover {
    text-decoration: underline;
  }

  .entry-content {
    flex: 1;
    min-width: 0;
  }

  .user-text {
    color: var(--text-0);
    white-space: pre-wrap;
  }

  .chat-image {
    max-width: 300px;
    max-height: 200px;
    border-radius: var(--radius);
    margin-top: 4px;
  }

  .divider {
    display: flex;
    align-items: center;
    gap: 12px;
    margin: 20px 0;
    color: var(--text-2);
    font-size: 11px;
    letter-spacing: 0.03em;
  }

  .divider-line {
    flex: 1;
    height: 1px;
    background: var(--border);
  }

  .tool-block {
    margin-bottom: 8px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    overflow: hidden;
    font-size: 12px;
  }

  .tool-header {
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 10px;
    background: var(--bg-3);
    font-size: 12px;
    font-family: var(--mono);
    text-align: left;
  }

  .tool-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
    min-width: 0;
  }

  .tool-arrow {
    color: var(--text-2);
    margin-right: 6px;
  }

  .tool-status {
    color: var(--accent);
    font-size: 10px;
    flex-shrink: 0;
    margin-left: 8px;
  }

  .tool-status.error {
    color: var(--red);
  }

  .tool-detail {
    padding: 10px;
    background: var(--bg-1);
  }

  .tool-section-label {
    margin-bottom: 6px;
    color: var(--text-2);
  }

  .tool-pre {
    color: var(--text-1);
    white-space: pre-wrap;
    word-break: break-all;
    font-size: 11px;
    line-height: 1.5;
  }

  .tool-output {
    max-height: 200px;
    overflow: auto;
  }

  .tool-output.error {
    color: var(--red);
  }

  .image-strip {
    display: flex;
    gap: 8px;
    padding: 8px 0;
    border-top: 1px solid var(--border);
    overflow-x: auto;
  }

  .image-preview {
    position: relative;
    flex-shrink: 0;
  }

  .preview-thumb {
    height: 60px;
    border-radius: var(--radius);
    border: 1px solid var(--border);
  }

  .remove-image {
    position: absolute;
    top: -4px;
    right: -4px;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    background: var(--bg-3);
    color: var(--text-1);
    font-size: 11px;
    display: flex;
    align-items: center;
    justify-content: center;
    border: 1px solid var(--border);
    cursor: pointer;
    padding: 0;
  }

  .typing {
    padding: 4px 0;
    font-size: 12px;
    color: var(--text-2);
    animation: pulse 1.5s ease infinite;
  }

  .input-area {
    border-top: 1px solid var(--border);
    padding: 12px 0 0;
    display: flex;
    gap: 8px;
  }

  .attach-btn {
    padding: 0 10px;
    background: var(--bg-2);
    color: var(--text-1);
    border-radius: var(--radius);
    font-size: 16px;
    border: 1px solid var(--border);
    cursor: pointer;
    flex-shrink: 0;
  }

  .chat-input {
    flex: 1;
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 10px 12px;
    color: var(--text-0);
    font-family: var(--mono);
    font-size: 13px;
    resize: none;
    outline: none;
    overflow: hidden;
    transition: border-color 0.15s;
  }

  .chat-input:focus {
    border-color: var(--border-bright);
  }

  .send-btn {
    padding: 0 16px;
    background: var(--bg-3);
    color: var(--text-2);
    border-radius: var(--radius);
    font-size: 12px;
    font-weight: 500;
    transition: all 0.15s;
  }

  .send-btn.active {
    background: var(--accent-dim);
    color: var(--accent);
  }
</style>
