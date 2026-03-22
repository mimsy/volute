<script lang="ts">
import type { HistoryMessage, TurnActivity, TurnConversation } from "@volute/api";
import { tick } from "svelte";
import { fetchTurnEvents } from "../lib/client";
import { normalizeTimestamp } from "../lib/format";
import { renderMarkdown } from "../lib/markdown";
import { groupToolEvents } from "../lib/tool-groups";
import {
  getCategoryColor,
  getCategoryIcon,
  getToolCategory,
  getToolLabel,
} from "../lib/tool-names";
import ToolGroupComponent from "./chat/ToolGroup.svelte";
import ExtensionFeedCard from "./ExtensionFeedCard.svelte";
import HistoryEvent from "./HistoryEvent.svelte";
import Icon from "./ui/Icon.svelte";

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
  outbound: "var(--red)",
  text: "var(--text-1)",
  tool_use: "var(--yellow)",
  tool_result: "var(--yellow)",
  thinking: "var(--text-2)",
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
  event.type === "inbound" ||
    event.type === "outbound" ||
    event.type === "activity" ||
    event.type === "text" ||
    event.type === "thinking" ||
    event.type === "tool_use" ||
    event.type === "tool_result" ||
    (event.type === "summary" && expandable) ||
    !!event.content,
);

