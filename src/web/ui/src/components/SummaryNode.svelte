<script lang="ts">
import type { HistoryMessage, SummaryRow, TurnRow } from "@volute/api";
import { Icon } from "@volute/ui";
import type { SvelteMap } from "svelte/reactivity";
import { groupToolEvents } from "../lib/tool-groups";
import { getCategoryColor, getCategoryIcon } from "../lib/tool-names";
import ToolGroupComponent from "./chat/ToolGroup.svelte";
import HistoryEvent from "./HistoryEvent.svelte";
import SummaryNode from "./SummaryNode.svelte";
import TimelineBranch from "./TimelineBranch.svelte";

let {
  summary,
  depth = 0,
  expandedSummaries,
  directEventsSummaries,
  loadingChildren,
  toggleSummaryExpand,
  formatPeriodTime,
}: {
  summary: SummaryRow;
  depth?: number;
  expandedSummaries: SvelteMap<number, (SummaryRow | TurnRow)[]>;
  directEventsSummaries: SvelteMap<number, HistoryMessage[]>;
  loadingChildren: Set<number>;
  toggleSummaryExpand: (summary: SummaryRow) => void;
  formatPeriodTime: (period: string, periodKey: string) => string;
} = $props();

let isExpanded = $derived(
  expandedSummaries.has(summary.id) || directEventsSummaries.has(summary.id),
);
let isLoading = $derived(loadingChildren.has(summary.id));
let directEvents = $derived(directEventsSummaries.get(summary.id));
let childItems = $derived(expandedSummaries.get(summary.id) ?? []);
let branchGap = $derived(depth === 0 ? 16 : 12);
let branchReach = $derived(depth === 0 ? 10 : 7);
let branchHeConnectorWidth = $derived(depth === 0 ? 26 : 19);
</script>

