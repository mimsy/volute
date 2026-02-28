<script lang="ts">
import type { ContentBlock, Mind } from "@volute/api";
import MessageEntry from "./MessageEntry.svelte";

type ChatEntry = {
  id: number;
  role: "user" | "assistant";
  blocks: ContentBlock[];
  senderName?: string;
  createdAt?: string;
};

let {
  entries,
  loadError = "",
  hasMore = false,
  loadingOlder = false,
  onLoadOlder,
  minds = [],
  onOpenMind,
}: {
  entries: ChatEntry[];
  loadError?: string;
  hasMore?: boolean;
  loadingOlder?: boolean;
  onLoadOlder?: () => void;
  minds?: Mind[];
  onOpenMind?: (mind: Mind) => void;
} = $props();

let scrollEl: HTMLDivElement;
let openTools = $state<Set<number>>(new Set());

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

function showSenderHeader(i: number): boolean {
  if (i === 0) return true;
  const prev = entries[i - 1];
  const cur = entries[i];
  if (prev.senderName !== cur.senderName) return true;
  if (prev.senderName === "system") return true;
  return false;
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

export function resetToolState() {
  openTools = new Set();
}

function handleScroll() {
  if (!scrollEl || !hasMore || loadingOlder || !onLoadOlder) return;
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
    <!-- System divider -->
    {#if entry.senderName === "system" && entry.blocks.length === 1 && entry.blocks[0].type === "text" && entry.blocks[0].text.match(/^\[.+\]$/)}
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
        senderColor={getSenderColor(entry)}
        entryIndex={i}
        {openTools}
        onToggleTool={toggleTool}
        {mindsByName}
        {onOpenMind}
      />
    {/if}
  {/each}
</div>

<style>
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

  .loading-older {
    text-align: center;
    padding: 8px;
    font-size: 12px;
    color: var(--text-2);
  }

  .load-more {
    text-align: center;
    padding: 8px;
  }

  .load-more-btn {
    font-size: 12px;
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
</style>