let tooltip = $derived.by(() => {
  const time = formatTime(event.created_at);
  const type = event.type;
  if (type === "tool_use" || type === "tool_result") {
    const name = meta?.name ?? "tool";
    return `${time} · ${name}`;
  }
  if (type === "inbound" || type === "outbound") {
    const ch = event.channel ? ` · ${event.channel}` : "";
    return `${time} · ${type}${ch}`;
  }
  if (type === "activity") {
    return `${time} · ${meta?.type ?? "activity"}`;
  }
  return `${time} · ${type}`;
});

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
  {#if event.type === "inbound"}
    <div class="marker marker-icon" style:color="var(--blue)"><span class="marker-tooltip">{tooltip}</span><Icon kind="chat" /></div>
  {:else if event.type === "outbound"}
    <div class="marker marker-icon" style:color="var(--red)"><span class="marker-tooltip">{tooltip}</span><Icon kind="chat" /></div>
  {:else if event.type === "text"}
    <div class="marker marker-icon" style:color="var(--text-1)"><span class="marker-tooltip">{tooltip}</span><Icon kind="text" /></div>
  {:else if event.type === "thinking"}
    <div class="marker marker-icon" style:color="var(--text-2)"><span class="marker-tooltip">{tooltip}</span><Icon kind="thinking" /></div>
  {:else if event.type === "tool_use" || event.type === "tool_result"}
    {@const toolMeta = meta}
    {@const toolName = typeof toolMeta?.name === "string" ? toolMeta.name : "tool"}
    {@const cat = getToolCategory(toolName)}
    <div class="marker marker-icon" style:color={getCategoryColor(cat)}><span class="marker-tooltip">{tooltip}</span><Icon kind={getCategoryIcon(cat)} /></div>
  {:else if event.type === "activity"}
    {@const actMeta = meta}
    {@const actColor = typeof actMeta?.color === "string" ? `var(--${actMeta.color})` : "var(--yellow)"}
    <div class="marker marker-icon" style:color={actColor}><span class="marker-tooltip">{tooltip}</span>
      {#if typeof actMeta?.icon === "string"}
        {@html actMeta.icon}
      {:else}
        <Icon kind="document-lines" />
      {/if}
    </div>
  {:else}
    <div class="marker" style:background={color}><span class="marker-tooltip">{tooltip}</span></div>
  {/if}
  {#if event.type === "summary" && turnExpanded}
    <div class="turn-connector"></div>
  {/if}

  {#if event.type === "summary"}
    {#if turnExpanded}
      <div class="summary-header">
        <div class="summary-header-line">
          {#if meta?.from_time && meta?.to_time}
            <span class="time">{formatTime(meta.from_time)} – {formatTime(meta.to_time)}</span>
          {:else}
            <span class="time">{formatTime(event.created_at)}</span>
          {/if}
          <button class="detail-toggle" class:detail-active={fullDetail} onclick={async (e) => {
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
            {#if detailLoading}
              …
            {:else}
              <Icon kind="search" />
            {/if}
            <span class="marker-tooltip">{fullDetail ? "show grouped" : "show all events"}</span>
          </button>
        </div>
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
            {#each detailEvents.filter((e) => e.type !== "summary") as ev (ev.id)}
              <HistoryEvent event={ev} {mindName} />
            {/each}
          {:else}
            {@const items = groupToolEvents(turnEvents)}
            {#each items as item (item.kind === "tool-group" ? `tg-${item.toolUse.id}` : `ev-${item.event.id}`)}
              {#if item.kind === "tool-group"}
                {@const catColor = getCategoryColor(item.category)}
                {@const catIcon = getCategoryIcon(item.category)}
                {@const toolTooltip = `${formatTime(item.toolUse.created_at)} · ${item.toolName}`}
                <div class="event" style:--type-color={catColor}>
                  <div class="marker marker-icon" style:color={catColor}>
                    <span class="marker-tooltip">{toolTooltip}</span>
                    <Icon kind={catIcon} />
                  </div>
                  <ToolGroupComponent group={item} {mindName} turnStatus="complete" />
                </div>
              {:else}
                <HistoryEvent event={item.event} {mindName} />
              {/if}
            {/each}
          {/if}
          <button class="branch-summary" onclick={() => { turnExpanded = false; }}>
            <div class="marker marker-icon branch-summary-marker" style:color="var(--text-0)"><Icon kind="spiral" /></div>
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
    {@const actColor = typeof actMeta?.color === "string" ? `var(--${actMeta.color})` : "var(--yellow)"}
    {#if expanded}
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
    {:else}
      <span class="inline-text" style:color={actColor}>{event.content}</span>
    {/if}
  {:else if event.type === "inbound" || event.type === "outbound"}
    {#if expanded}
      <div class="compact-msg">
        <div class="compact-msg-header">
          <svg class="compact-msg-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h12v8H5l-3 3V3z"/></svg>
          {#if event.channel}<span class="compact-msg-channel">{event.channel}</span>{/if}
        </div>
        <div class="compact-msg-body">
          <span class="compact-msg-sender" class:compact-msg-sender-user={event.type === "inbound"}>{event.type === "inbound" ? (event.sender ?? "user") : mindName}</span>
          <span class="compact-msg-text">{event.content}</span>
        </div>
      </div>
    {:else}
      <span class="inline-text inline-text-chat">{#if event.channel}<span class="inline-channel">[{event.channel}]</span>{" "}{/if}<span class="inline-sender" class:inline-sender-user={event.type === "inbound"} class:inline-sender-mind={event.type === "outbound"}>{event.type === "inbound" ? (event.sender ?? "user") : mindName}:</span>{" "}{event.content}</span>
    {/if}
  {:else}
    <div class="event-body">
      {#if event.type === "text"}
        <div class="inline-text dim" class:inline-text-expanded={expanded}>
          <div class="markdown-body">{@html renderMarkdown(event.content)}</div>
        </div>
      {:else if event.type === "tool_use"}
        <span class="inline-text" class:inline-text-expanded={expanded}>{getToolLabel(meta?.name ?? "tool", event.content)}{#if expanded && event.content}{"\n"}{formatArgs(event.content)}{/if}</span>
      {:else if event.type === "tool_result"}
        <span class="inline-text" class:inline-text-expanded={expanded} class:error={meta?.is_error}>{event.content}</span>
      {:else if event.type === "thinking"}
        <span class="inline-text dim" class:inline-text-expanded={expanded}>{event.content}</span>
      {:else if event.type === "usage"}
        <span class="inline-text dim">↑{meta?.input_tokens ?? 0} ↓{meta?.output_tokens ?? 0}{#if meta?.model} {meta.model}{/if}</span>
      {:else if event.type === "session_start"}
        <span class="inline-text dim">session started{#if event.session} {event.session}{/if}</span>
      {:else if event.type === "done"}
        <span class="inline-text dim">processing complete</span>
      {:else}
        <span class="inline-text dim">{event.type}{#if event.content} {event.content}{/if}</span>
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
    margin-left: 14px;
  }
  .summary-header-line {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .time {
    font-size: 11px;
    color: var(--text-2);
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
    width: 22px;
    height: 22px;
    left: -12px;
    top: 5px;
    border-radius: var(--radius);
    background: var(--bg-1);
    border: 1px solid var(--border);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 3;
  }

  .marker-icon :global(svg) {
    width: 13px;
    height: 13px;
  }

  .marker-tooltip {
    position: absolute;
    right: calc(100% + 6px);
    top: 50%;
    transform: translateY(-50%);
    padding: 3px 8px;
    background: var(--bg-3);
    color: var(--text-0);
    font-family: var(--sans);
    font-size: 11px;
    border-radius: var(--radius);
    white-space: nowrap;
    pointer-events: none;
    opacity: 0;
    transition: opacity 0.15s;
    border: 1px solid var(--border);
    z-index: 20;
  }

  .marker-icon:hover .marker-tooltip {
    opacity: 1;
  }

  /* Inline compact text for collapsed events */
  .inline-text {
    font-family: var(--mono);
    font-size: 13px;
    color: var(--text-1);
    line-height: 1.5;
    overflow: hidden;
    display: -webkit-box;
    -webkit-line-clamp: 4;
    -webkit-box-orient: vertical;
    white-space: pre-wrap;
    word-break: break-word;
    margin: 0;
  }
  .inline-text-expanded {
    -webkit-line-clamp: unset;
    display: block;
    max-height: 400px;
    overflow: auto;
  }
  .inline-channel {
    color: var(--text-2);
  }
  .inline-sender {
    font-weight: 600;
    color: var(--accent);
  }
  .inline-sender-user {
    color: var(--blue);
  }
  .inline-sender-mind {
    color: var(--red);
  }
  .inline-text-chat {
    color: var(--text-0);
  }





  .event-body {
    font-family: var(--mono);
    font-size: 13px;
    line-height: 1.5;
  }
  .event-body :global(.markdown-body p:last-child) {
    margin-bottom: 0;
  }
  .event-body .dim :global(.markdown-body) {
    color: var(--text-1);
  }
  .event-body :global(.markdown-body) {
    line-height: 1.5;
  }


  .dim {
    color: var(--text-2);
  }
  .error {
    color: var(--red);
  }

  .detail-toggle {
    position: relative;
    color: var(--text-2);
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
    display: flex;
    align-items: center;
    width: 14px;
    height: 14px;
  }
  .detail-toggle :global(svg) {
    width: 14px;
    height: 14px;
  }
  .detail-toggle:hover {
    color: var(--text-0);
  }
  .detail-toggle.detail-active {
    color: var(--accent);
  }
  .detail-toggle:hover .marker-tooltip {
    opacity: 1;
  }
  .detail-toggle .marker-tooltip {
    left: 50%;
    top: calc(100% + 6px);
    transform: translateX(-50%);
  }

  .summary-text {
    font-size: 13px;
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
  .branch-summary-marker {
    left: -12px;
    top: 5px;
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