{#if isExpanded}
  <TimelineBranch
    gap={branchGap}
    reach={branchReach}
    heConnectorWidth={branchHeConnectorWidth}
    onheaderclick={() => toggleSummaryExpand(summary)}
    onfooterclick={() => toggleSummaryExpand(summary)}
  >
    {#snippet header()}
      <div class="summary-expand-header">
        <span class="active-turn-time">{formatPeriodTime(summary.period, summary.period_key)}</span>
      </div>
    {/snippet}
    {#snippet children()}
      {#if isLoading}
        <div class="summary-expand-loading">loading...</div>
      {:else if directEvents}
        {@const groups = groupToolEvents(directEvents)}
        {#each groups as groupItem (groupItem.kind === "tool-group" ? `tg-${groupItem.toolUse.id}` : `ev-${groupItem.event.id}`)}
          {#if groupItem.kind === "tool-group"}
            {@const catColor = getCategoryColor(groupItem.category)}
            {@const catIcon = getCategoryIcon(groupItem.category)}
            <div class="event" style:--type-color={catColor}>
              <div class="marker marker-icon" style:color={catColor}>
                <Icon kind={catIcon} />
              </div>
              <ToolGroupComponent group={groupItem} mindName={summary.mind} turnStatus="complete" />
            </div>
          {:else}
            <HistoryEvent event={groupItem.event} mindName={summary.mind} />
          {/if}
        {/each}
      {:else}
        {#each childItems as child (('period' in child) ? `s-${child.id}` : `t-${child.id}`)}
          {#if 'period' in child}
            {@const childSummary = child as SummaryRow}
            {@const childExpanded = expandedSummaries.has(childSummary.id) || directEventsSummaries.has(childSummary.id)}
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div class="summary-child-item" class:summary-child-expanded={childExpanded} class:summary-child-collapsed={!childExpanded} onclick={(e) => { e.stopPropagation(); toggleSummaryExpand(childSummary); }}>
              <div class="summary-child-dot summary-dot"></div>
              <div class="summary-child-body">
                {#if !childExpanded}
                  <span class="summary-child-time">{formatPeriodTime(childSummary.period, childSummary.period_key)}</span>
                  <span class="summary-text">{childSummary.content}</span>
                {/if}
              </div>
            </div>
            {#if childExpanded}
              <SummaryNode
                summary={childSummary}
                depth={depth + 1}
                {expandedSummaries}
                {directEventsSummaries}
                {loadingChildren}
                {toggleSummaryExpand}
                {formatPeriodTime}
              />
            {/if}
          {:else}
            {@const childTurn = child as TurnRow}
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div onclick={(e) => e.stopPropagation()}>
              <HistoryEvent
                event={{
                  id: 0,
                  mind: childTurn.mind,
                  channel: "",
                  session: null,
                  sender: null,
                  message_id: null,
                  type: "summary",
                  content: childTurn.summary ?? "(no summary)",
                  metadata: childTurn.summary_meta ? JSON.stringify(childTurn.summary_meta) : null,
                  turn_id: childTurn.id,
                  created_at: childTurn.created_at,
                }}
                mindName={childTurn.mind}
                expandable
              />
            </div>
          {/if}
        {/each}
      {/if}
    {/snippet}
    {#snippet footer()}
      <button class="summary-expand-collapse" onclick={(e) => e.stopPropagation()}>
        <span class="summary-text">{summary.content}</span>
      </button>
    {/snippet}
  </TimelineBranch>
{:else}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="summary-collapsed" onclick={() => toggleSummaryExpand(summary)}>
    <span class="summary-collapsed-time">{formatPeriodTime(summary.period, summary.period_key)}</span>
    <span class="summary-text">{summary.content}</span>
  </div>
{/if}

<style>
  .summary-expand-header {
    margin-bottom: 4px;
    margin-left: 6px;
  }
  .summary-expand-header:hover .active-turn-time {
    color: var(--text-0);
  }
  .active-turn-time {
    font-size: 11px;
    color: var(--text-2);
  }
  .summary-expand-loading {
    font-size: 12px;
    color: var(--text-2);
    font-style: italic;
    padding: 8px 0 8px 14px;
  }
  .summary-expand-collapse {
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
  .summary-expand-collapse::before {
    content: "";
    position: absolute;
    left: -5px;
    top: 12px;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    border: 2px solid var(--text-2);
    background: var(--bg-1);
    box-sizing: border-box;
    z-index: 3;
  }

  .summary-text {
    font-family: var(--mono);
    font-size: 13px;
    color: var(--text-0);
    line-height: 1.5;
  }

  .summary-collapsed {
    cursor: pointer;
    padding: 6px 0;
  }
  .summary-collapsed-time {
    display: block;
    font-size: 11px;
    color: var(--text-2);
    margin-bottom: 2px;
  }
  .summary-collapsed .summary-text {
    display: -webkit-box;
    -webkit-line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  /* Child summary items */
  .summary-child-item {
    position: relative;
    padding: 8px 8px 8px 20px;
    cursor: pointer;
  }
  .summary-child-item:hover {
    background: color-mix(in srgb, var(--text-2) 5%, transparent);
    border-radius: var(--radius);
  }
  .summary-child-dot {
    position: absolute;
    left: -5px;
    top: 12px;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    z-index: 1;
  }
  .summary-dot {
    border: 2px solid var(--text-2);
    background: var(--bg-1);
    box-sizing: border-box;
  }
  .summary-child-body {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .summary-child-time {
    font-size: 11px;
    color: var(--text-2);
  }
  /* Solid rail between child items */
  .summary-child-item::after {
    content: "";
    position: absolute;
    left: -2px;
    top: 20px;
    bottom: -6px;
    width: 2px;
    background: var(--border);
  }
  .summary-child-item:last-of-type::after {
    display: none;
  }
  /* Dashed rail when child is expanded */
  .summary-child-expanded::after {
    background: repeating-linear-gradient(
      to bottom,
      var(--border) 0px,
      var(--border) 4px,
      transparent 4px,
      transparent 8px
    );
  }

  /* Marker/event styles for direct events rendered inline */
  .event {
    position: relative;
    padding: 6px 8px 6px 20px;
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
</style>
