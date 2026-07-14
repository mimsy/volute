<script lang="ts">
// Trimmed fork of packages/web/src/ui/components/HistoryEvent.svelte.
// Changes vs. upstream: turn events come synchronously from fixture-events
// (no fetch, no loading/error states), the show-all-events detail toggle is
// removed, cards don't navigate, and `initialExpanded` pre-opens a turn.

import { tick } from "svelte";
import { getTurnEvents } from "./fixture-events";
import { formatClockTime } from "./format";
import HistoryEvent from "./HistoryEvent.svelte";
import Icon from "./Icon.svelte";
import { renderMarkdown } from "./markdown";
import { sanitizeSvg } from "./sanitize";
import TimelineCard from "./TimelineCard.svelte";
import ToolGroupComponent from "./ToolGroup.svelte";
import { historyEventCardModel, systemEventLabel } from "./timeline-card";
import { groupToolEvents } from "./tool-groups";
import { getCategoryColor, getCategoryIcon, getToolCategory, getToolLabel } from "./tool-names";
import { tooltip as tooltipAction } from "./tooltip";
import { isEventTriggeredTurn } from "./turn-events";
import type { HistoryMessage } from "./types";

let {
  event,
  mindName,
  expandable = false,
  reflection = false,
  initialExpanded = false,
  onexpand,
}: {
  event: HistoryMessage;
  mindName: string;
  expandable?: boolean;
  /**
   * True for the mind's closing text on a system-event turn. Nothing was sent to anyone —
   * the text is kept as a private reflection — so it's labelled as such rather than reading
   * like a reply to a message.
   */
  reflection?: boolean;
  initialExpanded?: boolean;
  onexpand?: (expanded: boolean, el: HTMLDivElement | undefined) => void;
} = $props();

let expanded = $state(false);
// svelte-ignore state_referenced_locally — deliberate initial capture
let turnExpanded = $state(initialExpanded);
// svelte-ignore state_referenced_locally — deliberate initial capture
let turnEvents = $state<HistoryMessage[]>(initialExpanded ? getTurnEvents(event.turn_id) : []);
const typeColors: Record<string, string> = {
  inbound: "var(--blue)",
  outbound: "var(--red)",
  // A system event is not a message — it never gets the inbound blue or a chat bubble.
  event: "var(--purple)",
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

let eventLabel = $derived(systemEventLabel(meta, event.channel));

/** Non-null exactly for the card tier (inbound/outbound/event/activity). */
let cardModel = $derived(historyEventCardModel(event, meta, mindName));

let collapsible = $derived(
  event.type === "inbound" ||
    event.type === "outbound" ||
    event.type === "event" ||
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
  if (type === "event") {
    return `${time} · system event · ${eventLabel}`;
  }
  if (type === "activity") {
    return `${time} · ${meta?.type ?? "activity"}`;
  }
  return `${time} · ${type}`;
});

/**
 * The id of the last `text` row in a turn. On a system-event turn that row is the mind's
 * closing thought, stored as a private reflection (it was delivered nowhere), so the
 * timeline labels it rather than letting it read as a reply.
 */
function lastTextId(events: HistoryMessage[]): number | undefined {
  let id: number | undefined;
  for (const e of events) if (e.type === "text") id = e.id;
  return id;
}

function formatTime(dateStr: string): string {
  return formatClockTime(dateStr);
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
      turnEvents = getTurnEvents(event.turn_id);
    }
    if (turnExpanded) {
      await tick();
      eventEl?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
    onexpand?.(turnExpanded, eventEl);
  } else if (collapsible) {
    expanded = !expanded;
  }
}
</script>

<div
  class="event"
  class:collapsible
  class:expandable-summary={event.type === "summary" && expandable}
  class:turn-expanded={event.type === "summary" && turnExpanded}
  role="button"
  tabindex="0"
  onclick={handleClick}
  onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleClick(); } }}
  style:--type-color={color}
  bind:this={eventEl}
