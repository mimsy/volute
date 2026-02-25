<script lang="ts">
import { onMount } from "svelte";
import {
  fetchMindSkills,
  type MindSkillInfo,
  publishMindSkill,
  uninstallMindSkill,
  updateMindSkill,
} from "../lib/api";
import AddSkillModal from "./AddSkillModal.svelte";

let { name }: { name: string } = $props();

let mindSkills = $state<MindSkillInfo[]>([]);
let error = $state("");
let loading = $state(true);
let actionLoading = $state<string | null>(null);
let showAddModal = $state(false);

function refresh() {
  fetchMindSkills(name)
    .then((s) => {
      mindSkills = s;
      loading = false;
      error = "";
    })
    .catch(() => {
      error = "Failed to load skills";
      loading = false;
    });
}

onMount(() => {
  refresh();
});

let installedIds = $derived(new Set(mindSkills.map((s) => s.id)));

async function handleUpdate(skillId: string) {
  actionLoading = skillId;
  error = "";
  try {
    const result = await updateMindSkill(name, skillId);
    if (result.status === "conflict") {
      error = `Merge conflicts in: ${result.conflictFiles?.join(", ")}. Resolve manually.`;
    }
    refresh();
  } catch (e) {
    error = e instanceof Error ? e.message : "Failed to update";
  }
  actionLoading = null;
}

async function handlePublish(skillId: string) {
  actionLoading = skillId;
  error = "";
  try {
    await publishMindSkill(name, skillId);
    refresh();
  } catch (e) {
    error = e instanceof Error ? e.message : "Failed to publish";
  }
  actionLoading = null;
}

async function handleUninstall(skillId: string) {
  actionLoading = skillId;
  error = "";
  try {
    await uninstallMindSkill(name, skillId);
    refresh();
  } catch (e) {
    error = e instanceof Error ? e.message : "Failed to uninstall";
  }
  actionLoading = null;
}
</script>

{#if loading}
  <div class="empty">Loading...</div>
{:else}
  {#if error}
    <div class="error">{error}</div>
  {/if}

  <div class="section-header">
    <span class="section-title">Skills</span>
    <button class="add-btn" onclick={() => (showAddModal = true)}>
      Add skill
    </button>
  </div>

  {#if mindSkills.length === 0}
    <div class="empty">No skills installed.</div>
  {:else}
    <div class="skill-list">
      {#each mindSkills as skill (skill.id)}
        <div class="skill-row">
          <div class="skill-info">
            <div class="skill-name">
              {skill.name}
              {#if skill.updateAvailable}
                <span class="update-badge">update available</span>
              {/if}
            </div>
            {#if skill.description}
              <div class="skill-desc">{skill.description}</div>
            {/if}
            <div class="skill-meta">
              {skill.id}
              {#if skill.upstream}
                <span class="upstream-tag">v{skill.upstream.version}</span>
              {:else}
                <span class="local-tag">local</span>
              {/if}
            </div>
          </div>
          <div class="skill-actions">
            {#if skill.updateAvailable}
              <button
                class="action-btn update-btn"
                onclick={() => handleUpdate(skill.id)}
                disabled={actionLoading !== null}
              >
                {actionLoading === skill.id ? "..." : "Update"}
              </button>
            {/if}
            <button
              class="action-btn publish-btn"
              onclick={() => handlePublish(skill.id)}
              disabled={actionLoading !== null}
            >
              {actionLoading === skill.id ? "..." : "Publish"}
            </button>
            <button
              class="action-btn remove-btn"
              onclick={() => handleUninstall(skill.id)}
              disabled={actionLoading !== null}
            >
              {actionLoading === skill.id ? "..." : "Uninstall"}
            </button>
          </div>
        </div>
      {/each}
    </div>
  {/if}
{/if}

{#if showAddModal}
  <AddSkillModal
    {name}
    {installedIds}
    onClose={() => (showAddModal = false)}
    onInstalled={refresh}
  />
{/if}

<style>
  .error {
    color: var(--red);
    padding: 8px 0;
    font-size: 12px;
  }

  .empty {
    color: var(--text-2);
    padding: 12px 0;
    font-size: 13px;
  }

  .section-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 8px;
  }

  .section-title {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-2);
  }

  .add-btn {
    padding: 4px 12px;
    font-size: 11px;
    border-radius: var(--radius);
    background: var(--accent-dim);
    color: var(--accent);
    font-weight: 500;
  }

  .skill-list {
    display: flex;
    flex-direction: column;
  }

  .skill-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 6px 0;
    border-bottom: 1px solid var(--border);
  }

  .skill-row:last-child {
    border-bottom: none;
  }

  .skill-row:hover {
    background: var(--bg-2);
  }

  .skill-info {
    flex: 1;
    min-width: 0;
  }

  .skill-name {
    font-size: 13px;
    font-weight: 500;
    color: var(--text-0);
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .skill-desc {
    font-size: 12px;
    color: var(--text-1);
    margin-top: 2px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .skill-meta {
    font-size: 11px;
    color: var(--text-2);
    margin-top: 2px;
  }

  .update-badge {
    font-size: 10px;
    padding: 1px 6px;
    border-radius: 8px;
    background: var(--accent-dim);
    color: var(--accent);
    font-weight: 500;
  }

  .upstream-tag {
    color: var(--text-2);
  }

  .local-tag {
    font-style: italic;
    color: var(--text-2);
  }

  .skill-actions {
    display: flex;
    gap: 4px;
    flex-shrink: 0;
  }

  .action-btn {
    padding: 4px 10px;
    font-size: 11px;
    border-radius: var(--radius);
    font-weight: 500;
  }

  .action-btn:disabled {
    opacity: 0.5;
  }

  .update-btn {
    background: var(--accent-dim);
    color: var(--accent);
  }

  .publish-btn {
    background: var(--bg-3);
    color: var(--text-1);
  }

  .remove-btn {
    background: var(--bg-3);
    color: var(--text-2);
  }

  .remove-btn:hover {
    color: var(--red);
  }
</style>
