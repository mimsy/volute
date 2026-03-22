<script lang="ts">
import type { Mind } from "@volute/api";
import { fetchMinds, startMind, stopMind } from "../../lib/client";
import { getDisplayStatus } from "../../lib/format";
import { data } from "../../lib/stores.svelte";
import Button from "../ui/Button.svelte";
import ErrorMessage from "../ui/ErrorMessage.svelte";
import SettingRow from "../ui/SettingRow.svelte";
import SettingsSection from "../ui/SettingsSection.svelte";
import StatusBadge from "../ui/StatusBadge.svelte";

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

<SettingsSection title="Status">
  <div class="status-row">
    <StatusBadge status={getDisplayStatus(mind)} />
    {#if mind.status === "stopped"}
      <Button variant="primary" onclick={handleStart} disabled={actionLoading}>
        {actionLoading ? "Starting..." : "Start"}
      </Button>
    {:else}
      <button
        onclick={handleStop}
        disabled={actionLoading}
        class="stop-btn"
      >
        {actionLoading ? "Stopping..." : "Stop"}
      </button>
    {/if}
  </div>
  <ErrorMessage message={actionError} />
</SettingsSection>

<SettingsSection title="Info">
  <SettingRow label="Template">
    <span class="info-value">{mind.template ?? "\u2014"}</span>
  </SettingRow>
  <SettingRow label="Created">
    <span class="info-value">{mind.created ? formatDate(mind.created) : "\u2014"}</span>
  </SettingRow>
</SettingsSection>

<style>
  .status-row {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .stop-btn {
    padding: 4px 12px;
    border-radius: var(--radius);
    font-size: 12px;
    font-weight: 500;
    font-family: inherit;
    border: none;
    cursor: pointer;
    background: var(--red-dim);
    color: var(--red);
    transition: opacity 0.15s;
  }

  .stop-btn:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .info-value {
    font-size: 13px;
    color: var(--text-1);
  }
</style>
