<script lang="ts">
import type { MindEnv } from "@volute/api";
import { onMount } from "svelte";
import { SvelteSet } from "svelte/reactivity";
import {
  deleteMindEnvVar,
  deleteSharedEnvVar,
  fetchMindEnv,
  setMindEnvVar,
} from "../../lib/client";
import Button from "./Button.svelte";
import EmptyState from "./EmptyState.svelte";
import ErrorMessage from "./ErrorMessage.svelte";
import Input from "./Input.svelte";
import SettingsSection from "./SettingsSection.svelte";

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
  } catch (e) {
    error = e instanceof Error ? e.message : "Failed to load environment";
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
    if (source === "shared") await deleteSharedEnvVar(key);
    else await deleteMindEnvVar(name, key);
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

<SettingsSection title="Environment Variables">
  {#snippet action()}
    <Button variant="primary" onclick={() => (addingEnv = true)}>Add</Button>
  {/snippet}

  <ErrorMessage message={error} />

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
                ••••••••
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

<style>
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
