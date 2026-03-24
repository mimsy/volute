<script lang="ts">
import type { Snippet } from "svelte";

let {
  gap = 16,
  reach = 10,
  noReturn = false,
  dashed = false,
  heConnectorWidth,
  header,
  footer,
  children,
  onheaderclick,
  onfooterclick,
}: {
  gap?: number;
  reach?: number;
  noReturn?: boolean;
  dashed?: boolean;
  heConnectorWidth?: number;
  header?: Snippet;
  footer?: Snippet;
  children: Snippet;
  onheaderclick?: () => void;
  onfooterclick?: () => void;
} = $props();
</script>

<div class="branch-wrapper" class:no-return={noReturn} style:--branch-gap="{gap}px" style:--branch-reach="{reach}px" style:--he-cw={heConnectorWidth ? `${heConnectorWidth}px` : undefined}>
  <div class="branch-connector" class:branch-connector-dashed={dashed}></div>
  <div class="branch-content">
    {#if header}
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="branch-header" onclick={onheaderclick}>
        {@render header()}
      </div>
    {/if}
    {@render children()}
    {#if footer}
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="branch-footer" onclick={onfooterclick}>
        {@render footer()}
      </div>
    {/if}
    {#if !noReturn}
      <div class="tb-return"></div>
    {/if}
  </div>
</div>

<style>
  .branch-wrapper {
    position: relative;
  }

  /* Vertical rail */
  .branch-connector {
    position: absolute;
    top: 16px;
    left: calc(var(--branch-gap) - 2px);
    width: 2px;
    bottom: 12px;
    background: var(--border);
  }
  .no-return > .branch-connector {
    bottom: 0;
  }
  .branch-connector-dashed {
    background:
      linear-gradient(to bottom, var(--border) 15px, transparent 15px),
      linear-gradient(to top, var(--border) 15px, transparent 15px),
      repeating-linear-gradient(
        to bottom,
        var(--border) 0px,
        var(--border) 4px,
        transparent 4px,
        transparent 8px
      );
  }

  /* Horizontal connector from parent rail to inner rail */
  .branch-connector::after {
    content: "";
    position: absolute;
    top: 0;
    left: calc(-1 * var(--branch-gap) - var(--branch-reach));
    width: calc(var(--branch-gap) + var(--branch-reach));
    height: 2px;
    background: var(--border);
  }

  .branch-content {
    position: relative;
    padding-left: var(--branch-gap);
    padding-top: 8px;
    padding-bottom: 8px;
  }

  /* Inner rail between children: ensure visibility */
  .branch-content > :global(.event::after) {
    opacity: 1;
  }

  /* Return line from inner rail back to parent rail — extends 2px past the
     wrapper edge to match the top horizontal connector's alignment */
  .tb-return {
    position: absolute;
    bottom: 10px;
    left: calc(-1 * var(--branch-reach) - 2px);
    width: calc(var(--branch-gap) + var(--branch-reach) + 2px);
    height: 2px;
    background: var(--border);
  }

  /* Highlight connectors on header/footer hover */
  .branch-wrapper:has(> .branch-content > .branch-header:hover, > .branch-content > .branch-footer:hover) > .branch-connector,
  .branch-wrapper:has(> .branch-content > .branch-header:hover, > .branch-content > .branch-footer:hover) > .branch-connector::after,
  .branch-wrapper:has(> .branch-content > .branch-header:hover, > .branch-content > .branch-footer:hover) > .branch-content > .tb-return {
    background: var(--text-0);
  }

  .branch-header {
    cursor: pointer;
  }

  /* HistoryEvent connector overrides — bridge sub-rail to this branch's inner rail.
     Fallback 23px matches HistoryEvent's own defaults when heConnectorWidth isn't set. */
  .branch-content :global(.turn-connector::after) {
    left: calc(-1 * var(--he-cw, 23px));
    width: var(--he-cw, 23px);
  }
  .branch-content :global(.branch-return) {
    left: calc(-1 * (var(--he-cw, 23px) - 7px));
    width: calc(var(--he-cw, 23px) + 1px);
  }
</style>
