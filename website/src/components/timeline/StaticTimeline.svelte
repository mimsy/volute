<script lang="ts">
// Static fork of packages/web/src/ui/components/TurnTimeline.svelte.
// Changes vs. upstream: hand-authored `items` replace all data loading (no SSE,
// no fetches, no liveness sweep, no paging), summary drill-downs come from the
// `summaryChildren`/`summaryDirectEvents` props, peeks don't navigate or open
// modals, and the status terminus is prop-driven. Markup and CSS for the
// rendered tiers are kept verbatim where possible.

import { SvelteMap, SvelteSet } from "svelte/reactivity";
import { extractTextContent } from "./feed-utils";
import { formatClockTime } from "./format";
import HistoryEvent from "./HistoryEvent.svelte";
import Icon from "./Icon.svelte";
import { renderMarkdown } from "./markdown";
import { activityColor, activityPeekBody, peekKey, shouldRenderPeek } from "./peek";
import { formatPeriodTime } from "./period-format";
import SummaryNode from "./SummaryNode.svelte";
import { sanitizeSvg } from "./sanitize";
import TimelineCard from "./TimelineCard.svelte";
import type { HistoryMessage, SummaryRow, TimelineItem, TurnRow } from "./types";

let {
  items,
  name,
  statusLabel,
  statusColor,
  defaultExpandedTurnId,
  summaryChildren,
  summaryDirectEvents,
}: {
  items: TimelineItem[];
  name: string;
  /** Rendered as "{name} is {statusLabel}" at the timeline terminus. */
  statusLabel: string;
  statusColor: string;
  /** This turn renders pre-expanded on load. */
  defaultExpandedTurnId?: string;
  /** Children revealed when a summary row is clicked (keyed by summary id). */
  summaryChildren: Map<number, SummaryRow[] | TurnRow[]>;
  /** Direct event drill-down for single-turn summaries (keyed by summary id). */
  summaryDirectEvents: Map<number, HistoryMessage[]>;
} = $props();

let expandedSummaries = new SvelteMap<number, SummaryRow[] | TurnRow[]>();
let directEventsSummaries = new SvelteMap<number, HistoryMessage[]>();
const loadingChildren = new SvelteSet<number>();

// svelte-ignore state_referenced_locally — deliberate initial capture
let expandedTurns = $state(new Set<string>(defaultExpandedTurnId ? [defaultExpandedTurnId] : []));

// Peek popovers (collapsed-turn hover cards) render markdown, so their content
// is mounted lazily on first hover and then kept (frozen) — same as upstream.
const revealedPeeks = new SvelteSet<string>();
function revealPeek(key: string) {
  revealedPeeks.add(key);
}

function toggleSummaryExpand(summary: SummaryRow) {
  if (expandedSummaries.has(summary.id) || directEventsSummaries.has(summary.id)) {
    expandedSummaries.delete(summary.id);
    directEventsSummaries.delete(summary.id);
    return;
  }
  const direct = summaryDirectEvents.get(summary.id);
  if (direct) {
    directEventsSummaries.set(summary.id, direct);
    return;
  }
  expandedSummaries.set(summary.id, summaryChildren.get(summary.id) ?? []);
}

function handleExpand(turnId: string, expanded: boolean) {
  if (expanded) {
    expandedTurns.add(turnId);
  } else {
    expandedTurns.delete(turnId);
  }
  expandedTurns = new Set(expandedTurns);
}
</script>

