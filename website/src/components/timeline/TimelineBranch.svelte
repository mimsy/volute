<script lang="ts">
import type { Snippet } from "svelte";

let {
  gap = 16,
  reach = 10,
  railTop = 15,
  noReturn = false,
  dashed = false,
  header,
  footer,
  children,
  onheaderclick,
  onfooterclick,
  onrailclick,
}: {
  gap?: number;
  reach?: number;
  railTop?: number;
  noReturn?: boolean;
  dashed?: boolean;
  header?: Snippet;
  footer?: Snippet;
  children: Snippet;
  onheaderclick?: () => void;
  onfooterclick?: () => void;
  onrailclick?: () => void;
} = $props();
</script>

<div class="branch-wrapper" class:no-return={noReturn} style:--branch-gap="{gap}px" style:--branch-reach="{reach}px" style:--rail-top="{railTop}px" >
  <div class="branch-connector" class:branch-connector-dashed={dashed}></div>
  {#if dashed}
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="branch-rail-hit" onclick={onrailclick}></div>
  {/if}
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

  /* Vertical rail — purely decorative, underneath interactive elements */
  .branch-connector {
    position: absolute;
    top: var(--rail-top);
    left: calc(var(--branch-gap) - 2px);
    width: 2px;
    bottom: 12px;
    background: var(--border);
    pointer-events: none;
  }

  /* Clickable hit area over the dashed rail — collapses expanded child */
  .branch-rail-hit {
    position: absolute;
    top: var(--rail-top);
    left: calc(var(--branch-gap) - 7px);
    width: 12px;
    bottom: 12px;
    cursor: pointer;
    z-index: 2;
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

  /* Inner rail between children: show on hover (branch-connector provides the steady rail) */
  .branch-content > :global(.event:hover::after) {
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

  /* Highlight connectors on header/footer/connector hover — includes child ::after rails
     so the whole track lights up uniformly without masking gaps */
  /* Highlight on header/footer hover — full track including child rails */
  .branch-wrapper:has(> .branch-content > .branch-header:hover, > .branch-content > .branch-footer:hover) > .branch-connector,
  .branch-wrapper:has(> .branch-content > .branch-header:hover, > .branch-content > .branch-footer:hover) > .branch-connector::after,
  .branch-wrapper:has(> .branch-content > .branch-header:hover, > .branch-content > .branch-footer:hover) > .branch-content > .tb-return,
  .branch-wrapper:has(> .branch-content > .branch-header:hover, > .branch-content > .branch-footer:hover) > .branch-content :global(.event::after),
  .branch-wrapper:has(> .branch-content > .branch-header:hover, > .branch-content > .branch-footer:hover) > .branch-content > :global(.summary-child-collapsed::after) {
    background: var(--text-0);
    opacity: 1;
  }
  /* Highlight on dashed rail hover — just the dashed connector itself */
  .branch-wrapper:has(> .branch-rail-hit:hover) > .branch-connector {
    background:
      linear-gradient(to bottom, var(--text-0) 15px, transparent 15px),
      linear-gradient(to top, var(--text-0) 15px, transparent 15px),
      repeating-linear-gradient(
        to bottom,
        var(--text-0) 0px,
        var(--text-0) 4px,
        transparent 4px,
        transparent 8px
      );
  }
  .branch-wrapper:has(> .branch-rail-hit:hover) > .branch-connector::after {
    background: var(--text-0);
  }

  .branch-header {
    cursor: pointer;
  }

  /* HistoryEvent connector overrides — turn sub-rail connectors inside a branch.
     turn-connector is at left:22px from event, parent rail at left:-2px = 24px span. */
  .branch-content :global(.turn-connector::after) {
    left: -24px;
    width: 24px;
  }
  .branch-content :global(.branch-return) {
    left: -17px;
    width: 25px;
  }
</style>