>
  {#if event.type === "inbound"}
    <div class="marker marker-icon" style:color="var(--blue)" use:tooltipAction={{ text: tooltip, position: "left" }}><Icon kind="chat" /></div>
  {:else if event.type === "outbound"}
    <div class="marker marker-icon" style:color="var(--red)" use:tooltipAction={{ text: tooltip, position: "left" }}><Icon kind="chat" /></div>
  {:else if event.type === "event"}
    <!-- Gear, never the chat icon: an event comes from the environment, not a person. -->
    <div class="marker marker-icon" style:color="var(--purple)" use:tooltipAction={{ text: tooltip, position: "left" }}><Icon kind="gear" /></div>
  {:else if event.type === "text"}
    <div class="marker marker-icon" style:color="var(--text-1)" use:tooltipAction={{ text: tooltip, position: "left" }}><Icon kind="text" /></div>
  {:else if event.type === "thinking"}
    <div class="marker marker-icon" style:color="var(--text-2)" use:tooltipAction={{ text: tooltip, position: "left" }}><Icon kind="thinking" /></div>
  {:else if event.type === "tool_use" || event.type === "tool_result"}
    {@const toolMeta = meta}
    {@const toolName = typeof toolMeta?.name === "string" ? toolMeta.name : "tool"}
    {@const cat = getToolCategory(toolName)}
    <div class="marker marker-icon" style:color={getCategoryColor(cat)} use:tooltipAction={{ text: tooltip, position: "left" }}><Icon kind={getCategoryIcon(cat)} /></div>
  {:else if event.type === "activity"}
    {@const actMeta = meta}
    {@const actColor = typeof actMeta?.color === "string" ? `var(--${actMeta.color})` : "var(--yellow)"}
    <div class="marker marker-icon" style:color={actColor} use:tooltipAction={{ text: tooltip, position: "left" }}>
      {#if typeof actMeta?.icon === "string"}
        {@html sanitizeSvg(actMeta.icon)}
      {:else}
        <Icon kind="document-lines" />
      {/if}
    </div>
  {:else}
    <div class="marker" style:background={color} use:tooltipAction={{ text: tooltip, position: "left" }}></div>
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
        </div>
      </div>
    {/if}
    <div class="event-body">
      {#if expandable && turnExpanded}
        {@const items = groupToolEvents(turnEvents)}
        {@const isEventTurn = isEventTriggeredTurn(turnEvents)}
        {@const lastText = lastTextId(turnEvents)}
        <div class="turn-branch" role="presentation" onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.stopPropagation()}>
          {#each items as item (item.kind === "tool-group" ? `tg-${item.toolUse.id}` : `ev-${item.event.id}`)}
            {#if item.kind === "tool-group"}
              {@const catColor = getCategoryColor(item.category)}
              {@const catIcon = getCategoryIcon(item.category)}
              {@const toolTooltip = `${formatTime(item.toolUse.created_at)} · ${item.toolName}`}
              <div class="event" style:--type-color={catColor}>
                <div class="marker marker-icon" style:color={catColor} use:tooltipAction={{ text: toolTooltip, position: "left" }}>
                  <Icon kind={catIcon} />
                </div>
                <ToolGroupComponent group={item} {mindName} turnStatus="complete" />
              </div>
            {:else}
              <HistoryEvent event={item.event} {mindName} reflection={isEventTurn && item.event.id === lastText} />
            {/if}
          {/each}
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
  {:else if cardModel}
    {@const m = cardModel}
    <!--
      Card tier: inbound/outbound messages, system events, activities. One shared card
      shell; the per-type distinctions (icon, accent, meta) live in the card model. A
      system event still reads as environment, not chat: gear icon, "system event" tag,
      no sender, no channel.
    -->
    {#if expanded}
      <div class="card-wrap">
        <TimelineCard
          title={m.title}
          color={m.color}
          icon={m.icon}
          iconKind={m.iconKind}
          meta={m.meta}
          time={formatTime(event.created_at)}
          body={m.body}
          oncollapse={() => (expanded = false)}
        />
      </div>
    {:else if event.type === "activity"}
      <span class="inline-text inline-preview" style:color="var(--{m.color})">{event.content}</span>
    {:else if event.type === "event"}
      <span class="inline-text inline-text-event inline-preview"><span class="inline-event-label">{eventLabel}</span>{" "}{event.content}</span>
    {:else}
      <span class="inline-text inline-text-chat inline-preview">{#if event.channel}<span class="inline-channel">[{event.channel}]</span>{" "}{/if}<span class="inline-sender" class:inline-sender-user={event.type === "inbound"} class:inline-sender-mind={event.type === "outbound"}>{event.type === "inbound" ? (event.sender ?? "user") : mindName}:</span>{" "}{event.content}</span>
    {/if}
  {:else}
    <div class="event-body">
      {#if event.type === "text"}
        {#if reflection}
          <div class="reflection-label">reflection · private</div>
        {/if}
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
        <span class="inline-text dim">session started{#if event.thread} {event.thread}{/if}</span>
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
  /* Expandable summaries: solid rail when collapsed, dashed when expanded */
  .event.expandable-summary::after {
    top: 20px;
    background: var(--timeline-rail);
    opacity: 1;
  }
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
  .event.expandable-summary:hover:not(:has(.turn-branch:hover))::after {
    background: var(--type-color);
  }
  .event.turn-expanded:hover:not(:has(.turn-branch:hover))::after {
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

  /* Inline compact text for collapsed events */
  .inline-text {
    font-family: var(--mono);
    font-size: 13px;
    color: var(--text-1);
    line-height: 1.5;
    overflow: hidden;
    display: -webkit-box;
    -webkit-line-clamp: 4;
    line-clamp: 4;
    -webkit-box-orient: vertical;
    white-space: pre-wrap;
    word-break: break-word;
    margin: 0;
  }
  .inline-text-expanded {
    -webkit-line-clamp: unset;
    line-clamp: unset;
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

  .summary-text {
    font-size: 13px;
    color: var(--text-0);
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

  /* Expanded card-tier item (shared TimelineCard) */
  .card-wrap {
    max-width: 480px;
  }

  /* Collapsed card-tier items clamp to a single consistent preview line */
  .inline-preview {
    -webkit-line-clamp: 1;
    line-clamp: 1;
  }

  .inline-text-event {
    color: var(--text-1);
  }
  .inline-event-label {
    font-size: 12px;
    font-weight: 600;
    color: var(--purple);
  }
  .reflection-label {
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--purple);
    margin-bottom: 2px;
  }
</style>