<div class="turn-timeline">
  <div class="turn-scroll">
    <div class="turn-track">
      {#each items as item (item.kind === "turn" ? `turn-${item.turn.id}` : item.kind === "summary" ? `summary-${item.summary.id}` : `sep-${item.above}-${item.below}`)}
        {#if item.kind === "separator"}
          <div class="turn-row scale-break-row">
            <div class="turn-time"></div>
            <div class="scale-break-container">
              <div class="scale-break-slash"></div>
              <div class="scale-break-gap"></div>
              <div class="scale-break-slash"></div>
              <div class="scale-break-label scale-break-label-above">
                <svg class="scale-break-arrow" viewBox="0 0 8 5"><path d="M4 0L8 5H0z" fill="currentColor"/></svg>
                <span>{item.above}</span>
              </div>
              <div class="scale-break-label scale-break-label-below">
                <svg class="scale-break-arrow" viewBox="0 0 8 5"><path d="M4 5L0 0h8z" fill="currentColor"/></svg>
                <span>{item.below}</span>
              </div>
            </div>
            <div class="turn-body"></div>
          </div>
        {:else if item.kind === "summary"}
          {@const summary = item.summary}
          {@const isExpanded = expandedSummaries.has(summary.id) || directEventsSummaries.has(summary.id)}
          <div class="turn-row" data-summary-id={summary.id}>
            <div class="turn-time"></div>
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div
              class="turn-rail"
              class:turn-rail-expanded={isExpanded}
              onclick={() => toggleSummaryExpand(summary)}
              onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleSummaryExpand(summary); } }}
            >
              <div class="turn-dot summary-dot"></div>
            </div>
            <div class="turn-body">
              <div class="turn-summary">
                <SummaryNode
                  {summary}
                  {expandedSummaries}
                  {directEventsSummaries}
                  {loadingChildren}
                  {toggleSummaryExpand}
                  {formatPeriodTime}
                />
              </div>
            </div>
          </div>
        {:else}
          {@const turn = item.turn}
          {@const peekCount = (!expandedTurns.has(turn.id) && turn.status !== "active") ? turn.conversations.length + turn.events.length + turn.activities.length : 0}
          <div class="turn-row" data-turn-id={turn.id} style:min-height={peekCount > 0 ? `${36 + peekCount * 48}px` : undefined}>
            <div class="turn-time">
              {formatClockTime(turn.created_at)}
            </div>
            <div
              class="turn-rail"
              class:turn-rail-expanded={expandedTurns.has(turn.id)}
              role="button"
              tabindex="0"
              onclick={(e) => {
                if (!turn.summary) return;
                e.stopPropagation();
                const rowEl = (e.currentTarget as HTMLElement).closest('.turn-row');
                const summaryEl = rowEl?.querySelector(':scope > .turn-body > .turn-summary > .event');
                if (summaryEl) (summaryEl as HTMLElement).click();
              }}
              onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); (e.currentTarget as HTMLElement).click(); } }}
            >
              <div class="turn-dot"></div>
              {#if !expandedTurns.has(turn.id) && (turn.conversations.length > 0 || turn.events.length > 0 || turn.activities.length > 0)}
                <div class="turn-peek-icons">
                  {#each turn.conversations as conv (conv.id)}
                    {@const chatKey = peekKey("chat", turn.id, conv.id)}
                    <div class="peek-anchor">
                      <button class="peek-btn" aria-label="View conversation" onmouseenter={() => revealPeek(chatKey)} onfocus={() => revealPeek(chatKey)} onclick={(e) => e.stopPropagation()}>
                        <Icon kind="chat" />
                      </button>
                      <div class="peek-popover">
                        {#if shouldRenderPeek(revealedPeeks, chatKey)}
                          <TimelineCard title={conv.label} color="blue" iconKind="chat" meta={`${conv.messages.length} msg${conv.messages.length === 1 ? '' : 's'}`}>
                            <div class="peek-msgs">
                              {#each conv.messages.slice(-5) as msg (msg.id)}
                                <div class="peek-msg">
                                  <span class="peek-msg-sender" class:peek-msg-sender-user={msg.role === "user"}>{msg.sender_name ?? (msg.role === "user" ? "user" : turn.mind)}</span>
                                  {#if msg.role === "assistant"}
                                    <span class="peek-msg-md markdown-body">{@html renderMarkdown(extractTextContent(msg.content))}</span>
                                  {:else}
                                    <span>{extractTextContent(msg.content)}</span>
                                  {/if}
                                </div>
                              {/each}
                            </div>
                          </TimelineCard>
                        {/if}
                      </div>
                    </div>
                  {/each}
                  <!--
                    System events peek with a gear, not the chat icon, and their card has no
                    sender: an event comes from the environment, not a person.
                  -->
                  {#each turn.events as evt (evt.id)}
                    {@const evtKey = peekKey("system-event", turn.id, String(evt.id))}
                    <div class="peek-anchor">
                      <button class="peek-btn" style:color="var(--purple)" aria-label="View system event" onmouseenter={() => revealPeek(evtKey)} onfocus={() => revealPeek(evtKey)} onclick={(e) => e.stopPropagation()}>
                        <Icon kind="gear" />
                      </button>
                      <div class="peek-popover">
                        {#if shouldRenderPeek(revealedPeeks, evtKey)}
                          <TimelineCard title={evt.label} color="purple" iconKind="gear" meta="system event" body={{ kind: "text", text: evt.content ?? "" }} />
                        {/if}
                      </div>
                    </div>
                  {/each}
                  {#each turn.activities as act (act.id)}
                    {@const actKey = peekKey("activity", turn.id, act.id)}
                    {@const actColor = activityColor(act.metadata)}
                    {@const actIcon = typeof act.metadata?.icon === 'string' ? sanitizeSvg(act.metadata.icon) : ''}
                    <div class="peek-anchor">
                      <button class="peek-btn" style:color="var(--{actColor})" aria-label="View activity" onmouseenter={() => revealPeek(actKey)} onfocus={() => revealPeek(actKey)} onclick={(e) => e.stopPropagation()}>
                        {#if actIcon}
                          {@html actIcon}
                        {:else}
                          <Icon kind="document-lines" />
                        {/if}
                      </button>
                      <div class="peek-popover">
                        {#if shouldRenderPeek(revealedPeeks, actKey)}
                          <TimelineCard
                            title={act.summary}
                            color={actColor}
                            icon={typeof act.metadata?.icon === 'string' ? act.metadata.icon : undefined}
                            iconKind={typeof act.metadata?.icon === 'string' ? undefined : "document-lines"}
                            body={activityPeekBody(act.metadata)}
                          />
                        {/if}
                      </div>
                    </div>
                  {/each}
                </div>
              {/if}
            </div>
            <div class="turn-body">
              <div class="turn-summary">
                {#if turn.summary}
                  <HistoryEvent
                    event={{
                      id: 0,
                      mind: turn.mind,
                      channel: "",
                      thread: null,
                      sender: null,
                      message_id: null,
                      type: "summary",
                      content: turn.summary,
                      metadata: turn.summary_meta ? JSON.stringify(turn.summary_meta) : null,
                      turn_id: turn.id,
                      created_at: turn.created_at,
                    }}
                    mindName={turn.mind}
                    expandable
                    initialExpanded={turn.id === defaultExpandedTurnId}
                    onexpand={(expanded) => handleExpand(turn.id, expanded)}
                  />
                {/if}
              </div>
            </div>
          </div>
        {/if}
      {/each}
      <div class="turn-row turn-row-status">
        <div class="turn-time"></div>
        <div class="turn-rail turn-rail-terminus">
          <div class="mind-status-dot" style:background={statusColor}></div>
        </div>
        <div class="turn-body">
          <span class="mind-status-text" style:color={statusColor}>{name} is {statusLabel}</span>
        </div>
      </div>
    </div>
  </div>
</div>

<style>
  .turn-timeline {
    container-type: inline-size;
    position: relative;
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    overflow: hidden;
  }

  .turn-scroll {
    flex: 1;
    overflow-x: hidden;
    overflow-y: auto;
    padding: 0 16px;
  }

  .turn-track {
    position: relative;
    min-height: 100%;
    max-width: 720px;
    margin: 0 auto;
  }

  .turn-row {
    display: flex;
    align-items: flex-start;
    min-height: 48px;
  }

  .turn-time {
    width: 60px;
    flex-shrink: 0;
    font-size: 11px;
    color: var(--text-2);
    padding-top: 10px;
    text-align: right;
    padding-right: 8px;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }

  .turn-rail {
    width: 2px;
    background: var(--timeline-rail);
    flex-shrink: 0;
    align-self: stretch;
    position: relative;
    min-height: 8px;
    overflow: visible;
    border: none;
    padding: 0;
    cursor: pointer;
  }

  .turn-rail-expanded {
    background:
      /* Solid segment at top (dot to connector) */
      linear-gradient(to bottom, var(--timeline-rail) 15px, transparent 15px),
      /* Solid segment at bottom (return line to next dot) */
      linear-gradient(to top, var(--timeline-rail) 15px, transparent 15px),
      /* Dashed middle (branch area) */
      repeating-linear-gradient(
        to bottom,
        var(--timeline-rail) 0px,
        var(--timeline-rail) 4px,
        transparent 4px,
        transparent 8px
      );
  }

  /* Suppress top-level HistoryEvent's rail pseudo-element — handled by .turn-rail.
     Only target the direct summary event, not nested events in expanded turns. */
  .turn-summary > :global(.event::after) {
    display: none;
  }
  /* Hide top-level HistoryEvent's marker dot — .turn-dot handles this on the main rail */
  .turn-summary > :global(.event > .marker) {
    display: none;
  }

  /* Highlight main rail on hover — offset to align with dot position */
  .turn-rail::before {
    content: "";
    position: absolute;
    top: 15px;
    bottom: -15px;
    left: 50%;
    width: 2px;
    margin-left: -1px;
    background: var(--text-2);
    opacity: 0;
    transition: opacity 0.15s;
    z-index: 2;
    pointer-events: none;
  }
  /* Collapsed: highlight on row hover or direct rail hover */
  .turn-row:hover > .turn-rail:not(.turn-rail-expanded)::before,
  .turn-rail:not(.turn-rail-expanded):hover::before {
    opacity: 1;
  }
  /* Expanded: highlight only on direct rail hover, matching solid-dashed-solid.
     ::before starts at top:15px (dot center) so no solid top needed.
     Solid bottom covers 30px (15px rail solid + 15px extension to next dot). */
  .turn-rail-expanded::before {
    background:
      linear-gradient(to top, var(--text-2) 30px, transparent 30px),
      repeating-linear-gradient(
        to bottom,
        var(--text-2) 0px,
        var(--text-2) 4px,
        transparent 4px,
        transparent 8px
      );
  }
  .turn-rail-expanded:hover::before {
    opacity: 1;
  }
  /* Wider invisible click/hover target for the rail */
  .turn-rail::after {
    content: "";
    position: absolute;
    top: 0;
    bottom: 0;
    left: -9px;
    right: -9px;
    cursor: pointer;
  }

  /* Extend HistoryEvent connectors to bridge the .turn-body padding gap (12px).
     HistoryEvent's default connector is left:-23px, width:23px.
     At top level, the gap is wider (12px body padding + 14px branch padding = 26px from inner rail to main rail).
     At nested levels, the gap is narrower. */
  .turn-summary :global(.turn-connector::after) {
    left: -35px;
    width: 35px;
  }
  .turn-summary :global(.branch-return) {
    left: -28px;
    width: 36px;
  }
  .turn-dot {
    position: absolute;
    top: 12px;
    right: -3px;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--text-0);
    z-index: 3;
  }

  /* Lower inner rail z-index so it doesn't cover the main rail dot */
  .turn-summary :global(.turn-connector) {
    z-index: 0;
  }

  .turn-body {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding-left: 12px;
    padding-right: 12px;
  }

  .turn-summary {
    min-width: 0;
  }

  @container (max-width: 400px) {
    .turn-time {
      display: none;
    }
    .turn-body {
      padding-left: 8px;
      padding-right: 4px;
    }
    .turn-scroll {
      padding: 0 8px;
    }
    /* Shorter connector extensions for reduced padding */
    .turn-summary :global(.turn-connector::after) {
      left: -31px;
      width: 31px;
    }
    .turn-summary :global(.branch-return) {
      left: -24px;
      width: 32px;
    }
  }

  /* Peek icon buttons on the timeline rail */
  .turn-peek-icons {
    position: absolute;
    top: 40px; /* below the dot (dot is at top:12px, generous gap) */
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 30px;
    z-index: 4;
  }

  .peek-anchor {
    position: relative;
  }

  .peek-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    background: var(--bg-1);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    color: var(--blue);
    cursor: pointer;
    padding: 0;
    transition: background 0.1s, border-color 0.1s;
  }

  .peek-btn :global(svg) {
    width: 10px;
    height: 10px;
  }

  .peek-btn:hover {
    background: var(--bg-2);
    border-color: var(--border-bright);
  }

  .peek-popover {
    display: none;
    position: absolute;
    top: -4px;
    left: calc(100% + 8px);
    z-index: 20;
    min-width: 280px;
    max-width: 400px;
    /* Invisible bridge from button to popover so hover persists */
    padding-left: 12px;
    margin-left: -12px;
    --card-max-height: 340px;
  }

  .peek-popover :global(.timeline-card) {
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
  }

  /* Hover peeks keep the old fixed preview height */
  .peek-popover :global(.page-preview) {
    height: 200px;
  }

  .peek-anchor:hover .peek-popover {
    display: block;
  }

  .peek-msgs {
    padding: 8px 10px;
    max-height: 300px;
    overflow-y: auto;
  }

  .peek-msg {
    padding: 2px 0;
    font-family: var(--mono);
    font-size: 13px;
    color: var(--text-0);
    line-height: 1.5;
  }

  .peek-msg-sender {
    font-weight: 600;
    color: var(--accent);
    margin-right: 6px;
    font-size: 12px;
  }

  .peek-msg-sender-user {
    color: var(--blue);
  }

  .peek-msg-md :global(p) {
    margin: 0;
    display: inline;
  }

  .turn-rail-terminus {
    min-height: 8px;
  }
  .turn-rail-terminus::before {
    display: none;
  }

  .mind-status-dot {
    position: absolute;
    top: 0;
    right: -3px;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    z-index: 3;
  }

  .turn-row-status {
    min-height: 0 !important;
  }
  .turn-row:has(+ .turn-row-status) {
    min-height: 108px !important;
  }
  .turn-row:has(+ .turn-row-status) > .turn-rail::before {
    bottom: 0;
  }

  .mind-status-text {
    font-size: 15px;
    font-family: Georgia, "Times New Roman", serif;
    font-style: italic;
    line-height: 8px;
    padding-left: 20px;
  }

  /* Scale break: two diagonal lines on the rail with labels */
  .scale-break-row {
    min-height: 60px !important;
  }
  .scale-break-container {
    width: 2px;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    position: relative;
    align-self: stretch;
  }
  /* Rail segments above and below the slashes, with a gap for the marks */
  .scale-break-container::before,
  .scale-break-container::after {
    content: "";
    position: absolute;
    width: 2px;
    background: var(--timeline-rail);
    left: 0;
  }
  .scale-break-container::before {
    top: 0;
    bottom: calc(50% + 8px);
  }
  .scale-break-container::after {
    bottom: 0;
    top: calc(50% + 8px);
  }
  .scale-break-slash {
    width: 14px;
    height: 2px;
    background: var(--timeline-rail);
    transform: rotate(-30deg);
  }
  .scale-break-gap {
    height: 14px;
  }
  .scale-break-label {
    position: absolute;
    left: 16px;
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 14px;
    color: var(--timeline-rail);
    white-space: nowrap;
  }
  .scale-break-label-above {
    top: 0;
  }
  .scale-break-label-below {
    bottom: 0;
  }
  .scale-break-arrow {
    width: 7px;
    height: 5px;
    flex-shrink: 0;
  }
  /* Summary dot style */
  .summary-dot {
    border: 2px solid var(--text-2);
    background: var(--bg-1);
    box-sizing: border-box;
  }
</style>
