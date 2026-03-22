<script lang="ts">
import type { Mind, MindConfig } from "@volute/api";
import { onMount } from "svelte";
import { fetchMindConfig, fetchMinds, startMind, stopMind, updateMindConfig } from "../lib/client";
import { getDisplayStatus } from "../lib/format";
import { data } from "../lib/stores.svelte";
import Button from "./ui/Button.svelte";
import EmptyState from "./ui/EmptyState.svelte";
import EnvVarList from "./ui/EnvVarList.svelte";
import ErrorMessage from "./ui/ErrorMessage.svelte";
import Input from "./ui/Input.svelte";
import Select from "./ui/Select.svelte";
import SettingRow from "./ui/SettingRow.svelte";
import SettingsSection from "./ui/SettingsSection.svelte";
import StatusBadge from "./ui/StatusBadge.svelte";

let { mind }: { mind: Mind } = $props();
let name = $derived(mind.name);

let config = $state<MindConfig | null>(null);
let error = $state("");
let loading = $state(true);

// Editable settings
let editModel = $state("");
let editThinking = $state("off");
let editBudget = $state("");
let editPeriod = $state("");
let saving = $state<string | null>(null);

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

function loadEditFields(c: MindConfig) {
  editModel = c.config.model ?? "";
  editThinking = c.config.thinkingLevel ?? "off";
  editBudget = c.config.tokenBudget != null ? String(c.config.tokenBudget) : "";
  editPeriod =
    c.config.tokenBudgetPeriodMinutes != null ? String(c.config.tokenBudgetPeriodMinutes) : "";
}

async function refresh() {
  try {
    const c = await fetchMindConfig(name);
    config = c;
    loadEditFields(c);
    error = "";
  } catch {
    error = "Failed to load config";
  }
  loading = false;
}

onMount(() => {
  refresh();
});

async function saveField(field: string, value: unknown) {
  saving = field;
  error = "";
  try {
    await updateMindConfig(name, { [field]: value });
    const c = await fetchMindConfig(name);
    config = c;
    loadEditFields(c);
  } catch (e) {
    error = e instanceof Error ? e.message : "Failed to save";
  }
  saving = null;
}

function handleModelSave() {
  saveField("model", editModel);
}

function handleThinkingChange(e: Event) {
  const val = (e.target as HTMLSelectElement).value;
  editThinking = val;
  saveField("thinkingLevel", val);
}

function parseBudgetInt(val: string): number | null {
  const trimmed = val.trim();
  if (!trimmed) return null;
  const parsed = parseInt(trimmed, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

async function handleBudgetSave() {
  saving = "budget";
  error = "";
  try {
    await updateMindConfig(name, {
      tokenBudget: parseBudgetInt(editBudget),
      tokenBudgetPeriodMinutes: parseBudgetInt(editPeriod),
    });
    const c = await fetchMindConfig(name);
    config = c;
    loadEditFields(c);
  } catch (e) {
    error = e instanceof Error ? e.message : "Failed to save";
  }
  saving = null;
}

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

function handleKeydown(e: KeyboardEvent, action: () => void) {
  if (e.key === "Enter") action();
}
</script>

{#if loading}
  <EmptyState message="Loading..." />
{:else if !config}
  <ErrorMessage message="Failed to load configuration." />
{:else}
  <ErrorMessage message={error} />

  <SettingsSection title="Status">
    <div class="status-row">
      <StatusBadge status={getDisplayStatus(mind)} />
      {#if mind.status === "stopped"}
        <Button
          variant="primary"
          onclick={handleStart}
          disabled={actionLoading}
        >
          {actionLoading ? "Starting..." : "Start"}
        </Button>
      {:else}
        <button
          onclick={handleStop}
          disabled={actionLoading}
          class="action-btn stop-btn"
        >
          {actionLoading ? "Stopping..." : "Stop"}
        </button>
      {/if}
    </div>
    <ErrorMessage message={actionError} />
  </SettingsSection>

  <SettingsSection title="Settings">
    <SettingRow label="Model">
      <Input
        id="model-input"
        type="text"
        bind:value={editModel}
        onkeydown={(e) => handleKeydown(e, handleModelSave)}
        placeholder="e.g. claude-sonnet-4-6"
      />
      <Button variant="primary" onclick={handleModelSave} disabled={saving !== null}>
        {saving === "model" ? "..." : "Save"}
      </Button>
    </SettingRow>

    <SettingRow label="Thinking">
      <Select
        id="thinking-select"
        value={editThinking}
        onchange={handleThinkingChange}
        disabled={saving !== null}
      >
        {#each THINKING_LEVELS as level (level)}
          <option value={level}>{level}</option>
        {/each}
      </Select>
    </SettingRow>

    <SettingRow label="Token budget">
      <Input
        id="budget-input"
        type="number"
        width="80px"
        bind:value={editBudget}
        onkeydown={(e) => handleKeydown(e, handleBudgetSave)}
        placeholder="tokens"
      />
      <span class="setting-hint">per</span>
      <Input
        id="period-input"
        type="number"
        width="80px"
        bind:value={editPeriod}
        onkeydown={(e) => handleKeydown(e, handleBudgetSave)}
        placeholder="60"
      />
      <span class="setting-hint">min</span>
      <Button variant="primary" onclick={handleBudgetSave} disabled={saving !== null}>
        {saving === "budget" ? "..." : "Save"}
      </Button>
    </SettingRow>
  </SettingsSection>

  <EnvVarList {name} />
{/if}

<style>

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

  .stop-btn {
    background: var(--red-dim);
    color: var(--red);
  }

  .action-btn:disabled {
    opacity: 0.5;
  }

  .setting-hint {
    font-size: 13px;
    color: var(--text-2);
    flex-shrink: 0;
  }

</style>
