<script lang="ts">
import type { SharedSkill } from "@volute/api";
import { onMount } from "svelte";
import {
  addDefaultSkill,
  fetchDefaultSkills,
  fetchSharedSkills,
  removeDefaultSkill,
} from "../lib/client";

let defaults = $state<string[]>([]);
let allSkills = $state<SharedSkill[]>([]);
let loading = $state(true);
let error = $state("");
let actionLoading = $state<string | null>(null);

let available = $derived(allSkills.filter((s) => !defaults.includes(s.id)));

function refresh() {
  Promise.all([fetchDefaultSkills(), fetchSharedSkills()])
    .then(([d, s]) => {
      defaults = d;
      allSkills = s;
      loading = false;
      error = "";
    })
    .catch(() => {
      error = "Failed to load default skills";
      loading = false;
    });
}

onMount(refresh);

async function handleAdd(id: string) {
  actionLoading = id;
  error = "";
  try {
    defaults = await addDefaultSkill(id);
  } catch (e) {
    error = e instanceof Error ? e.message : "Failed to add";
  }
  actionLoading = null;
}

async function handleRemove(id: string) {
  actionLoading = id;
  error = "";
  try {
    defaults = await removeDefaultSkill(id);
  } catch (e) {
    error = e instanceof Error ? e.message : "Failed to remove";
  }
  actionLoading = null;
}

function skillName(id: string): string {
  return allSkills.find((s) => s.id === id)?.name ?? id;
}
</script>

{#if loading}
  <div class="empty">Loading...</div>
{:else}
  {#if error}
    <div class="error">{error}</div>
  {/if}

  <div class="section-header">
    <span class="section-title">Default Skills</span>
    <span class="section-hint">Skills installed when a new mind is created</span>
  </div>

  <div class="skill-list">
    {#each defaults as id (id)}
      <div class="skill-row">
        <span class="skill-name">{skillName(id)}</span>
        <span class="skill-id">{id}</span>
        <button
          class="action-btn remove-btn"
          onclick={() => handleRemove(id)}
          disabled={actionLoading !== null}
        >
          {actionLoading === id ? "..." : "Remove"}
        </button>
      </div>
    {/each}
  </div>

  {#if available.length > 0}
    <div class="add-area">
      <span class="add-label">Add:</span>
      {#each available as skill (skill.id)}
        <button
          class="add-btn"
          onclick={() => handleAdd(skill.id)}
          disabled={actionLoading !== null}
        >
          {actionLoading === skill.id ? "..." : skill.name}
        </button>
      {/each}
    </div>
  {/if}
{/if}

<style>
  .error {
    color: var(--red);
    padding: 8px 0;
    font-size: 13px;
  }

  .empty {
    color: var(--text-2);
    padding: 24px;
    text-align: center;
    font-size: 14px;
  }

  .section-header {
    display: flex;
    align-items: baseline;
    gap: 8px;
    padding: 0 0 12px;
  }

  .section-title {
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-2);
  }

  .section-hint {
    font-size: 12px;
    color: var(--text-3);
  }

  .skill-list {
    display: flex;
    flex-direction: column;
  }

  .skill-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 0;
    border-bottom: 1px solid var(--border);
  }

  .skill-row:last-child {
    border-bottom: none;
  }

  .skill-name {
    font-size: 14px;
    font-weight: 500;
    color: var(--text-0);
  }

  .skill-id {
    font-size: 12px;
    color: var(--text-2);
    flex: 1;
  }

  .action-btn {
    padding: 4px 10px;
    font-size: 12px;
    border-radius: var(--radius);
    font-weight: 500;
    flex-shrink: 0;
  }

  .action-btn:disabled {
    opacity: 0.5;
  }

  .remove-btn {
    background: var(--bg-3);
    color: var(--text-2);
  }

  .remove-btn:hover:not(:disabled) {
    color: var(--red);
  }

  .add-area {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
    padding: 12px 0 0;
  }

  .add-label {
    font-size: 12px;
    color: var(--text-2);
  }

  .add-btn {
    padding: 3px 10px;
    font-size: 12px;
    border-radius: var(--radius);
    background: var(--accent-dim);
    color: var(--accent);
    font-weight: 500;
  }

  .add-btn:hover:not(:disabled) {
    background: var(--accent);
    color: var(--bg-0);
  }

  .add-btn:disabled {
    opacity: 0.5;
  }
</style>
