<script lang="ts">
import type { SharedSkill } from "@volute/api";
import { onMount } from "svelte";
import { fetchSharedSkills, installMindSkill } from "../lib/client";
import Modal from "./Modal.svelte";
import Button from "./ui/Button.svelte";
import EmptyState from "./ui/EmptyState.svelte";
import ErrorMessage from "./ui/ErrorMessage.svelte";

let {
  name,
  installedIds,
  onClose,
  onInstalled,
}: {
  name: string;
  installedIds: Set<string>;
  onClose: () => void;
  onInstalled: () => void;
} = $props();

let skills = $state<SharedSkill[]>([]);
let error = $state("");
let loading = $state(true);
let actionLoading = $state<string | null>(null);

onMount(() => {
  fetchSharedSkills()
    .then((s) => {
      skills = s;
      loading = false;
    })
    .catch(() => {
      error = "Failed to load shared skills";
      loading = false;
    });
});

async function handleInstall(skillId: string) {
  actionLoading = skillId;
  error = "";
  try {
    await installMindSkill(name, skillId);
    onInstalled();
    // Refresh the list to update installed status
    try {
      skills = await fetchSharedSkills();
    } catch {}
  } catch (e) {
    error = e instanceof Error ? e.message : "Failed to install";
  }
  actionLoading = null;
}
</script>

<Modal size="480px" title="Add Skill" {onClose}>
  <div class="modal-body">
    <ErrorMessage message={error} />

    {#if loading}
      <EmptyState message="Loading..." />
    {:else if skills.length === 0}
      <EmptyState message="No shared skills available." />
    {:else}
      <div class="skill-list">
        {#each skills as skill (skill.id)}
          <div class="skill-row">
            <div class="skill-info">
              <div class="skill-name">{skill.name}</div>
              {#if skill.description}
                <div class="skill-desc">{skill.description}</div>
              {/if}
              <div class="skill-meta">
                {skill.id} &middot; v{skill.version}
              </div>
            </div>
            <div class="skill-actions">
              {#if installedIds.has(skill.id)}
                <span class="installed-tag">installed</span>
              {:else}
                <Button
                  variant="primary"
                  onclick={() => handleInstall(skill.id)}
                  disabled={actionLoading !== null}
                >
                  {actionLoading === skill.id ? "..." : "Install"}
                </Button>
              {/if}
            </div>
          </div>
        {/each}
      </div>
    {/if}
  </div>
</Modal>

<style>
  .modal-body {
    flex: 1;
    overflow: auto;
    padding: 8px 16px 16px;
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
    padding: 10px 0;
    border-bottom: 1px solid var(--border);
  }

  .skill-row:last-child {
    border-bottom: none;
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
    flex-shrink: 0;
  }

  .installed-tag {
    font-size: 12px;
    color: var(--text-2);
    font-style: italic;
  }
</style>
