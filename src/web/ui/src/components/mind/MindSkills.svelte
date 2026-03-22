<script lang="ts">
import type { MindSkillInfo } from "@volute/api";
import { onMount } from "svelte";
import {
  fetchMindSkills,
  publishMindSkill,
  uninstallMindSkill,
  updateMindSkill,
} from "../../lib/client";
import AddSkillModal from "../AddSkillModal.svelte";
import Button from "../ui/Button.svelte";
import EmptyState from "../ui/EmptyState.svelte";
import ErrorMessage from "../ui/ErrorMessage.svelte";
import SectionHeader from "../ui/SectionHeader.svelte";

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
  <EmptyState message="Loading..." />
{:else}
  <ErrorMessage message={error} />

  <SectionHeader title="Skills">
    {#snippet action()}
      <Button variant="primary" onclick={() => (showAddModal = true)}>
        Add skill
      </Button>
    {/snippet}
  </SectionHeader>

  {#if mindSkills.length === 0}
    <EmptyState message="No skills installed." />
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
              <Button
                variant="primary"
                onclick={() => handleUpdate(skill.id)}
                disabled={actionLoading !== null}
              >
                {actionLoading === skill.id ? "..." : "Update"}
              </Button>
            {/if}
            <Button
              variant="secondary"
              onclick={() => handlePublish(skill.id)}
              disabled={actionLoading !== null}
            >
              {actionLoading === skill.id ? "..." : "Publish"}
            </Button>
            <Button
              variant="danger"
              onclick={() => handleUninstall(skill.id)}
              disabled={actionLoading !== null}
            >
              {actionLoading === skill.id ? "..." : "Uninstall"}
            </Button>
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
    font-size: 14px;
    font-weight: 500;
    color: var(--text-0);
    display: flex;
    align-items: center;
    gap: 8px;
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

  .update-badge {
    font-size: 11px;
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
</style>
