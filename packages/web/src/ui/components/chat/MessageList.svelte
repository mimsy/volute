<script lang="ts">
import type { Mind, Participant } from "@volute/api";
import { normalizeTimestamp } from "../../lib/format";
import type { ChatEntry } from "../../lib/types";
import MessageEntry from "./MessageEntry.svelte";

let {
  entries,
  loadError = "",
  hasMore = false,
  loadingOlder = false,
  onLoadOlder,
  minds = [],
  participants = [],
  onOpenMind,
  typingNames = [],
}: {
  entries: ChatEntry[];
  loadError?: string;
  hasMore?: boolean;
  loadingOlder?: boolean;
  onLoadOlder?: () => void;
  minds?: Mind[];
  participants?: Participant[];
  onOpenMind?: (mind: Mind) => void;
  typingNames?: string[];
} = $props();

let scrollEl: HTMLDivElement;
let openTools = $state<Set<number>>(new Set());
let wasAtBottom = true;

let mindsByName = $derived(new Map(minds.map((m) => [m.name, m])));

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

// While a sender is typing, their trailing message group carries the dot in its
// header instead of a standalone typing line below the messages.
let typingDotIndex = $derived.by(() => {
  const last = entries[entries.length - 1];
  if (!last?.senderName || !typingNames.includes(last.senderName)) return -1;
  let i = entries.length - 1;
  while (i > 0 && entries[i - 1].senderName === last.senderName) i--;
  return i;
});

let standaloneTypingNames = $derived(
  typingDotIndex === -1
    ? typingNames
    : typingNames.filter((n) => n !== entries[typingDotIndex].senderName),
);

function showSenderHeader(i: number): boolean {
  if (i === 0) return true;
  const prev = entries[i - 1];
  const cur = entries[i];
  if (prev.senderName !== cur.senderName) return true;
  if (prev.senderName === "system") return true;
  return false;
}

function getDateStr(dateStr?: string): string {
  if (!dateStr) return "";
  try {
    const d = new Date(normalizeTimestamp(dateStr));
    return d.toLocaleDateString();
  } catch {
    return "";
  }
}

function showDate(i: number): boolean {
  const cur = entries[i];
  if (!cur.createdAt) return false;
  if (i === 0) return true;
  const prev = entries[i - 1];
  return getDateStr(cur.createdAt) !== getDateStr(prev.createdAt);
}

function getSenderColor(entry: ChatEntry): string {
  if (entry.role === "user") {
    return entry.senderName ? (colorMap.get(entry.senderName) ?? "var(--blue)") : "var(--blue)";
  }
  return entry.senderName ? (colorMap.get(entry.senderName) ?? "var(--accent)") : "var(--accent)";
}

function toggleTool(key: number) {
  const next = new Set(openTools);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  openTools = next;
}

export function scrollToBottom(force?: boolean) {
  // Capture scroll state now, before DOM updates shift the position
  const shouldScroll = force || wasAtBottom;
  // Double-rAF ensures DOM is fully rendered before scrolling
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (!scrollEl || !shouldScroll) return;
      scrollEl.scrollTop = scrollEl.scrollHeight;
    });
  });
}

export function resetToolState() {
  openTools = new Set();
}

// Keep scroll pinned to bottom when the container resizes (e.g. side panel opens)
$effect(() => {
  if (!scrollEl) return;
  const ro = new ResizeObserver(() => {
    if (wasAtBottom) {
      scrollEl.scrollTop = scrollEl.scrollHeight;
    }
  });
  ro.observe(scrollEl);
  return () => ro.disconnect();
});

function handleScroll() {
  if (!scrollEl) return;
  wasAtBottom = scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight < 100;
  if (!hasMore || loadingOlder || !onLoadOlder) return;
  if (scrollEl.scrollTop < 100) {
    onLoadOlder();
  }
}
</script>

