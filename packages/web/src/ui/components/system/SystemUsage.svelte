<script lang="ts">
import { EmptyState, ErrorMessage, tooltip } from "@volute/ui";
import {
  fetchUsage,
  type MindUsage,
  type SystemUsageReport,
  type UsageWindow,
} from "../../lib/client";
import { navigate } from "../../lib/navigate";
import {
  capLevel,
  formatPercent,
  formatTokens,
  formatUntil,
  formatUsd,
  spendFigure,
  unpricedLabel,
} from "../../lib/spend-format";
import Sparkline from "./Sparkline.svelte";

let { focusMind = null }: { focusMind?: string | null } = $props();

const WINDOWS: { value: UsageWindow; label: string }[] = [
  { value: "24h", label: "24h" },
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
];

let window = $state<UsageWindow>("24h");
let report = $state<SystemUsageReport | null>(null);
let error = $state("");
let loading = $state(true);

$effect(() => {
  const w = window;
  let live = true;
  loading = true;
  error = "";
  fetchUsage(w)
    .then((r) => {
      if (live) report = r;
    })
    .catch((e: unknown) => {
      if (live) error = e instanceof Error ? e.message : "Failed to load usage";
    })
    .finally(() => {
      if (live) loading = false;
    });
  return () => {
    live = false;
  };
});

let focused = $derived(
  focusMind ? (report?.minds.find((m) => m.mind === focusMind) ?? null) : null,
);

/**
 * The headline covers whatever the page is scoped to: one mind when focused, the whole
 * install otherwise. A focused view that quietly showed install-wide totals would be the
 * same misattribution the per-model pricing exists to avoid.
 */
let headline = $derived(focused ?? report?.total ?? null);
let headlineSeries = $derived(focused?.series ?? report?.series ?? []);
let headlineFigure = $derived(
  headline
    ? spendFigure(headline)
    : { text: formatUsd(0), floor: false as boolean, note: "" as string },
);

let rows = $derived(focused ? [focused] : (report?.minds ?? []));
let maxCost = $derived(rows.reduce((m, r) => Math.max(m, r.costUsd), 0));

let system = $derived(report?.system ?? null);
let systemLevel = $derived(system ? capLevel(system.percentUsed) : "ok");

/** Share of the install-wide total, for the rank bar. Falls back to the biggest row. */
function share(row: MindUsage): number {
  const basis = report && report.total.costUsd > 0 ? report.total.costUsd : maxCost;
  return basis > 0 ? Math.min(1, row.costUsd / basis) : 0;
}

function windowLabel(w: UsageWindow): string {
  return w === "24h" ? "last 24 hours" : w === "7d" ? "last 7 days" : "last 30 days";
}
</script>

