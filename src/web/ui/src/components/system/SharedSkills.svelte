<script lang="ts">
import type { SharedSkill } from "@volute/api";
import { onMount } from "svelte";
import {
  addDefaultSkill,
  fetchDefaultSkills,
  fetchSharedSkills,
  removeDefaultSkill,
  removeSharedSkill,
  uploadSkillZip,
} from "../../lib/client";
import Button from "../ui/Button.svelte";
import EmptyState from "../ui/EmptyState.svelte";
import ErrorMessage from "../ui/ErrorMessage.svelte";
import SectionHeader from "../ui/SectionHeader.svelte";

let skills = $state<SharedSkill[]>([]);
let defaults = $state<string[]>([]);
let error = $state("");
let loading = $state(true);
let actionLoading = $state<string | null>(null);

function refresh() {
  Promise.all([fetchSharedSkills(), fetchDefaultSkills()])
    .then(([s, d]) => {
      skills = s.sort((a, b) => a.name.localeCompare(b.name));
      defaults = d;
      loading = false;
      error = "";
    })
    .catch(() => {
      error = "Failed to load skills";
      loading = false;
    });
}

onMount(refresh);

let fileInput = $state<HTMLInputElement>(undefined!);

async function handleUpload() {
  const file = fileInput?.files?.[0];
  if (!file) return;
  actionLoading = "upload";
  error = "";
  try {
    await uploadSkillZip(file);
    refresh();
    fileInput.value = "";
  } catch (e) {
    error = e instanceof Error ? e.message : "Failed to upload";
  }
  actionLoading = null;
}

async function handleDelete(id: string) {
  actionLoading = id;
  error = "";
  try {
    await removeSharedSkill(id);
    refresh();
  } catch (e) {
    error = e instanceof Error ? e.message : "Failed to remove";
  }
  actionLoading = null;
}

async function toggleDefault(id: string) {
  actionLoading = `default:${id}`;
  error = "";
  try {
    if (defaults.includes(id)) {
      defaults = await removeDefaultSkill(id);
    } else {
      defaults = await addDefaultSkill(id);
    }
  } catch (e) {
    error = e instanceof Error ? e.message : "Failed to update defaults";
  }
  actionLoading = null;
}
</script>

{#if loading}
  <EmptyState message="Loading..." />
{:else}
  <ErrorMessage message={error} />

  <SectionHeader title="Skills">
    {#snippet action()}
      <div class="upload-area">
        <input
          type="file"
          accept=".zip"
          bind:this={fileInput}
          onchange={handleUpload}
          class="file-input"
        />
        <Button
          variant="primary"
          onclick={() => fileInput.click()}
          disabled={actionLoading !== null}
        >
          {actionLoading === "upload" ? "Uploading..." : "Upload .zip"}
        </Button>
      </div>
    {/snippet}
  </SectionHeader>

  {#if skills.length === 0}
    <EmptyState message="No shared skills yet." />
  {:else}
    <div class="skill-list">
      <div class="column-header">
        <span class="column-label">Default</span>
      </div>
      {#each skills as skill (skill.id)}
        <div class="skill-row">
          <label class="default-toggle" title={defaults.includes(skill.id) ? "Installed on new minds" : "Not installed on new minds"}>
            <input
              type="checkbox"
              checked={defaults.includes(skill.id)}
              disabled={actionLoading !== null}
              onchange={() => toggleDefault(skill.id)}
            />
            <span class="toggle-track">
              <span class="toggle-thumb"></span>
            </span>
          </label>
          <div class="skill-info">
            <div class="skill-name">{skill.name}</div>
            {#if skill.description}
              <div class="skill-desc">{skill.description}</div>
            {/if}
            <div class="skill-meta">
              {skill.id} &middot; v{skill.version} &middot; by {skill.author}
            </div>
          </div>
          <div class="skill-actions">
            <Button
              variant="danger"
              onclick={() => handleDelete(skill.id)}
              disabled={actionLoading !== null}
            >
              {actionLoading === skill.id ? "..." : "Delete"}
            </Button>
          </div>
        </div>
      {/each}
    </div>
  {/if}
{/if}

<style>
  .upload-area {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .file-input {
    display: none;
  }

  .skill-list {
    display: flex;
    flex-direction: column;
    max-width: 720px;
    margin: 0 auto;
  }

  .column-header {
    padding: 0 0 4px;
  }

  .column-label {
    font-size: 11px;
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    color: var(--text-3);
  }

  .skill-row {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 0;
    border-bottom: 1px solid var(--border);
  }

  .skill-row:last-child {
    border-bottom: none;
  }

  .skill-row:hover {
    background: var(--bg-2);
  }

  .default-toggle {
    flex-shrink: 0;
    cursor: pointer;
    display: flex;
    align-items: center;
  }

  .default-toggle input {
    position: absolute;
    opacity: 0;
    width: 0;
    height: 0;
  }

  .toggle-track {
    display: inline-block;
    width: 32px;
    height: 18px;
    border-radius: 9px;
    background: var(--bg-3);
    position: relative;
    transition: background 0.15s;
  }

  .default-toggle input:checked + .toggle-track {
    background: var(--accent);
  }

  .toggle-thumb {
    position: absolute;
    top: 2px;
    left: 2px;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: var(--text-2);
    transition: transform 0.15s, background 0.15s;
  }

  .default-toggle input:checked + .toggle-track .toggle-thumb {
    transform: translateX(14px);
    background: var(--bg-0);
  }

  .default-toggle input:disabled + .toggle-track {
    opacity: 0.5;
  }

  .skill-info {
    flex: 1;
    min-width: 0;
  }

  .skill-name {
    font-size: 14px;
    font-weight: 500;
    color: var(--text-0);
  }

  .skill-desc {
    font-size: 13px;
    color: var(--text-1);
    margin-top: 2px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .skill-meta {
    font-size: 12px;
    color: var(--text-2);
    margin-top: 2px;
  }

  .skill-actions {
    display: flex;
    gap: 4px;
    flex-shrink: 0;
  }
</style>