<div class="messages" bind:this={scrollEl} onscroll={handleScroll}>
  {#if loadingOlder}
    <div class="loading-older">Loading older messages...</div>
  {/if}
  {#if hasMore && !loadingOlder}
    <div class="load-more">
      <button class="load-more-btn" onclick={onLoadOlder}>Load older messages</button>
    </div>
  {/if}
  {#if loadError}
    <div class="empty error">{loadError}</div>
  {:else if entries.length === 0}
    <div class="empty">Send a message to start chatting.</div>
  {/if}
  {#each entries as entry, i (entry.id)}
    <!-- Sender-less automated announcement (#687): a #system event, not a chat message -->
    {#if entry.role === "event"}
      <div class="event-row">
        {#each entry.blocks as block, bi (bi)}
          {#if block.type === "text"}<span>{block.text}</span>{/if}
        {/each}
      </div>
    <!-- System divider -->
    {:else if entry.senderName === "system" && entry.blocks.length === 1 && entry.blocks[0].type === "text" && entry.blocks[0].text.match(/^\[.+\]$/)}
      <div class="divider">
        <div class="divider-line"></div>
        <span>{entry.blocks[0].text.slice(1, -1)}</span>
        <div class="divider-line"></div>
      </div>
    {:else}
      <MessageEntry
        role={entry.role}
        blocks={entry.blocks}
        senderName={entry.senderName}
        createdAt={entry.createdAt}
        showHeader={showSenderHeader(i)}
        showDate={showDate(i)}
        senderColor={getSenderColor(entry)}
        entryIndex={i}
        {openTools}
        onToggleTool={toggleTool}
        {mindsByName}
        {participants}
        {onOpenMind}
        showTypingDot={i === typingDotIndex}
      />
    {/if}
  {/each}
  {#each standaloneTypingNames as name (name)}
    {@const mind = mindsByName.get(name)}
    {@const displayName =
      mind?.displayName ?? participants.find((p) => p.username === name)?.displayName ?? name}
    {@const color = colorMap.get(name) ?? (mind ? "var(--accent)" : "var(--blue)")}
    <div class="typing-entry">
      {#if mind}
        <button class="typing-sender typing-sender-link" style:color onclick={() => onOpenMind?.(mind)}>{displayName}</button>
      {:else}
        <span class="typing-sender" style:color>{displayName}</span>
      {/if}
      <span class="typing-dot" class:iridescent={!!mind}></span>
    </div>
  {/each}
</div>

<style>
  .messages {
    flex: 1;
    overflow: auto;
    padding: 16px;
  }

  .empty {
    color: var(--text-2);
    text-align: center;
    padding: 40px;
    font-size: 14px;
  }

  .error {
    color: var(--red);
  }

  .loading-older {
    text-align: center;
    padding: 8px;
    font-size: 13px;
    color: var(--text-2);
  }

  .load-more {
    text-align: center;
    padding: 8px;
  }

  .load-more-btn {
    font-size: 13px;
    color: var(--text-2);
    background: none;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 4px 12px;
    cursor: pointer;
  }

  .load-more-btn:hover {
    color: var(--text-1);
    border-color: var(--border-bright);
  }

  .event-row {
    text-align: center;
    margin: 12px 0;
    color: var(--text-2);
    font-size: 13px;
    font-style: italic;
  }

  .divider {
    display: flex;
    align-items: center;
    gap: 12px;
    margin: 20px 0;
    color: var(--text-2);
    font-size: 12px;
    letter-spacing: 0.03em;
  }

  .divider-line {
    flex: 1;
    height: 1px;
    background: var(--border);
  }

  /* Mirrors MessageEntry's .entry-header/.sender so a typing sender reads as an
     incoming message header, with the dot sitting where the timestamp would be. */
  .typing-entry {
    display: flex;
    align-items: baseline;
    gap: 8px;
    margin-top: 12px;
    animation: fadeIn 0.2s ease both;
  }

  .typing-sender {
    font-size: 14px;
    font-weight: 600;
  }

  .typing-sender-link {
    background: none;
    border: none;
    padding: 0;
    font: inherit;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
  }

  .typing-sender-link:hover {
    text-decoration: underline;
  }

  .typing-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    flex-shrink: 0;
    background: var(--text-3);
    animation: typing-pulse 1.5s ease infinite;
  }

  .typing-dot.iridescent {
    background: none;
    animation: iridescent 3s ease-in-out infinite;
  }
</style>
