<script lang="ts">
import { tooltip } from "@volute/ui";
import {
  fetchMindBudget,
  fetchMindUsage,
  type MindBudget,
  type UsageReport,
} from "../../lib/client";
import { navigate } from "../../lib/navigate";
import { formatUsd } from "../../lib/spend-format";
import { spendStrip } from "../../lib/spend-status";

let { name }: { name: string } = $props();

let budget = $state<MindBudget | null>(null);
let usage = $state<UsageReport | null>(null);
/** Ticks so the reset/release countdowns stay true without a reload. */
let now = $state(Date.now());

$effect(() => {
  const mind = name;
  let live = true;
  budget = null;
  usage = null;

  async function load() {
    // The budget 404s into null when there's no cap, which is an answer. Usage is the
    // one that matters if the daemon is unreachable, so its failure leaves the strip
    // absent rather than showing a cap with no spend beside it.
    const [b, u] = await Promise.all([
      fetchMindBudget(mind),
      fetchMindUsage(mind, "24h").catch(() => null),
    ]);
    if (!live) return;
    budget = b;
    usage = u;
    now = Date.now();
  }

  void load();
  const timer = setInterval(() => void load(), 60_000);
  return () => {
    live = false;
    clearInterval(timer);
  };
});

let strip = $derived(spendStrip(budget, usage, now));
</script>

{#if strip}
  <div class="spend-strip" class:over={strip.cap?.level === "over"} class:held={!!strip.held}>
    <button
      class="figure"
      onclick={() => navigate(`/usage?mind=${encodeURIComponent(name)}`)}
      use:tooltip={{
        text: strip.figure.note || "Spend for this mind — open the usage page",
        position: "bottom",
      }}
    >
      {#if strip.figure.floor}<span class="at-least">at least</span>{/if}{strip.figure.text}
      <span class="scope">{strip.scope}</span>
    </button>

    {#if strip.cap}
      <span class="cap">
        <span class="meter">
          <span
            class="meter-fill {strip.cap.level}"
            style:width="{Math.min(100, strip.cap.percentUsed)}%"
          ></span>
        </span>
        <span class="cap-text">{strip.cap.percentUsed}% of {formatUsd(strip.cap.capUsd)}</span>
      </span>
      <!-- A cap whose end you can't see is a trapdoor, not a budget. -->
      <span class="reset">resets {strip.cap.resetsIn}</span>
    {/if}

    {#if strip.window}
      <span class="window">{strip.window.figure.text} {strip.window.label}</span>
    {/if}

    {#if strip.held}
      <span class="held-note">
        held — {strip.held.count}
        {strip.held.count === 1 ? "message" : "messages"} waiting{strip.held.scope === "system"
          ? " (install-wide cap)"
          : ""}{strip.held.releasesIn ? `, releases ${strip.held.releasesIn}` : ""}
      </span>
    {:else if strip.systemCap}
      <span class="sys-note" class:over={strip.systemCap.level === "over"}>
        install-wide cap {strip.systemCap.percentUsed}%, resets {strip.systemCap.resetsIn}
      </span>
    {/if}
  </div>
{/if}

<style>
  .spend-strip {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
    flex-shrink: 0;
    padding: 5px 12px;
    border-bottom: 1px solid var(--border);
    font-size: 12px;
    color: var(--text-2);
  }

  .spend-strip.over {
    background: var(--red-bg);
  }

  .spend-strip.held {
    background: var(--yellow-bg);
  }

  .figure {
    background: none;
    padding: 0;
    font-family: var(--mono);
    font-size: 12px;
    color: var(--text-0);
    display: flex;
    align-items: baseline;
    gap: 6px;
  }

  .figure:hover {
    color: var(--accent);
  }

  .at-least {
    color: var(--yellow);
    margin-right: 4px;
  }

  .scope {
    color: var(--text-2);
    font-family: var(--sans);
  }

  .cap {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .meter {
    display: block;
    width: 56px;
    height: 4px;
    background: var(--bg-2);
    border-radius: 2px;
    overflow: hidden;
  }

  .meter-fill {
    display: block;
    height: 100%;
    background: var(--accent);
  }

  .meter-fill.warning {
    background: var(--yellow);
  }

  .meter-fill.over {
    background: var(--red);
  }

  .cap-text,
  .window {
    font-family: var(--mono);
  }

  .reset {
    color: var(--text-2);
  }

  .held-note {
    color: var(--yellow);
  }

  .sys-note.over {
    color: var(--red);
  }
</style>
