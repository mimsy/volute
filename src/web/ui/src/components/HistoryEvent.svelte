<script lang="ts">
import type { HistoryMessage } from "@volute/api";
import { fetchTurnEvents } from "../lib/client";
import { normalizeTimestamp } from "../lib/format";
import { renderMarkdown } from "../lib/markdown";
import HistoryEvent from "./HistoryEvent.svelte";

let {
  event,
  mindName,
  expandable = false,
  onsessionclick,
}: {
  event: HistoryMessage;
  mindName: string;
  expandable?: boolean;
  onsessionclick?: (session: string) => void;
} = $props();

let expanded = $state(false);
let turnExpanded = $state(false);
let turnLoading = $state(false);
let turnEvents = $state<HistoryMessage[]>([]);

const typeColors: Record<string, string> = {
  inbound: "var(--blue)",
  outbound: "var(--accent)",
  text: "var(--accent)",
  tool_use: "var(--yellow)",
  tool_result: "var(--yellow)",
  thinking: "var(--text-2)",
  usage: "var(--purple)",
  log: "var(--text-2)",
  session_start: "var(--accent)",
  done: "var(--text-2)",
  summary: "var(--green)",
};

let color = $derived(typeColors[event.type] ?? "var(--text-2)");
let meta = $derived(event.metadata ? JSON.parse(event.metadata) : null);

let collapsible = $derived(
  (event.type === "tool_use" && !!event.content) ||
    (event.type === "tool_result" && !!event.content) ||
    (event.type === "thinking" && !!event.content) ||
    (event.type === "summary" && expandable),
);

