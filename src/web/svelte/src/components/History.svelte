<script lang="ts">
import { fetchHistory, fetchHistoryChannels, type HistoryMessage } from "../lib/api";
import { renderMarkdown } from "../lib/markdown";

let { name }: { name: string } = $props();

const PAGE_SIZE = 50;

let messages = $state<HistoryMessage[]>([]);
let channels = $state<string[]>([]);
let channel = $state("");
let hasMore = $state(true);
let loading = $state(false);

async function load(offset: number) {
  loading = true;
  try {
    const rows = await fetchHistory(name, {
      channel: channel || undefined,
      limit: PAGE_SIZE,
      offset,
    });
    if (offset === 0) {
      messages = rows;
    } else {
      messages = [...messages, ...rows];
    }
    hasMore = rows.length === PAGE_SIZE;
  } catch {
    // ignore
  }
  loading = false;
}

$effect(() => {
  fetchHistoryChannels(name)
    .then((ch) => {
      channels = ch;
    })
    .catch(() => {});
});

$effect(() => {
  // Re-load when channel changes (tracked by reading `channel`)
  void channel;
  load(0);
});

function formatTime(dateStr: string): string {
  const date = new Date(dateStr);
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
</script>

<div class="history">
  <!-- Filters -->
  <div class="filters">
    <select bind:value={channel} class="channel-select">
      <option value="">all channels</option>
      {#each channels as ch}
        <option value={ch}>{ch}</option>
      {/each}
    </select>
  </div>

  <!-- Messages -->
  <div class="messages">
    {#if messages.length === 0 && !loading}
      <div class="empty">No messages found.</div>
    {/if}
    {#each messages as msg (msg.id)}
      {@const isMind = msg.sender === name}
      <div class="entry">
        <div class="entry-row">
          <span class="sender" class:mind={isMind} class:user={!isMind}>
            {!isMind ? (msg.sender ?? "user") : "mind"}
          </span>
          <div class="content">
            {#if !isMind}
              <div class="user-text">{msg.content}</div>
            {:else}
              <div class="markdown-body">
                {@html renderMarkdown(msg.content)}
              </div>
            {/if}
          </div>
          <div class="meta">
            <span class="time">{formatTime(msg.created_at)}</span>
            <span class="channel-tag">{msg.channel}</span>
          </div>
        </div>
      </div>
    {/each}
    {#if hasMore}
      <div class="load-more">
        <button
          onclick={() => load(messages.length)}
          disabled={loading}
          class="load-more-btn"
          style:opacity={loading ? 0.5 : 1}
        >
          {loading ? "loading..." : "load more"}
        </button>
      </div>
    {/if}
  </div>
</div>

<style>
  .history {
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow: hidden;
  }

  .filters {
    display: flex;
    gap: 12px;
    padding: 0 0 12px;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }

  .channel-select {
    background: var(--bg-2);
    color: var(--text-0);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 4px 8px;
    font-size: 12px;
    font-family: var(--mono);
  }

  .messages {
    flex: 1;
    overflow: auto;
    padding-top: 12px;
  }

  .empty {
    color: var(--text-2);
    text-align: center;
    padding: 40px;
    font-size: 13px;
  }

  .entry {
    margin-bottom: 16px;
    animation: fadeIn 0.2s ease both;
  }

  .entry-row {
    display: flex;
    gap: 10px;
  }

  .sender {
    font-size: 11px;
    font-weight: 600;
    flex-shrink: 0;
    margin-top: 2px;
    text-transform: uppercase;
  }

  .sender.mind {
    color: var(--accent);
  }

  .sender.user {
    color: var(--blue);
  }

  .content {
    flex: 1;
    min-width: 0;
  }

  .user-text {
    color: var(--text-0);
    white-space: pre-wrap;
  }

  .meta {
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 2px;
  }

  .time {
    font-size: 10px;
    color: var(--text-2);
  }

  .channel-tag {
    font-size: 10px;
    color: var(--text-2);
    background: var(--bg-3);
    padding: 1px 6px;
    border-radius: var(--radius);
  }

  .load-more {
    padding: 16px 0;
    text-align: center;
  }

  .load-more-btn {
    padding: 6px 16px;
    background: var(--bg-3);
    color: var(--text-1);
    border-radius: var(--radius);
    font-size: 12px;
  }
</style>
