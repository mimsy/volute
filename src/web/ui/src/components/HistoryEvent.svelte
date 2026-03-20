<script lang="ts">
import type { HistoryMessage, TurnActivity, TurnConversation } from "@volute/api";
import { tick } from "svelte";
import { fetchTurnEvents } from "../lib/client";
import { extractTextContent } from "../lib/feed-utils";
import { normalizeTimestamp } from "../lib/format";
import { renderMarkdown } from "../lib/markdown";
import ExtensionFeedCard from "./ExtensionFeedCard.svelte";
import HistoryEvent from "./HistoryEvent.svelte";

let {
  event,
  mindName,
  expandable = false,
  compact = false,
  turnConversations = [],
  turnActivities = [],
  onsessionclick,
  onexpand,
}: {
  event: HistoryMessage;
  mindName: string;
  expandable?: boolean;
  compact?: boolean;
  turnConversations?: TurnConversation[];
  turnActivities?: TurnActivity[];
  onsessionclick?: (session: string) => void;
  onexpand?: (expanded: boolean, el: HTMLDivElement | undefined) => void;
} = $props();

let expanded = $state(false);
let turnExpanded = $state(false);
let turnLoading = $state(false);
let turnError = $state("");
let turnEvents = $state<HistoryMessage[]>([]);
const typeColors: Record<string, string> = {
  inbound: "var(--red)",
  outbound: "var(--green)",
  text: "var(--blue)",
  tool_use: "var(--yellow)",
  tool_result: "var(--yellow)",
  thinking: "var(--purple)",
  usage: "var(--purple)",
  log: "var(--text-2)",
  session_start: "var(--accent)",
  done: "var(--text-2)",
  summary: "var(--text-0)",
};

let color = $derived(typeColors[event.type] ?? "var(--text-2)");
let meta = $derived.by(() => {
  if (!event.metadata) return null;
  try {
    return JSON.parse(event.metadata);
  } catch {
    return null;
  }
});

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

let eventEl: HTMLDivElement | undefined = $state();

async function handleClick() {
  if (event.type === "summary" && expandable) {
    turnExpanded = !turnExpanded;
    if (turnExpanded && turnEvents.length === 0) {
      // Prefer turn_id when available; fall back to legacy session+range
      const hasTurnId = !!event.turn_id;
      const hasLegacy = event.session && meta?.from_id && meta?.to_id;
      if (!hasTurnId && !hasLegacy) {
        turnError = "Missing turn data";
        return;
      }
      turnLoading = true;
      turnError = "";
      try {
        turnEvents = await fetchTurnEvents(
          mindName,
          hasTurnId
            ? { turnId: event.turn_id! }
            : { session: event.session!, fromId: meta.from_id, toId: meta.to_id },
        );
      } catch (e) {
        turnError = "Failed to load turn details";
        console.warn("Failed to fetch turn events:", e);
      } finally {
        turnLoading = false;
      }
    }
    if (turnExpanded) {
      await tick();
      eventEl?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
    onexpand?.(turnExpanded, eventEl);
  } else if (collapsible) {
    expanded = !expanded;
  }
}
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div
  class="event"
  class:collapsible
  class:expandable-summary={event.type === "summary" && expandable}
  class:turn-expanded={event.type === "summary" && turnExpanded}
  role={collapsible ? "button" : undefined}
  tabindex={collapsible ? 0 : undefined}
  onclick={handleClick}
  onkeydown={collapsible ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleClick(); } } : undefined}
  style:--type-color={color}
  bind:this={eventEl}
