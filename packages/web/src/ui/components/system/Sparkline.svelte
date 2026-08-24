<script lang="ts">
import { tooltip } from "@volute/ui";
import type { UsageBucket } from "../../lib/client";
import { formatUsd } from "../../lib/spend-format";

let {
  series,
  bucketMinutes,
  height = 28,
}: { series: UsageBucket[]; bucketMinutes: number; height?: number } = $props();

let max = $derived(series.reduce((m, b) => Math.max(m, b.costUsd), 0));

/** The bucket's start in the reader's own timezone — the series arrives as UTC instants. */
function label(start: string): string {
  const d = new Date(start);
  return bucketMinutes >= 1440
    ? d.toLocaleDateString(undefined, { month: "short", day: "numeric" })
    : d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric" });
}

function title(b: UsageBucket): string {
  const turns = `${b.turns} ${b.turns === 1 ? "turn" : "turns"}`;
  // A bucket whose turns went unpriced reads $0.00 without this, which is a lie of
  // omission at exactly the resolution a host is looking at.
  const unpriced = b.unpricedTurns > 0 ? `, ${b.unpricedTurns} unmetered` : "";
  return `${label(b.start)} — ${formatUsd(b.costUsd)}, ${turns}${unpriced}`;
}

/** Percent height, with a visible floor so a small-but-real bucket isn't invisible. */
function barHeight(cost: number): number {
  if (max <= 0 || cost <= 0) return 0;
  return Math.max(6, (cost / max) * 100);
}
</script>

<div class="sparkline" style:height="{height}px" role="img" aria-label="spend over time">
  {#each series as bucket (bucket.start)}
    <div class="slot" use:tooltip={{ text: title(bucket), position: "top" }}>
      {#if bucket.costUsd > 0}
        <div
          class="bar"
          class:unmetered={bucket.unpricedTurns > 0}
          style:height="{barHeight(bucket.costUsd)}%"
        ></div>
      {:else if bucket.turns > 0}
        <!-- Turns happened but cost nothing we could price: a tick, not an empty slot. -->
        <div class="bar tick" class:unmetered={bucket.unpricedTurns > 0}></div>
      {/if}
    </div>
  {/each}
</div>

<style>
  .sparkline {
    display: flex;
    align-items: flex-end;
    gap: 1px;
    width: 100%;
  }

  .slot {
    flex: 1;
    height: 100%;
    display: flex;
    align-items: flex-end;
    min-width: 2px;
  }

  .slot:hover {
    background: var(--muted-bg);
  }

  .bar {
    width: 100%;
    background: var(--accent);
    border-radius: 1px;
    min-height: 1px;
  }

  /* Striped rather than a different colour: it means "incomplete", not "worse". */
  .bar.unmetered {
    background: repeating-linear-gradient(
      45deg,
      var(--accent) 0 2px,
      color-mix(in srgb, var(--accent) 25%, transparent) 2px 4px
    );
  }

  .bar.tick {
    height: 2px;
    background: var(--text-2);
  }
</style>
