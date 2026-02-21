<script lang="ts">
import {
  fetchMindSkills,
  fetchSharedSkills,
  installMindSkill,
  type MindSkillInfo,
  publishMindSkill,
  type SharedSkill,
  uninstallMindSkill,
  updateMindSkill,
  uploadSkillZip,
} from "../lib/api";

let { name }: { name: string } = $props();

let mindSkills = $state<MindSkillInfo[]>([]);
let sharedSkills = $state<SharedSkill[]>([]);
let error = $state("");
let loading = $state(true);
let showShared = $state(false);
let actionLoading = $state<string | null>(null);
let sharedLoading = $state(false);

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

$effect(() => {
  refresh();
});

async function loadShared() {
  sharedLoading = true;
  try {
    sharedSkills = await fetchSharedSkills();
    showShared = true;
  } catch {
    error = "Failed to load shared skills";
  }
  sharedLoading = false;
}

let installedIds = $derived(new Set(mindSkills.map((s) => s.id)));

async function handleInstall(skillId: string) {
  actionLoading = skillId;
  error = "";
  try {
    await installMindSkill(name, skillId);
    refresh();
    sharedSkills = await fetchSharedSkills();
  } catch (e) {
    error = e instanceof Error ? e.message : "Failed to install";
  }
  actionLoading = null;
}

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

let fileInput = $state<HTMLInputElement>(undefined!);

async function handleUpload() {
  const file = fileInput?.files?.[0];
  if (!file) return;
  actionLoading = "upload";
  error = "";
  try {
    await uploadSkillZip(file);
    sharedSkills = await fetchSharedSkills();
    fileInput.value = "";
  } catch (e) {
    error = e instanceof Error ? e.message : "Failed to upload";
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

  <!-- Installed Skills -->
  <div class="section-header">
    <span class="section-title">Installed</span>
    <button
      class="browse-btn"
      onclick={loadShared}
      disabled={sharedLoading}
    >
      {sharedLoading ? "Loading..." : showShared ? "Refresh" : "Browse shared"}
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
                disabled={actionLoading === skill.id}
              >
                {actionLoading === skill.id ? "..." : "Update"}
              </button>
            {/if}
            <button
              class="action-btn publish-btn"
              onclick={() => handlePublish(skill.id)}
              disabled={actionLoading === skill.id}
            >
              {actionLoading === skill.id ? "..." : "Publish"}
            </button>
            <button
              class="action-btn remove-btn"
              onclick={() => handleUninstall(skill.id)}
              disabled={actionLoading === skill.id}
            >
              {actionLoading === skill.id ? "..." : "Uninstall"}
            </button>
          </div>
        </div>
      {/each}
    </div>
  {/if}

  <!-- Shared Skills Browser -->
  {#if showShared}
    <div class="section-header shared-header">
      <span class="section-title">Shared Skills</span>
      <div class="upload-area">
        <input
          type="file"
          accept=".zip"
          bind:this={fileInput}
          onchange={handleUpload}
          class="file-input"
        />
        <button
          class="upload-btn"
          onclick={() => fileInput.click()}
          disabled={actionLoading === "upload"}
        >
          {actionLoading === "upload" ? "Uploading..." : "Upload .zip"}
        </button>
      </div>
    </div>

    {#if sharedSkills.length === 0}
      <div class="empty">No shared skills available.</div>
    {:else}
      <div class="skill-list">
        {#each sharedSkills as skill (skill.id)}
          <div class="skill-row">
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
              {#if installedIds.has(skill.id)}
                <span class="installed-tag">installed</span>
              {:else}
                <button
                  class="action-btn install-btn"
                  onclick={() => handleInstall(skill.id)}
                  disabled={actionLoading === skill.id}
                >
                  {actionLoading === skill.id ? "..." : "Install"}
                </button>
              {/if}
            </div>
          </div>
        {/each}
      </div>
    {/if}
  {/if}
{/if}

<style>
  .error {
    color: var(--red);
    padding: 8px 12px;
    font-size: 12px;
  }

  .empty {
    color: var(--text-2);
    padding: 24px;
    text-align: center;
    font-size: 13px;
  }

  .section-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 12px;
  }

  .shared-header {
    margin-top: 16px;
    border-top: 1px solid var(--border);
    padding-top: 16px;
  }

  .section-title {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-2);
  }

  .browse-btn {
    padding: 4px 12px;
    font-size: 11px;
    border-radius: var(--radius);
    background: var(--accent-dim);
    color: var(--accent);
    font-weight: 500;
  }

  .browse-btn:disabled {
    opacity: 0.5;
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
    padding: 10px 12px;
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

  .installed-tag {
    font-size: 11px;
    color: var(--text-2);
    font-style: italic;
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

  .install-btn,
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

  .upload-area {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .file-input {
    display: none;
  }

  .upload-btn {
    padding: 4px 12px;
    font-size: 11px;
    border-radius: var(--radius);
    background: var(--bg-3);
    color: var(--text-1);
    font-weight: 500;
  }

  .upload-btn:disabled {
    opacity: 0.5;
  }
</style>
