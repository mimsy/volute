<script lang="ts">
import type { FeedChatEvent } from "@volute/api";
import { renderMarkdown } from "@volute/ui/markdown";
import { formatDuration, formatTime } from "../../lib/feed-utils";
import { formatRelativeTime } from "../../lib/format";
import AvatarStack from "./AvatarStack.svelte";

let {
  event,
  onclick,
}: {
  event: FeedChatEvent;
  onclick: () => void;
} = $props();

let title = $derived.by(() => {
  if (event.conversationType === "channel" && event.channelName) return `#${event.channelName}`;
  const names = event.participants.map((p) => p.displayName ?? p.username);
  return names.length > 0 ? names.join(" & ") : "Conversation";
});

let meta = $derived(
  `${event.messageCount} message${event.messageCount === 1 ? "" : "s"} · ${formatDuration(event.startedAt, event.endedAt)}`,
);
</script>

<div
  class="feed-card card-chat"
  role="button"
  tabindex="0"
  {onclick}
  onkeydown={(e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onclick();
    }
  }}
>
  <div class="feed-card-header">
    <AvatarStack participants={event.participants} />
    <span class="feed-card-label">{title}</span>
    <span class="feed-card-meta">{formatRelativeTime(event.endedAt)}</span>
  </div>
  <div class="feed-card-body">
    {#each event.snippet as msg (msg.createdAt + (msg.senderName ?? ""))}
      <div class="snippet-entry">
        <div class="snippet-head">
          <span class="snippet-sender" class:user={msg.role === "user"}>
            {msg.senderName ?? (msg.role === "user" ? "user" : "mind")}
          </span>
          <span class="snippet-time">{formatTime(msg.createdAt)}</span>
        </div>
        <div class="snippet-text" class:user={msg.role === "user"}>
          {#if msg.role === "user"}
            {msg.text}
          {:else}
            <div class="markdown-body">{@html renderMarkdown(msg.text)}</div>
          {/if}
        </div>
      </div>
    {/each}
  </div>
  <div class="feed-card-foot">{meta}</div>
</div>

<style>
  .feed-card {
    background: var(--bg-0);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    display: flex;
    flex-direction: column;
    height: 240px;
    overflow: hidden;
    transition: border-color 0.15s;
    cursor: pointer;
  }

  .card-chat {
    border-color: color-mix(in srgb, var(--blue) 25%, var(--border));
  }

  .card-chat:hover {
    border-color: color-mix(in srgb, var(--blue) 50%, var(--border));
  }

  .feed-card-header {
    padding: 6px 10px;
    font-size: 13px;
    font-weight: 500;
    color: var(--text-1);
    border-bottom: 1px solid color-mix(in srgb, var(--blue) 25%, var(--border));
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .feed-card-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
    flex: 1;
  }

  .feed-card-meta {
    font-size: 11px;
    color: var(--text-2);
    font-weight: 400;
    flex-shrink: 0;
  }

  .feed-card-body {
    flex: 1;
    overflow: hidden;
    padding: 8px 12px;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .snippet-entry {
    min-width: 0;
  }

  .snippet-head {
    display: flex;
    align-items: baseline;
    gap: 6px;
  }

  .snippet-sender {
    font-size: 12px;
    font-weight: 600;
    color: var(--accent);
  }

  .snippet-sender.user {
    color: var(--blue);
  }

  .snippet-time {
    font-size: 11px;
    color: var(--text-2);
  }

  .snippet-text {
    font-family: var(--mono);
    font-size: 12px;
    color: var(--text-1);
    overflow: hidden;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
  }

  .snippet-text.user {
    color: var(--text-0);
    white-space: pre-wrap;
  }

  .feed-card-foot {
    padding: 5px 12px;
    font-size: 11px;
    color: var(--text-2);
    border-top: 1px solid var(--border);
    flex-shrink: 0;
  }
</style>