>
  <div class="marker" style:background={color}></div>
  {#if event.type === "summary" && turnExpanded}
    <div class="turn-connector"></div>
  {/if}

  {#if event.type === "summary"}
    {#if !compact || turnExpanded}
      <div class="summary-header" class:expanded={turnExpanded}>
        <div class="summary-header-line">
          {#if meta?.from_time && meta?.to_time}
            <span class="time">{formatTime(meta.from_time)} – {formatTime(meta.to_time)}</span>
          {:else}
            <span class="time">{formatTime(event.created_at)}</span>
          {/if}
          {#if expandable}
            <span class="chevron">{turnExpanded ? "▼" : "▶"}</span>
          {/if}
        </div>
        {#if event.session && !expandable}
          <button class="session-tag" onclick={(e) => { e.stopPropagation(); onsessionclick?.(event.session!); }}>
            {event.session}
          </button>
        {/if}
      </div>
    {/if}

    <div class="event-body">
      {#if expandable && turnExpanded}
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
        <div class="turn-branch" role="group" onclick={(e) => e.stopPropagation()}>
          {#if turnLoading}
            <div class="turn-loading">loading turn...</div>
          {:else if turnError}
            <div class="turn-loading">{turnError}</div>
          {:else}
            {#each turnEvents as turnEv (turnEv.id)}
              {@const linkedConvs = turnEv.type === "tool_use" ? turnConversations.filter((c) => c.messages.some((m) => m.source_event_id === turnEv.id)) : []}
              {@const linkedActs = turnEv.type === "tool_use" ? turnActivities.filter((a) => a.source_event_id === turnEv.id) : []}
              <div class="event-group" class:has-linked={linkedConvs.length > 0 || linkedActs.length > 0}>
                <HistoryEvent event={turnEv} {mindName} />
                {#each linkedConvs as conv (conv.id)}
                  <div class="linked-card">
                    <div class="linked-card-chat">
                      <div class="linked-card-header">
                        <svg class="linked-card-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h12v8H5l-3 3V3z"/></svg>
                        <span class="linked-card-label">{conv.label}</span>
                      </div>
                      {#each conv.messages.filter((m) => m.source_event_id === turnEv.id) as msg (msg.id)}
                        <div class="linked-card-msg">
                          <span class="linked-card-sender" class:linked-card-sender-user={msg.role === "user"}>{msg.sender_name ?? (msg.role === "user" ? "user" : mindName)}</span>
                          {extractTextContent(msg.content)}
                        </div>
                      {/each}
                    </div>
                  </div>
                {/each}
                {#each linkedActs as act (act.id)}
                  <div class="linked-card">
                    <ExtensionFeedCard
                      title={act.summary}
                      url={act.metadata?.slug ? `/minds/${typeof act.metadata?.author === 'string' ? act.metadata.author : mindName}/notes/${act.metadata.slug}` : ''}
                      date={act.created_at}
                      author={typeof act.metadata?.author === 'string' ? act.metadata.author : undefined}
                      bodyHtml={typeof act.metadata?.bodyHtml === 'string' ? act.metadata.bodyHtml : ''}
                      iframeUrl={typeof act.metadata?.iframeUrl === 'string' ? act.metadata.iframeUrl : undefined}
                      icon='<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 2h6l4 4v8H4V2z"/><path d="M10 2v4h4"/><path d="M6 9h6M6 12h4"/></svg>'
                      color={act.type === 'page_updated' ? 'purple' : 'yellow'}
                    />
                  </div>
                {/each}
              </div>
            {/each}
            <!-- Unlinked cards (no source_event_id) appear before the summary -->
            {#each turnConversations.filter((c) => c.messages.every((m) => !m.source_event_id || !turnEvents.some((e) => e.id === m.source_event_id))) as conv (conv.id)}
              <div class="linked-card">
                <div class="linked-card-chat">
                  <div class="linked-card-header">
                    <svg class="linked-card-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h12v8H5l-3 3V3z"/></svg>
                    <span class="linked-card-label">{conv.label}</span>
                  </div>
                  {#each conv.messages as msg (msg.id)}
                    <div class="linked-card-msg">
                      <span class="linked-card-sender" class:linked-card-sender-user={msg.role === "user"}>{msg.sender_name ?? (msg.role === "user" ? "user" : mindName)}</span>
                      {extractTextContent(msg.content)}
                    </div>
                  {/each}
                </div>
              </div>
            {/each}
            {#each turnActivities.filter((a) => !a.source_event_id || !turnEvents.some((e) => e.id === a.source_event_id)) as act (act.id)}
              <div class="linked-card">
                <ExtensionFeedCard
                  title={act.summary}
                  url={act.metadata?.slug ? `/minds/${typeof act.metadata?.author === 'string' ? act.metadata.author : mindName}/notes/${act.metadata.slug}` : ''}
                  date={act.created_at}
                  author={typeof act.metadata?.author === 'string' ? act.metadata.author : undefined}
                  bodyHtml=""
                  icon='<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 2h6l4 4v8H4V2z"/><path d="M10 2v4h4"/><path d="M6 9h6M6 12h4"/></svg>'
                  color={act.type === 'page_updated' ? 'purple' : 'yellow'}
                />
              </div>
            {/each}
          {/if}
          <button class="branch-summary" onclick={() => { turnExpanded = false; }}>
            <div class="event-header">
              <span class="time">{formatTime(event.created_at)}</span>
              <span class="type-badge" style:background="{color}15" style:color={color}>summary</span>
            </div>
            <span class="summary-text">{event.content}</span>
          </button>
          <div class="branch-return"></div>
        </div>
      {:else}
        <span class="summary-text">{event.content}</span>
      {/if}
    </div>
  {:else if event.type === "inbound" || event.type === "outbound"}
    <div class="compact-msg">
      <div class="compact-msg-header">
        <svg class="compact-msg-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h12v8H5l-3 3V3z"/></svg>
        {#if event.channel}<span class="compact-msg-channel">{event.channel}</span>{/if}
        <span class="compact-msg-time">{formatTime(event.created_at)}</span>
      </div>
      <div class="compact-msg-body">
        <span class="compact-msg-sender" class:compact-msg-sender-user={event.type === "inbound"}>{event.type === "inbound" ? (event.sender ?? "user") : mindName}</span>
        <span class="compact-msg-text">{event.content}</span>
      </div>
    </div>
  {:else}
    <div class="event-header">
      <span class="time">{formatTime(event.created_at)}</span>
      <span class="type-badge" style:background="{color}15" style:color={color}>{event.type}</span>
      {#if event.channel && (event.type === "inbound" || event.type === "outbound")}
        <span class="channel-tag">{event.channel}</span>
      {/if}
      {#if collapsible}
        <span class="chevron">{expanded ? "▼" : "▶"}</span>
      {/if}
    </div>

    <div class="event-body">
      {#if event.type === "text"}
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
      {:else if event.type === "done"}
        <span class="dim">processing complete</span>
      {:else}
        <span class="dim">{event.type}</span>
        {#if event.content}
          <span>{event.content}</span>
        {/if}
      {/if}
    </div>
  {/if}
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
    bottom: -20px;
    width: 2px;
    background: var(--type-color);
    opacity: 0;
    transition: opacity 0.15s;
    z-index: 1;
  }
  .event:hover::after {
    opacity: 1;
  }
  /* Expandable summaries: dashed rail */
  .event.expandable-summary::after,
  .event.turn-expanded::after {
    top: 20px;
    background: repeating-linear-gradient(
      to bottom,
      var(--timeline-rail) 0px,
      var(--timeline-rail) 4px,
      var(--bg-1) 4px,
      var(--bg-1) 8px
    );
    opacity: 1;
  }
  .event.expandable-summary:hover::after,
  .event.turn-expanded:hover::after {
    background: repeating-linear-gradient(
      to bottom,
      var(--type-color) 0px,
      var(--type-color) 4px,
      var(--bg-1) 4px,
      var(--bg-1) 8px
    );
  }
  .event.collapsible {
    cursor: pointer;
  }

  .summary-header {
    margin-bottom: 4px;
  }
  .summary-header.expanded {
    margin-left: 14px;
  }
  .summary-header-line {
    display: flex;
    align-items: center;
    gap: 8px;
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
    color: var(--text-0);
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

  /* Sub-rail: vertical line from dot to event bottom, at sub-rail X position */
  .turn-connector {
    position: absolute;
    top: 15px;
    left: 22px;
    width: 2px;
    bottom: 12px;
    background: var(--border);
  }
  /* Horizontal connector from main rail dot to sub-rail */
  .turn-connector::after {
    content: "";
    position: absolute;
    top: 0;
    left: -23px;
    width: 23px;
    height: 2px;
    background: var(--border);
  }
  /* Highlight whole subtrack on summary-header or branch-summary hover */
  .event:has(.summary-header:hover, .branch-summary:hover) .turn-connector,
  .event:has(.summary-header:hover, .branch-summary:hover) .turn-connector::after,
  .event:has(.summary-header:hover, .branch-summary:hover) .branch-return {
    background: var(--text-0);
  }

  .turn-branch {
    position: relative;
    margin-left: -5px;
    padding-left: 9px;
    padding-bottom: 8px;
  }
  /* Return connector from sub-rail back to main rail */
  .branch-return {
    position: absolute;
    bottom: 6px;
    left: -16px;
    width: 24px;
    height: 2px;
    background: var(--border);
  }

  .branch-summary {
    position: relative;
    padding: 6px 8px 6px 20px;
    cursor: pointer;
    width: 100%;
    background: none;
    border: none;
    text-align: left;
    font: inherit;
    color: inherit;
  }
  /* Dot on the sub-rail for the summary at end of branch */
  .branch-summary::before {
    content: "";
    position: absolute;
    left: -5px;
    top: 12px;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--text-0);
    z-index: 1;
  }

  /* Event group: wraps an event + its linked cards */
  .event-group {
    position: relative;
  }
  /* Group-level rail highlight — covers event + linked cards */
  .event-group.has-linked::after {
    content: "";
    position: absolute;
    left: -2px;
    top: 12px;
    bottom: -20px;
    width: 2px;
    background: var(--yellow);
    opacity: 0;
    transition: opacity 0.15s;
    z-index: 1;
  }
  .event-group.has-linked:hover::after {
    opacity: 1;
  }
  /* Suppress the inner event's own highlight when in a group */
  .event-group.has-linked > :global(.event::after) {
    display: none;
  }

  /* Linked feed cards inline with turn events */
  .linked-card {
    margin: 4px 0 4px 20px;
    max-width: 480px;
  }
  .linked-card-chat {
    background: var(--bg-0);
    border: 1px solid color-mix(in srgb, var(--blue) 25%, var(--border));
    border-radius: var(--radius-lg);
    overflow: hidden;
    font-size: 13px;
  }
  .linked-card-header {
    padding: 4px 8px;
    font-weight: 500;
    color: var(--text-1);
    border-bottom: 1px solid color-mix(in srgb, var(--blue) 25%, var(--border));
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .linked-card-icon {
    width: 12px;
    height: 12px;
    color: var(--blue);
    flex-shrink: 0;
  }
  .linked-card-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .linked-card-msg {
    padding: 2px 8px;
    font-family: var(--mono);
    font-size: 12px;
  }
  .linked-card-sender {
    font-weight: 600;
    color: var(--accent);
    margin-right: 6px;
  }
  .linked-card-sender-user {
    color: var(--blue);
  }

  /* Inbound/outbound message card */
  .compact-msg {
    background: var(--bg-0);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    overflow: hidden;
  }
  .compact-msg-header {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    font-size: 13px;
    font-weight: 500;
    color: var(--text-1);
    border-bottom: 1px solid var(--border);
  }
  .compact-msg-icon {
    width: 12px;
    height: 12px;
    color: var(--blue);
    flex-shrink: 0;
  }
  .compact-msg-channel {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .compact-msg-time {
    font-size: 11px;
    color: var(--text-2);
    font-weight: 400;
    margin-left: auto;
    flex-shrink: 0;
  }
  .compact-msg-body {
    padding: 6px 10px;
    font-family: var(--mono);
    font-size: 13px;
    line-height: 1.5;
  }
  .compact-msg-sender {
    font-size: 12px;
    font-weight: 600;
    color: var(--accent);
    margin-right: 6px;
  }
  .compact-msg-sender-user {
    color: var(--blue);
  }
  .compact-msg-text {
    color: var(--text-0);
  }
</style>
