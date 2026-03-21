<script lang="ts">
import type { Mind } from "@volute/api";
import { fetchMinds, startMind, stopMind } from "../lib/client";
import { getDisplayStatus } from "../lib/format";
import { data } from "../lib/stores.svelte";
import StatusBadge from "./StatusBadge.svelte";

let { mind }: { mind: Mind } = $props();
let name = $derived(mind.name);

let actionLoading = $state(false);
let actionError = $state("");

async function handleStart() {
  actionLoading = true;
  actionError = "";
  try {
    await startMind(name);
  } catch (e) {
    actionError = e instanceof Error ? e.message : "Failed to start";
    actionLoading = false;
    return;
  }
  try {
    data.minds = await fetchMinds();
  } catch {
    actionError = "Started but failed to refresh status";
  }
  actionLoading = false;
}

async function handleStop() {
  actionLoading = true;
  actionError = "";
  try {
    await stopMind(name);
  } catch (e) {
    actionError = e instanceof Error ? e.message : "Failed to stop";
    actionLoading = false;
    return;
  }
  try {
    data.minds = await fetchMinds();
  } catch {
    actionError = "Stopped but failed to refresh status";
  }
  actionLoading = false;
}

function formatDate(dateStr: string): string {
  try {
    const d = new Date(dateStr.endsWith("Z") ? dateStr : `${dateStr}Z`);
    return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  } catch {
    return dateStr;
  }
}
</script>

<div class="section">
  <div class="section-title">Status</div>
  <div class="status-row">
    <StatusBadge status={getDisplayStatus(mind)} />
    {#if mind.status === "stopped"}
      <button
        onclick={handleStart}
        disabled={actionLoading}
        class="action-btn start-btn"
        style:opacity={actionLoading ? 0.5 : 1}
      >
        {actionLoading ? "Starting..." : "Start"}
      </button>
    {:else}
      <button
        onclick={handleStop}
        disabled={actionLoading}
        class="action-btn stop-btn"
        style:opacity={actionLoading ? 0.5 : 1}
      >
        {actionLoading ? "Stopping..." : "Stop"}
      </button>
    {/if}
  </div>
  {#if actionError}
    <div class="error">{actionError}</div>
  {/if}
</div>

<div class="section">
  <div class="section-title">Info</div>
  <div class="info-row">
    <span class="info-label">Template</span>
    <span class="info-value">{mind.template ?? "\u2014"}</span>
  </div>
  <div class="info-row">
    <span class="info-label">Created</span>
    <span class="info-value">{mind.created ? formatDate(mind.created) : "\u2014"}</span>
  </div>
</div>

<style>
  .section {
    margin-bottom: 24px;
  }

  .section-title {
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-2);
    margin-bottom: 8px;
  }

  .status-row {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .action-btn {
    padding: 4px 12px;
    border-radius: var(--radius);
    font-size: 12px;
    font-weight: 500;
    transition: opacity 0.15s;
  }

  .start-btn {
    background: var(--accent-dim);
    color: var(--accent);
  }

  .stop-btn {
    background: var(--red-dim);
    color: var(--red);
  }

  .error {
    color: var(--red);
    padding: 8px 0;
    font-size: 13px;
  }

  .info-row {
    display: flex;
    align-items: center;
    padding: 4px 0;
  }

  .info-label {
    width: 100px;
    flex-shrink: 0;
    font-size: 13px;
    color: var(--text-2);
  }

  .info-value {
    font-size: 13px;
    color: var(--text-1);
  }
</style>
