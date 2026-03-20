<script lang="ts">
import type { HistoryMessage, TurnActivity, TurnConversation } from "@volute/api";
import { tick } from "svelte";
import { fetchTurnEvents } from "../lib/client";
import { normalizeTimestamp } from "../lib/format";
import { renderMarkdown } from "../lib/markdown";
import { groupToolEvents } from "../lib/tool-groups";
import { getToolCategory } from "../lib/tool-names";
import ExtensionFeedCard from "./ExtensionFeedCard.svelte";
import HistoryEvent from "./HistoryEvent.svelte";
import ToolGroupComponent from "./ToolGroup.svelte";

const defaultActivityIcon =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 2h6l4 4v8H4V2z"/><path d="M10 2v4h4"/><path d="M6 9h6M6 12h4"/></svg>';

function activityColor(act: TurnActivity): string {
  return typeof act.metadata?.color === "string" ? act.metadata.color : "yellow";
}

function activityIcon(act: TurnActivity): string {
  return typeof act.metadata?.icon === "string" ? act.metadata.icon : defaultActivityIcon;
}

function activityUrl(act: TurnActivity, mindName: string): string {
  if (typeof act.metadata?.iframeUrl === "string") return act.metadata.iframeUrl;
  if (typeof act.metadata?.slug === "string") {
    const author = typeof act.metadata?.author === "string" ? act.metadata.author : mindName;
    return `/minds/${author}/notes/${act.metadata.slug}`;
  }
  return "";
}

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
let detailEvents = $state<HistoryMessage[]>([]);
let fullDetail = $state(false);
let detailLoading = $state(false);
const typeColors: Record<string, string> = {
  inbound: "var(--blue)",
  outbound: "var(--blue)",
  text: "var(--blue)",
  tool_use: "var(--yellow)",
  tool_result: "var(--yellow)",
  thinking: "var(--purple)",
  usage: "var(--purple)",
  log: "var(--text-2)",
  session_start: "var(--accent)",
  done: "var(--text-2)",
  summary: "var(--text-0)",
  activity: "var(--yellow)",
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
  {#if event.type === "inbound" || event.type === "outbound"}
    <div class="marker marker-icon" style:color="var(--blue)">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h12v8H5l-3 3V3z"/></svg>
    </div>
  {:else if event.type === "text"}
    <div class="marker marker-icon" style:color="var(--blue)">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4h10M3 8h7M3 12h9"/></svg>
    </div>
  {:else if event.type === "thinking"}
    <div class="marker marker-icon" style:color="var(--purple)">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12C1.5 12 0 10.5 0 8.5 0 7 1 5.5 2.5 5 2.5 3 4 1.5 6 1.5c1.5 0 2.8.8 3.3 2 .4-.2.8-.3 1.2-.3 1.7 0 3 1.3 3 3 1.2.4 2.5 1.4 2.5 3 0 1.7-1.3 3.8-3.5 3.8H4z"/></svg>
    </div>
  {:else if event.type === "tool_use" || event.type === "tool_result"}
    {@const toolMeta = meta}
    {@const toolName = typeof toolMeta?.name === "string" ? toolMeta.name : "tool"}
    {@const cat = getToolCategory(toolName)}
    <div class="marker marker-icon" style:color={cat === "shell" ? "var(--red)" : cat === "file" ? "var(--blue)" : cat === "search" ? "var(--yellow)" : cat === "web" ? "var(--purple)" : "var(--text-1)"}>
      {#if cat === "shell"}
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5l4 3-4 3"/><path d="M9 12h4"/></svg>
      {:else if cat === "file"}
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 2h6l4 4v8H4V2z"/><path d="M10 2v4h4"/></svg>
      {:else if cat === "search"}
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="7" cy="7" r="4"/><path d="M10 10l3 3"/></svg>
      {:else if cat === "web"}
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6"/><path d="M2 8h12"/><path d="M8 2c2 2 3 4 3 6s-1 4-3 6"/><path d="M8 2c-2 2-3 4-3 6s1 4 3 6"/></svg>
      {:else}
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="10" height="10" rx="1"/><path d="M6 6h4M6 8h4M6 10h2"/></svg>
      {/if}
    </div>
  {:else if event.type === "activity"}
    {@const actMeta = meta}
    {@const actColor = typeof actMeta?.color === "string" ? `var(--${actMeta.color})` : "var(--yellow)"}
    <div class="marker marker-icon" style:color={actColor}>
      {#if typeof actMeta?.icon === "string"}
        {@html actMeta.icon}
      {:else}
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 2h6l4 4v8H4V2z"/><path d="M10 2v4h4"/><path d="M6 9h6M6 12h4"/></svg>
      {/if}
    </div>
  {:else}
    <div class="marker" style:background={color}></div>
  {/if}
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
          {#if turnExpanded}
            <button class="detail-toggle" onclick={async (e) => {
              e.stopPropagation();
              if (!fullDetail && detailEvents.length === 0) {
                detailLoading = true;
                try {
                  const hasTurnId = !!event.turn_id;
                  const hasLegacy = event.session && meta?.from_id && meta?.to_id;
                  if (hasTurnId || hasLegacy) {
                    detailEvents = await fetchTurnEvents(
                      mindName,
                      hasTurnId
                        ? { turnId: event.turn_id!, detail: true }
                        : { session: event.session!, fromId: meta.from_id, toId: meta.to_id, detail: true },
                    );
                  }
                } catch (err) {
                  console.warn("Failed to fetch detail events:", err);
                } finally {
                  detailLoading = false;
                }
              }
              fullDetail = !fullDetail;
            }}>
              {detailLoading ? "loading..." : fullDetail ? "grouped" : "detail"}
            </button>
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
          {:else if fullDetail}
            {#each detailEvents as ev (ev.id)}
              <HistoryEvent event={ev} {mindName} />
            {/each}
          {:else}
            {@const items = groupToolEvents(turnEvents, turnConversations, turnActivities)}
            {#each items as item (item.kind === "tool-group" ? `tg-${item.toolUse.id}` : `ev-${item.event.id}`)}
              {#if item.kind === "tool-group"}
                {@const catColor = item.category === "shell" ? "var(--red)" : item.category === "file" ? "var(--blue)" : item.category === "search" ? "var(--yellow)" : item.category === "web" ? "var(--purple)" : "var(--text-1)"}
                <div class="tool-group-wrapper">
                  <div class="marker marker-icon" style:color={catColor}>
                    {#if item.category === "shell"}
                      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5l4 3-4 3"/><path d="M9 12h4"/></svg>
                    {:else if item.category === "file"}
                      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 2h6l4 4v8H4V2z"/><path d="M10 2v4h4"/></svg>
                    {:else if item.category === "search"}
                      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="7" cy="7" r="4"/><path d="M10 10l3 3"/></svg>
                    {:else if item.category === "web"}
                      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6"/><path d="M2 8h12"/><path d="M8 2c2 2 3 4 3 6s-1 4-3 6"/><path d="M8 2c-2 2-3 4-3 6s1 4 3 6"/></svg>
                    {:else}
                      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="10" height="10" rx="1"/><path d="M6 6h4M6 8h4M6 10h2"/></svg>
                    {/if}
                  </div>
                  <ToolGroupComponent group={item} {mindName} turnStatus="complete" />
                </div>
              {:else}
                <HistoryEvent event={item.event} {mindName} />
              {/if}
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
  {:else if event.type === "activity"}
    {@const actMeta = meta}
    <div class="activity-card">
      <ExtensionFeedCard
        title={event.content}
        url={activityUrl({ type: actMeta?.type ?? "", metadata: actMeta } as TurnActivity, mindName)}
        date={event.created_at}
        author={typeof actMeta?.author === 'string' ? actMeta.author : undefined}
        bodyHtml={typeof actMeta?.bodyHtml === 'string' ? actMeta.bodyHtml : ''}
        iframeUrl={typeof actMeta?.iframeUrl === 'string' ? actMeta.iframeUrl : undefined}
        icon={typeof actMeta?.icon === 'string' ? actMeta.icon : defaultActivityIcon}
        color={typeof actMeta?.color === 'string' ? actMeta.color : 'yellow'}
      />
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

  .marker-icon {
    width: 18px;
    height: 18px;
    left: -10px;
    top: 7px;
    border-radius: var(--radius);
    background: var(--bg-1);
    border: 1px solid var(--border);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 3;
  }

  .marker-icon svg {
    width: 11px;
    height: 11px;
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

  .detail-toggle {
    font-size: 11px;
    color: var(--text-2);
    background: var(--bg-3);
    border: 1px solid var(--border);
    padding: 1px 6px;
    border-radius: var(--radius);
    cursor: pointer;
    font-family: var(--mono);
    margin-left: auto;
  }
  .detail-toggle:hover {
    background: var(--bg-2);
    color: var(--text-0);
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

  /* Tool group wrapper: positions marker like a regular event */
  .tool-group-wrapper {
    position: relative;
    padding: 4px 8px 4px 20px;
  }
  .tool-group-wrapper > .marker-icon {
    left: -10px;
    top: 9px;
  }

  /* Activity card */
  .activity-card {
    max-width: 480px;
  }

  /* Inbound/outbound message card */
  .compact-msg {
    background: var(--bg-0);
    border: 1px solid color-mix(in srgb, var(--blue) 25%, var(--border));
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
    border-bottom: 1px solid color-mix(in srgb, var(--blue) 25%, var(--border));
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
