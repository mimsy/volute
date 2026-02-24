<script lang="ts">
import { onMount } from "svelte";
import {
  deleteMindEnvVar,
  fetchMindConfig,
  fetchMindEnv,
  type MindConfig,
  type MindEnv,
  setMindEnvVar,
  updateMindConfig,
} from "../lib/api";

let { name }: { name: string } = $props();

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
let revealedKeys = $state(new Set<string>());
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

function formatDate(dateStr: string): string {
  try {
    const d = new Date(dateStr.endsWith("Z") ? dateStr : `${dateStr}Z`);
    return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  } catch {
    return dateStr;
  }
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
  const next = new Set(revealedKeys);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  revealedKeys = next;
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

async function deleteEnv(key: string) {
  saving = `env:${key}`;
  error = "";
  try {
    await deleteMindEnvVar(name, key);
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

function handleKeydown(e: KeyboardEvent, action: () => void) {
  if (e.key === "Enter") action();
}
</script>

{#if loading}
  <div class="empty">Loading...</div>
{:else if !config}
  <div class="error">Failed to load configuration.</div>
{:else}
  {#if error}
    <div class="error">{error}</div>
  {/if}

  <div class="section">
    <div class="section-title">Info</div>
    <div class="info-grid">
      <div class="info-label">Template</div>
      <div class="info-value">{config.registry.template ?? "unknown"}</div>

      <div class="info-label">Created</div>
      <div class="info-value">{formatDate(config.registry.created)}</div>

      <div class="info-label">Stage</div>
      <div class="info-value">{config.registry.stage ?? "sprouted"}</div>

      <div class="info-label">Port</div>
      <div class="info-value">{config.registry.port}</div>
    </div>
  </div>

  <div class="section">
    <div class="section-title">Settings</div>

    <div class="setting-row">
      <label class="setting-label" for="model-input">Model</label>
      <div class="setting-control">
        <input
          id="model-input"
          type="text"
          class="setting-input"
          bind:value={editModel}
          onkeydown={(e) => handleKeydown(e, handleModelSave)}
          placeholder="e.g. claude-sonnet-4-6"
        />
        <button
          class="save-btn"
          onclick={handleModelSave}
          disabled={saving !== null}
        >
          {saving === "model" ? "..." : "Save"}
        </button>
      </div>
    </div>

    <div class="setting-row">
      <label class="setting-label" for="thinking-select">Thinking</label>
      <div class="setting-control">
        <select
          id="thinking-select"
          class="setting-select"
          value={editThinking}
          onchange={handleThinkingChange}
          disabled={saving !== null}
        >
          {#each THINKING_LEVELS as level}
            <option value={level}>{level}</option>
          {/each}
        </select>
      </div>
    </div>

    <div class="setting-row">
      <label class="setting-label" for="budget-input">Token budget</label>
      <div class="setting-control">
        <input
          id="budget-input"
          type="number"
          class="setting-input narrow"
          bind:value={editBudget}
          onkeydown={(e) => handleKeydown(e, handleBudgetSave)}
          placeholder="tokens"
        />
        <span class="setting-hint">per</span>
        <input
          id="period-input"
          type="number"
          class="setting-input narrow"
          bind:value={editPeriod}
          onkeydown={(e) => handleKeydown(e, handleBudgetSave)}
          placeholder="60"
        />
        <span class="setting-hint">min</span>
        <button
          class="save-btn"
          onclick={handleBudgetSave}
          disabled={saving !== null}
        >
          {saving === "budget" ? "..." : "Save"}
        </button>
      </div>
    </div>
  </div>

  <div class="section">
    <div class="section-header">
      <span class="section-title">Environment Variables</span>
      <button class="add-btn" onclick={() => (addingEnv = true)}>Add</button>
    </div>

    {#if addingEnv}
      <div class="env-add-row">
        <input
          type="text"
          class="env-input key"
          bind:value={newEnvKey}
          placeholder="KEY"
          onkeydown={(e) => handleKeydown(e, addEnvVar)}
        />
        <input
          type="text"
          class="env-input value"
          bind:value={newEnvValue}
          placeholder="value"
          onkeydown={(e) => handleKeydown(e, addEnvVar)}
        />
        <button class="save-btn" onclick={addEnvVar} disabled={saving !== null}>
          {saving === "env:add" ? "..." : "Add"}
        </button>
        <button class="cancel-btn" onclick={() => (addingEnv = false)}>Cancel</button>
      </div>
    {/if}

    {#if mergedEnv.length === 0}
      <div class="empty small">No environment variables set.</div>
    {:else}
      <div class="env-list">
        {#each mergedEnv as entry (entry.key)}
          <div class="env-row">
            {#if editingEnvKey === entry.key}
              <span class="env-key">{entry.key}</span>
              <input
                type="text"
                class="env-input value"
                bind:value={editingEnvValue}
                onkeydown={(e) => handleKeydown(e, saveEnvEdit)}
              />
              <button class="save-btn" onclick={saveEnvEdit} disabled={saving !== null}>
                {saving === `env:${entry.key}` ? "..." : "Save"}
              </button>
              <button class="cancel-btn" onclick={() => (editingEnvKey = null)}>Cancel</button>
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
                  ••••••••
                {/if}
              </span>
              <button class="icon-btn" onclick={() => toggleReveal(entry.key)} title="Toggle visibility">
                {revealedKeys.has(entry.key) ? "Hide" : "Show"}
              </button>
              {#if entry.source === "mind"}
                <button class="icon-btn" onclick={() => startEditEnv(entry.key, entry.value)} title="Edit">
                  Edit
                </button>
                <button
                  class="icon-btn danger"
                  onclick={() => deleteEnv(entry.key)}
                  disabled={saving !== null}
                  title="Delete"
                >
                  {saving === `env:${entry.key}` ? "..." : "Del"}
                </button>
              {/if}
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  </div>
{/if}

<style>
  .empty {
    color: var(--text-2);
    padding: 24px;
    text-align: center;
    font-size: 13px;
  }

  .empty.small {
    padding: 12px;
  }

  .error {
    color: var(--red);
    padding: 8px 0;
    font-size: 12px;
  }

  .section {
    margin-bottom: 24px;
  }

  .section-title {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-2);
    margin-bottom: 8px;
  }

  .section-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 8px;
  }

  .info-grid {
    display: grid;
    grid-template-columns: 100px 1fr;
    gap: 6px 12px;
    font-size: 13px;
  }

  .info-label {
    color: var(--text-2);
  }

  .info-value {
    color: var(--text-0);
  }

  .setting-row {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 6px 0;
  }

  .setting-label {
    width: 100px;
    flex-shrink: 0;
    font-size: 13px;
    color: var(--text-1);
  }

  .setting-control {
    display: flex;
    align-items: center;
    gap: 6px;
    flex: 1;
  }

  .setting-input {
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 4px 8px;
    font-size: 13px;
    color: var(--text-0);
    flex: 1;
    font-family: inherit;
  }

  .setting-input.narrow {
    width: 80px;
    flex: 0 0 80px;
  }

  .setting-input:focus {
    border-color: var(--accent);
    outline: none;
  }

  .setting-select {
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 4px 8px;
    font-size: 13px;
    color: var(--text-0);
    font-family: inherit;
  }

  .setting-hint {
    font-size: 12px;
    color: var(--text-2);
    flex-shrink: 0;
  }

  .save-btn {
    padding: 4px 10px;
    font-size: 11px;
    border-radius: var(--radius);
    background: var(--accent-dim);
    color: var(--accent);
    font-weight: 500;
    flex-shrink: 0;
  }

  .save-btn:disabled {
    opacity: 0.5;
  }

  .cancel-btn {
    padding: 4px 10px;
    font-size: 11px;
    border-radius: var(--radius);
    background: var(--bg-3);
    color: var(--text-2);
    font-weight: 500;
    flex-shrink: 0;
  }

  .add-btn {
    padding: 4px 12px;
    font-size: 11px;
    border-radius: var(--radius);
    background: var(--accent-dim);
    color: var(--accent);
    font-weight: 500;
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
    font-size: 13px;
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
    font-family: monospace;
    font-size: 12px;
    color: var(--text-0);
    flex-shrink: 0;
    min-width: 100px;
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .env-source {
    font-family: inherit;
    font-size: 10px;
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
    font-family: monospace;
    font-size: 12px;
    color: var(--text-1);
  }

  .env-value.masked {
    color: var(--text-2);
  }

  .env-input {
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 4px 8px;
    font-size: 12px;
    color: var(--text-0);
    font-family: monospace;
  }

  .env-input.key {
    width: 120px;
    flex-shrink: 0;
  }

  .env-input.value {
    flex: 1;
  }

  .icon-btn {
    padding: 2px 6px;
    font-size: 10px;
    border-radius: var(--radius);
    background: var(--bg-3);
    color: var(--text-2);
    flex-shrink: 0;
  }

  .icon-btn:hover {
    color: var(--text-0);
  }

  .icon-btn.danger:hover {
    color: var(--red);
  }
</style>