<div class="usage">
  <div class="head">
    <div class="titles">
      <span class="title">Usage</span>
      {#if focusMind}
        <button class="clear-focus" onclick={() => navigate("/usage")}>
          {focusMind} · show all minds
        </button>
      {/if}
    </div>
    <div class="windows">
      {#each WINDOWS as w (w.value)}
        <button class="window" class:active={window === w.value} onclick={() => (window = w.value)}>
          {w.label}
        </button>
      {/each}
    </div>
  </div>

  {#if error}
    <ErrorMessage message={error} />
  {:else if !report && loading}
    <p class="muted">Loading…</p>
  {:else if report && headline}
    <div class="summary">
      <div class="figure-row">
        <span class="figure" class:floor={headlineFigure.floor}>
          {#if headlineFigure.floor}<span class="at-least" use:tooltip={headlineFigure.note}
              >at least</span
            >{/if}
          {headlineFigure.text}
        </span>
        <span class="scope">{windowLabel(window)}</span>
      </div>
      <div class="stats">
        <span>{headline.turns} {headline.turns === 1 ? "turn" : "turns"}</span>
        <span
          use:tooltip={`${formatTokens(headline.cacheReadTokens)} cache reads of ${formatTokens(headline.inputTokens + headline.cacheReadTokens + headline.cacheCreationTokens)} tokens in`}
          >{formatPercent(headline.cacheHitRatio)} cache</span
        >
        <span>{formatTokens(headline.outputTokens)} out</span>
      </div>
      <Sparkline series={headlineSeries} bucketMinutes={report.bucketMinutes} height={56} />
    </div>

    {#if headline.unpricedTurns > 0}
      <!-- Pricing fails open: an unpriced turn counts $0 here and $0 against every cap.
           Saying so is the difference between a floor and a misleading total. -->
      <div class="notice">
        <strong>{headline.unpricedTurns}</strong> of {headline.turns} turns aren't metered, so the figure
        above is a floor.
        {#if headline.preUpgradeTurns > 0}
          <span
            >{headline.preUpgradeTurns} came from a mind still on a pre-upgrade template — <code
              >volute mind upgrade</code
            > starts metering it.</span
          >
        {/if}
        {#if headline.unpricedTurns > headline.preUpgradeTurns}
          <span
            >{headline.unpricedTurns - headline.preUpgradeTurns} ran on a model with no pricing.</span
          >
        {/if}
        Unmetered turns can't trip a spend cap either.
      </div>
    {/if}

    {#if system}
      <div class="cap {systemLevel}">
        <div class="cap-head">
          <span class="cap-title">Install-wide cap</span>
          <span class="cap-figure">
            {formatUsd(system.spentUsd)} of {formatUsd(system.capUsd)} per day · {system.percentUsed}%
          </span>
          <span class="cap-reset">resets {formatUntil(system.resetAt)}</span>
        </div>
        <div class="meter">
          <div class="meter-fill" style:width="{Math.min(100, system.percentUsed)}%"></div>
        </div>
        {#if system.hasUnpricedTurns}
          <div class="cap-note">
            Some turns this period couldn't be priced — they count nothing against this cap.
          </div>
        {/if}
      </div>
    {/if}

    {#if rows.length === 0}
      <EmptyState message="No usage recorded in this window." />
    {:else}
      <div class="rows">
        {#each rows as row (row.mind)}
          {@const figure = spendFigure(row)}
          {@const badge = unpricedLabel(row)}
          <div class="row">
            <div class="row-main">
              <button class="mind-name" onclick={() => navigate(`/${row.mind}`)}>{row.mind}</button>
              {#if badge}
                <span
                  class="badge"
                  use:tooltip={figure.note}
                  >{badge}</span
                >
              {/if}
              <span class="row-spend" class:floor={figure.floor} use:tooltip={figure.note}>
                {#if figure.floor}≥{/if}{figure.text}
              </span>
            </div>
            <div class="share">
              <div class="share-fill" style:width="{share(row) * 100}%"></div>
            </div>
            <div class="row-meta">
              <span>{row.turns} {row.turns === 1 ? "turn" : "turns"}</span>
              <span>{formatPercent(row.cacheHitRatio)} cache</span>
              <span class="row-spark">
                <Sparkline series={row.series} bucketMinutes={report.bucketMinutes} height={18} />
              </span>
            </div>
          </div>
        {/each}
      </div>
    {/if}
  {/if}
</div>

<style>
  .usage {
    max-width: 860px;
    margin: 0 auto;
    animation: fadeIn 0.2s ease both;
  }

  .head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 16px;
  }

  .titles {
    display: flex;
    align-items: baseline;
    gap: 10px;
    min-width: 0;
  }

  .title {
    font-size: 15px;
    font-weight: 600;
    color: var(--text-0);
  }

  .clear-focus {
    background: var(--bg-3);
    color: var(--text-2);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 2px 8px;
    font-size: 11px;
    font-family: var(--mono);
  }

  .clear-focus:hover {
    color: var(--text-0);
  }

  .windows {
    display: flex;
    gap: 4px;
  }

  .window {
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--radius);
    color: var(--text-2);
    font-family: var(--mono);
    font-size: 12px;
    padding: 3px 10px;
  }

  .window.active {
    background: var(--accent-bg);
    border-color: var(--accent-border);
    color: var(--accent);
  }

  .muted {
    color: var(--text-2);
    font-size: 13px;
  }

  .summary {
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: 16px;
    margin-bottom: 16px;
  }

  .figure-row {
    display: flex;
    align-items: baseline;
    gap: 10px;
  }

  .figure {
    font-family: var(--mono);
    font-size: 28px;
    color: var(--text-0);
  }

  .at-least {
    font-size: 13px;
    color: var(--yellow);
    margin-right: 4px;
    border-bottom: 1px dotted var(--yellow);
    cursor: help;
  }

  .scope {
    font-size: 12px;
    color: var(--text-2);
  }

  .stats {
    display: flex;
    gap: 14px;
    margin: 6px 0 12px;
    font-size: 12px;
    font-family: var(--mono);
    color: var(--text-2);
  }

  .notice {
    background: var(--yellow-bg);
    border: 1px solid var(--border);
    border-left: 2px solid var(--yellow);
    border-radius: var(--radius);
    padding: 10px 12px;
    margin-bottom: 16px;
    font-size: 12px;
    line-height: 1.6;
    color: var(--text-1);
  }

  .notice strong {
    color: var(--yellow);
  }

  .notice code {
    background: var(--bg-3);
    border-radius: 3px;
    padding: 0 4px;
    font-family: var(--mono);
  }

  .cap {
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: 12px;
    margin-bottom: 16px;
  }

  .cap-head {
    display: flex;
    align-items: baseline;
    gap: 10px;
    flex-wrap: wrap;
    margin-bottom: 8px;
  }

  .cap-title {
    font-size: 13px;
    color: var(--text-1);
  }

  .cap-figure {
    font-family: var(--mono);
    font-size: 12px;
    color: var(--text-0);
  }

  .cap-reset {
    font-size: 12px;
    color: var(--text-2);
    margin-left: auto;
  }

  .meter {
    height: 4px;
    background: var(--bg-2);
    border-radius: 2px;
    overflow: hidden;
  }

  .meter-fill {
    height: 100%;
    background: var(--accent);
    border-radius: 2px;
    transition: width 0.3s ease;
  }

  .cap.warning .meter-fill {
    background: var(--yellow);
  }

  .cap.over .meter-fill {
    background: var(--red);
  }

  .cap.over {
    border-color: var(--red-border);
  }

  .cap-note {
    margin-top: 8px;
    font-size: 11px;
    color: var(--text-2);
  }

  .rows {
    display: flex;
    flex-direction: column;
  }

  .row {
    padding: 10px 0;
    border-bottom: 1px solid var(--border);
  }

  .row-main {
    display: flex;
    align-items: baseline;
    gap: 8px;
  }

  .mind-name {
    background: none;
    color: var(--text-0);
    font-size: 14px;
    font-family: inherit;
    padding: 0;
  }

  .mind-name:hover {
    color: var(--accent);
  }

  .badge {
    font-size: 10px;
    font-family: var(--mono);
    padding: 1px 6px;
    border-radius: 10px;
    background: color-mix(in srgb, var(--yellow) 15%, transparent);
    color: var(--yellow);
    cursor: help;
  }

  .row-spend {
    margin-left: auto;
    font-family: var(--mono);
    font-size: 14px;
    color: var(--text-0);
  }

  .row-spend.floor {
    color: var(--yellow);
    cursor: help;
  }

  .share {
    height: 3px;
    background: var(--bg-2);
    border-radius: 2px;
    overflow: hidden;
    margin: 6px 0;
  }

  .share-fill {
    height: 100%;
    background: var(--accent);
  }

  .row-meta {
    display: flex;
    align-items: center;
    gap: 14px;
    font-size: 11px;
    font-family: var(--mono);
    color: var(--text-2);
  }

  .row-spark {
    flex: 1;
    min-width: 60px;
    margin-left: auto;
  }
</style>