function formatTime(dateStr: string): string {
  const date = new Date(normalizeTimestamp(dateStr));
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function truncate(str: string, len: number): string {
  if (!str || str.length <= len) return str ?? "";
  return `${str.slice(0, len)}...`;
}

function formatArgs(args: unknown): string {
  if (typeof args === "string") {
    try {
      return JSON.stringify(JSON.parse(args), null, 2);
    } catch {
      return args;
    }
  }
  return JSON.stringify(args, null, 2);
}

async function handleClick() {
  if (event.type === "summary" && expandable) {
    turnExpanded = !turnExpanded;
    if (turnExpanded && turnEvents.length === 0) {
      turnLoading = true;
      try {
        turnEvents = await fetchTurnEvents(mindName, event.session!, meta.from_id, meta.to_id);
      } finally {
        turnLoading = false;
      }
    }
  } else if (collapsible) {
    expanded = !expanded;
  }
}
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="event"
  class:collapsible
  onclick={handleClick}
  style:--type-color={color}
>
  <div class="marker" style:background={color}></div>

  <div class="event-header">
    <span class="time">{formatTime(event.created_at)}</span>
    <span class="type-badge" style:background="{color}15" style:color={color}>{event.type}</span>
    {#if event.channel && (event.type === "inbound" || event.type === "outbound")}
      <span class="channel-tag">{event.channel}</span>
    {/if}
    {#if collapsible}
      <span class="chevron">{(event.type === "summary" ? turnExpanded : expanded) ? "▼" : "▶"}</span>
    {/if}
  </div>

  <div class="event-body">
    {#if event.type === "inbound"}
      <span class="sender inbound">{event.sender ?? "user"}</span>
      <div class="user-text">{event.content}</div>
    {:else if event.type === "outbound"}
      <span class="sender outbound">mind</span>
      <div class="markdown-body">
        {@html renderMarkdown(event.content)}
      </div>
    {:else if event.type === "text"}
      <div class="markdown-body">
        {@html renderMarkdown(event.content)}
      </div>
    {:else if event.type === "tool_use"}
      <span class="summary">[{meta?.name ?? "tool"}]</span>
      {#if expanded && event.content}
        <pre class="detail">{formatArgs(event.content)}</pre>
      {/if}
    {:else if event.type === "tool_result"}
      {#if !expanded}
        <span class="summary" class:error={meta?.is_error}>{truncate(event.content, 80)}</span>
      {:else}
        <pre class="detail" class:error={meta?.is_error}>{event.content}</pre>
      {/if}
    {:else if event.type === "thinking"}
      {#if !expanded}
        <span class="summary dim">{truncate(event.content, 80)}</span>
      {:else}
        <div class="detail-text dim">{event.content}</div>
      {/if}
    {:else if event.type === "usage"}
      <span class="usage-line">
        ↑{meta?.input_tokens ?? 0} ↓{meta?.output_tokens ?? 0}
        {#if meta?.model}
          <span class="model">{meta.model}</span>
        {/if}
      </span>
    {:else if event.type === "session_start"}
      <span class="dim">session started</span>
      {#if event.session}
        <span class="session-id">{event.session}</span>
      {/if}
    {:else if event.type === "summary"}
      {#if expandable && turnExpanded}
        <div class="turn-branch">
          <div class="branch-header">
            <span class="summary-text">{event.content}</span>
            {#if meta?.from_time && meta?.to_time}
              <span class="time-range">{formatTime(meta.from_time)} – {formatTime(meta.to_time)}</span>
            {/if}
            {#if event.session}
              <button class="session-tag" onclick={(e) => { e.stopPropagation(); onsessionclick?.(event.session!); }}>
                {event.session}
              </button>
            {/if}
          </div>
          {#if turnLoading}
            <div class="turn-loading">loading turn...</div>
          {:else}
            {#each turnEvents as turnEv (turnEv.id)}
              <HistoryEvent event={turnEv} {mindName} />
            {/each}
          {/if}
        </div>
      {:else}
        <span class="summary-text">{event.content}</span>
        {#if meta?.from_time && meta?.to_time}
          <span class="time-range">{formatTime(meta.from_time)} – {formatTime(meta.to_time)}</span>
        {/if}
        {#if event.session}
          <button class="session-tag" onclick={(e) => { e.stopPropagation(); onsessionclick?.(event.session!); }}>
            {event.session}
          </button>
        {/if}
      {/if}
    {:else if event.type === "done"}
      <span class="dim">processing complete</span>
    {:else}
      <span class="dim">{event.type}</span>
      {#if event.content}
        <span>{event.content}</span>
      {/if}
    {/if}
  </div>
</div>

<style>
  .event {
    position: relative;
    padding: 6px 8px 6px 20px;
    animation: fadeIn 0.2s ease both;
  }
  .event::after {
    content: "";
    position: absolute;
    left: -2px;
    top: 12px;
    bottom: -12px;
    width: 2px;
    background: var(--type-color);
    opacity: 0;
    transition: opacity 0.15s;
    z-index: 1;
  }
  .event:hover::after {
    opacity: 1;
  }
  .event.collapsible {
    cursor: pointer;
  }

  .marker {
    position: absolute;
    left: -5px;
    top: 12px;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    z-index: 1;
  }

  .event-header {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 4px;
  }

  .time {
    font-size: 11px;
    color: var(--text-2);
    flex-shrink: 0;
  }

  .type-badge {
    font-size: 11px;
    padding: 1px 6px;
    border-radius: 12px;
    font-weight: 500;
  }

  .channel-tag {
    font-size: 11px;
    color: var(--text-2);
    background: var(--bg-3);
    padding: 1px 6px;
    border-radius: var(--radius);
  }

  .chevron {
    font-size: 9px;
    color: var(--text-2);
  }

  .event-body {
    font-family: var(--mono);
    font-size: 14px;
    line-height: 1.6;
  }

  .sender {
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    margin-right: 8px;
  }
  .sender.inbound {
    color: var(--blue);
  }
  .sender.outbound {
    color: var(--accent);
  }

  .user-text {
    display: inline;
    white-space: pre-wrap;
    color: var(--text-0);
  }

  .summary {
    font-size: 13px;
    color: var(--text-1);
  }
  .summary.error {
    color: var(--red);
  }

  .dim {
    color: var(--text-2);
  }

  .detail,
  .detail-text {
    margin-top: 6px;
    font-size: 12px;
    background: var(--bg-3);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 8px 10px;
    overflow-x: auto;
    max-height: 400px;
    overflow-y: auto;
    white-space: pre-wrap;
    word-break: break-all;
  }
  .detail {
    font-family: var(--mono);
  }
  .detail.error {
    color: var(--red);
    border-color: var(--red-dim);
  }
  .detail-text {
    color: var(--text-2);
  }

  .usage-line {
    font-size: 13px;
    color: var(--purple);
  }
  .model {
    color: var(--text-2);
    margin-left: 6px;
    font-size: 12px;
  }

  .session-id {
    font-size: 12px;
    color: var(--text-1);
    font-weight: 600;
    margin-left: 4px;
  }
  .summary-text {
    font-size: 13px;
    color: var(--green);
  }
  .time-range {
    font-size: 11px;
    color: var(--text-2);
    margin-left: 8px;
  }

  .session-tag {
    font-size: 11px;
    color: var(--text-1);
    background: var(--bg-3);
    border: 1px solid var(--border);
    padding: 1px 6px;
    border-radius: var(--radius);
    cursor: pointer;
    margin-left: 8px;
    font-family: var(--mono);
  }
  .session-tag:hover {
    background: var(--bg-2);
    color: var(--text-0);
  }

  .turn-loading {
    font-size: 12px;
    color: var(--text-2);
    padding: 8px 0 8px 16px;
    font-style: italic;
  }

  .turn-branch {
    position: relative;
    margin-top: 4px;
    margin-left: -13px;
    padding-left: 9px;
  }
  /* Sub-rail vertical line — extends up to connect with summary dot */
  .turn-branch::before {
    content: "";
    position: absolute;
    left: 7px;
    top: -8px;
    bottom: 0;
    width: 2px;
    background: var(--border);
  }
  /* Horizontal connector from main rail dot to sub-rail */
  .turn-branch::after {
    content: "";
    position: absolute;
    top: -8px;
    left: -8px;
    width: 17px;
    height: 2px;
    background: var(--border);
  }

  .branch-header {
    position: relative;
    padding: 2px 8px 2px 11px;
  }
  /* Dot on the sub-rail for the summary */
  .branch-header::before {
    content: "";
    position: absolute;
    left: -5px;
    top: 6px;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--green);
    z-index: 1;
  }
</style>
