<script lang="ts">
import type { MindEnv } from "@volute/api";
import { onMount } from "svelte";
import { SvelteSet } from "svelte/reactivity";
import { deleteMindEnvVar, deleteSharedEnvVar, fetchMindEnv, setMindEnvVar } from "../lib/client";

let { name }: { name: string } = $props();

let env = $state<MindEnv | null>(null);
let error = $state("");
let saving = $state<string | null>(null);

let revealedKeys = new SvelteSet<string>();
let addingEnv = $state(false);
let newEnvKey = $state("");
let newEnvValue = $state("");
let editingEnvKey = $state<string | null>(null);
let editingEnvValue = $state("");

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

async function refresh() {
  try {
    env = await fetchMindEnv(name);
    error = "";
  } catch {
    error = "Failed to load environment";
  }
}

onMount(() => {
  refresh();
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

function handleKeydown(e: KeyboardEvent, action: () => void) {
  if (e.key === "Enter") action();
}
</script>

<div class="section">
  <div class="section-header">
    <span class="section-title">Environment Variables</span>
    <button class="add-btn" onclick={() => (addingEnv = true)}>Add</button>
  </div>

  {#if error}
    <div class="error">{error}</div>
  {/if}

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
            {/if}
            <button
              class="icon-btn danger"
              onclick={() => deleteEnv(entry.key, entry.source)}
              disabled={saving !== null}
              title="Delete"
            >
              {saving === `env:${entry.key}` ? "..." : "Del"}
            </button>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
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

  .section-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 8px;
  }

  .error {
    color: var(--red);
    padding: 8px 0;
    font-size: 13px;
  }

  .empty.small {
    color: var(--text-2);
    padding: 12px;
    text-align: center;
    font-size: 14px;
  }

  .save-btn {
    padding: 4px 10px;
    font-size: 12px;
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
    font-size: 12px;
    border-radius: var(--radius);
    background: var(--bg-3);
    color: var(--text-2);
    font-weight: 500;
    flex-shrink: 0;
  }

  .add-btn {
    padding: 4px 12px;
    font-size: 12px;
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

  .env-input {
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 4px 8px;
    font-size: 13px;
    color: var(--text-0);
    font-family: var(--mono);
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
    font-size: 11px;
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
