<script lang="ts">
import type { Mind, MindConfig, MindEnv } from "@volute/api";
import { onMount } from "svelte";
import { SvelteSet } from "svelte/reactivity";
import {
  deleteMindEnvVar,
  deleteSharedEnvVar,
  fetchMindConfig,
  fetchMindEnv,
  fetchMinds,
  setMindEnvVar,
  startMind,
  stopMind,
  updateMindConfig,
} from "../lib/client";
import { getDisplayStatus } from "../lib/format";
import { data } from "../lib/stores.svelte";
import StatusBadge from "./StatusBadge.svelte";
import Button from "./ui/Button.svelte";
import EmptyState from "./ui/EmptyState.svelte";
import ErrorMessage from "./ui/ErrorMessage.svelte";
import Input from "./ui/Input.svelte";
import Select from "./ui/Select.svelte";
import SettingRow from "./ui/SettingRow.svelte";
import SettingsSection from "./ui/SettingsSection.svelte";

let { mind }: { mind: Mind } = $props();
let name = $derived(mind.name);

let config = $state<MindConfig | null>(null);
let env = $state<MindEnv | null>(null);
let error = $state("");
let loading = $state(true);

// Editable settings
let editModel = $state("");
let editThinking = $state("off");
let editBudget = $state("");
let editPeriod = $state("");
let saving = $state<string | null>(null);

// Env vars
let revealedKeys = new SvelteSet<string>();
let addingEnv = $state(false);
let newEnvKey = $state("");
let newEnvValue = $state("");
let editingEnvKey = $state<string | null>(null);
let editingEnvValue = $state("");

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
    const [c, e] = await Promise.all([fetchMindConfig(name), fetchMindEnv(name)]);
    config = c;
    env = e;
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

// Env vars
let mergedEnv = $derived.by(() => {
  if (!env) return [];
  const merged: { key: string; value: string; source: "shared" | "mind" }[] = [];
  for (const [k, v] of Object.entries(env.shared)) {
    merged.push({ key: k, value: v, source: "shared" });
  }
  for (const [k, v] of Object.entries(env.mind)) {
    const idx = merged.findIndex((e) => e.key === k);
    if (idx >= 0) {
      merged[idx] = { key: k, value: v, source: "mind" };
    } else {
      merged.push({ key: k, value: v, source: "mind" });
    }
  }
  return merged.sort((a, b) => a.key.localeCompare(b.key));
});

function toggleReveal(key: string) {
  if (revealedKeys.has(key)) revealedKeys.delete(key);
  else revealedKeys.add(key);
}

function startEditEnv(key: string, value: string) {
  editingEnvKey = key;
  editingEnvValue = value;
}

async function saveEnvEdit() {
  if (!editingEnvKey) return;
  saving = `env:${editingEnvKey}`;
  error = "";
  try {
    await setMindEnvVar(name, editingEnvKey, editingEnvValue);
    env = await fetchMindEnv(name);
    editingEnvKey = null;
    editingEnvValue = "";
  } catch (e) {
    error = e instanceof Error ? e.message : "Failed to save";
  }
  saving = null;
}

async function deleteEnv(key: string, source: "shared" | "mind") {
  saving = `env:${key}`;
  error = "";
  try {
    if (source === "shared") {
      await deleteSharedEnvVar(key);
    } else {
      await deleteMindEnvVar(name, key);
    }
    env = await fetchMindEnv(name);
  } catch (e) {
    error = e instanceof Error ? e.message : "Failed to delete";
  }
  saving = null;
}

async function addEnvVar() {
  if (!newEnvKey.trim()) return;
  saving = "env:add";
  error = "";
  try {
    await setMindEnvVar(name, newEnvKey.trim(), newEnvValue);
    env = await fetchMindEnv(name);
    newEnvKey = "";
    newEnvValue = "";
    addingEnv = false;
  } catch (e) {
    error = e instanceof Error ? e.message : "Failed to add";
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

  <SettingsSection title="Environment Variables">
    {#snippet action()}
      <Button variant="primary" onclick={() => (addingEnv = true)}>Add</Button>
    {/snippet}

    {#if addingEnv}
      <div class="env-add-row">
        <Input
          variant="mono"
          type="text"
          width="120px"
          bind:value={newEnvKey}
          placeholder="KEY"
          onkeydown={(e) => handleKeydown(e, addEnvVar)}
        />
        <Input
          variant="mono"
          type="text"
          style="flex:1"
          bind:value={newEnvValue}
          placeholder="value"
          onkeydown={(e) => handleKeydown(e, addEnvVar)}
        />
        <Button variant="primary" onclick={addEnvVar} disabled={saving !== null}>
          {saving === "env:add" ? "..." : "Add"}
        </Button>
        <Button variant="secondary" onclick={() => (addingEnv = false)}>Cancel</Button>
      </div>
    {/if}

    {#if mergedEnv.length === 0}
      <EmptyState message="No environment variables set." />
    {:else}
      <div class="env-list">
        {#each mergedEnv as entry (entry.key)}
          <div class="env-row">
            {#if editingEnvKey === entry.key}
              <span class="env-key">{entry.key}</span>
              <Input
                variant="mono"
                type="text"
                style="flex:1"
                bind:value={editingEnvValue}
                onkeydown={(e) => handleKeydown(e, saveEnvEdit)}
              />
              <Button variant="primary" onclick={saveEnvEdit} disabled={saving !== null}>
                {saving === `env:${entry.key}` ? "..." : "Save"}
              </Button>
              <Button variant="secondary" onclick={() => (editingEnvKey = null)}>Cancel</Button>
            {:else}
              <span class="env-key">
                {entry.key}
                {#if entry.source === "shared"}
                  <span class="env-source">shared</span>
                {/if}
              </span>
              <span class="env-value" class:masked={!revealedKeys.has(entry.key)}>
                {#if revealedKeys.has(entry.key)}
                  {entry.value}
                {:else}
                  --------
                {/if}
              </span>
              <Button variant="icon" onclick={() => toggleReveal(entry.key)} title="Toggle visibility">
                {revealedKeys.has(entry.key) ? "Hide" : "Show"}
              </Button>
              {#if entry.source === "mind"}
                <Button variant="icon" onclick={() => startEditEnv(entry.key, entry.value)} title="Edit">
                  Edit
                </Button>
              {/if}
              <Button
                variant="icon"
                onclick={() => deleteEnv(entry.key, entry.source)}
                disabled={saving !== null}
                title="Delete"
              >
                {saving === `env:${entry.key}` ? "..." : "Del"}
              </Button>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  </SettingsSection>
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

  .env-list {
    display: flex;
    flex-direction: column;
  }

  .env-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 0;
    border-bottom: 1px solid var(--border);
    font-size: 14px;
  }

  .env-row:last-child {
    border-bottom: none;
  }

  .env-add-row {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 0;
    margin-bottom: 8px;
  }

  .env-key {
    font-family: var(--mono);
    font-size: 13px;
    color: var(--text-0);
    flex-shrink: 0;
    min-width: 100px;
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .env-source {
    font-family: inherit;
    font-size: 11px;
    padding: 1px 4px;
    border-radius: 4px;
    background: var(--bg-3);
    color: var(--text-2);
  }

  .env-value {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--mono);
    font-size: 13px;
    color: var(--text-1);
  }

  .env-value.masked {
    color: var(--text-2);
  }

</style>
