<script lang="ts">
import type { Prompt } from "@volute/api";
import { onMount } from "svelte";
import { fetchPrompts, resetPrompt, updatePrompt } from "../lib/client";

let prompts = $state<Prompt[]>([]);
let loading = $state(true);
let editingKey = $state<string | null>(null);
let editContent = $state("");
let saving = $state(false);
let error = $state("");

// Track which categories are expanded
let expanded = $state<Record<string, boolean>>({});

const categoryMeta: Record<string, { label: string; subtitle: string }> = {
  creation: { label: "Creation Prompts", subtitle: "Used when creating new minds" },
  system: { label: "System Messages", subtitle: "Sent by the daemon to minds" },
  mind: {
    label: "Mind Prompts",
    subtitle: "Stamped into prompts.json at creation, then mind-owned",
  },
};

const categoryOrder = ["creation", "system", "mind"];

let groupedPrompts = $derived(
  categoryOrder
    .map((cat) => ({
      category: cat,
      meta: categoryMeta[cat],
      items: prompts.filter((p) => p.category === cat),
    }))
    .filter((g) => g.items.length > 0),
);

async function load() {
  try {
    prompts = await fetchPrompts();
    error = "";
  } catch (e) {
    error = e instanceof Error ? e.message : "Failed to load prompts";
  } finally {
    loading = false;
  }
}

onMount(load);

function toggleCategory(cat: string) {
  expanded[cat] = !expanded[cat];
}

function startEdit(prompt: Prompt) {
  editingKey = prompt.key;
  editContent = prompt.content;
  // Auto-expand the category
  expanded[prompt.category] = true;
}

function cancelEdit() {
  editingKey = null;
  editContent = "";
}

async function save(key: string) {
  saving = true;
  try {
    await updatePrompt(key, editContent);
    editingKey = null;
    editContent = "";
    await load();
  } catch (e) {
    error = e instanceof Error ? e.message : "Failed to save";
  } finally {
    saving = false;
  }
}

async function handleReset(key: string) {
  saving = true;
  try {
    await resetPrompt(key);
    editingKey = null;
    editContent = "";
    await load();
  } catch (e) {
    error = e instanceof Error ? e.message : "Failed to reset";
  } finally {
    saving = false;
  }
}
</script>

<div class="prompts-page">
  {#if error}
    <div class="error">{error}</div>
  {/if}

  {#if loading}
    <div class="loading">Loading prompts...</div>
  {:else}
    {#each groupedPrompts as group (group.category)}
      <div class="section">
        <button class="section-header" onclick={() => toggleCategory(group.category)}>
          <span class="collapse-icon">{expanded[group.category] ? "\u25BC" : "\u25B6"}</span>
          <span class="section-title">{group.meta.label}</span>
          <span class="section-subtitle">{group.meta.subtitle}</span>
          {#if group.items.some((p) => p.isCustom)}
            <span class="custom-count">{group.items.filter((p) => p.isCustom).length} customized</span>
          {/if}
        </button>

        {#if expanded[group.category]}
          <div class="section-body">
            {#each group.items as prompt (prompt.key)}
              <div class="prompt-card" class:custom={prompt.isCustom}>
                <div class="prompt-header">
                  <span class="prompt-key">{prompt.key}</span>
                  {#if prompt.isCustom}
                    <span class="custom-badge">customized</span>
                  {/if}
                </div>

                <p class="prompt-desc">{prompt.description}</p>

                {#if prompt.variables.length > 0}
                  <div class="var-tags">
                    {#each prompt.variables as v (v)}
                      <span class="var-tag">${'{' + v + '}'}</span>
                    {/each}
                  </div>
                {/if}

                {#if editingKey === prompt.key}
                  <textarea
                    class="edit-area"
                    bind:value={editContent}
                    rows="10"
                  ></textarea>
                  <div class="actions">
                    <button class="btn btn-save" onclick={() => save(prompt.key)} disabled={saving}>
                      {saving ? "Saving..." : "Save"}
                    </button>
                    <button class="btn btn-cancel" onclick={cancelEdit} disabled={saving}>
                      Cancel
                    </button>
                  </div>
                {:else}
                  <pre class="prompt-content"><code>{prompt.content}</code></pre>
                  <div class="actions">
                    <button class="btn btn-edit" onclick={() => startEdit(prompt)}>Edit</button>
                    {#if prompt.isCustom}
                      <button
                        class="btn btn-reset"
                        onclick={() => handleReset(prompt.key)}
                        disabled={saving}
                      >
                        Reset
                      </button>
                    {/if}
                  </div>
                {/if}
              </div>
            {/each}
          </div>
        {/if}
      </div>
    {/each}
  {/if}
</div>

<style>
  .prompts-page {
    max-width: 720px;
    margin: 0 auto;
    animation: fadeIn 0.2s ease both;
  }

  .error {
    color: var(--red);
    font-size: 13px;
    margin-bottom: 16px;
  }

  .loading {
    color: var(--text-2);
    font-size: 13px;
    padding: 40px 0;
    text-align: center;
  }

  .section {
    margin-bottom: 8px;
  }

  .section-header {
    display: flex;
    align-items: baseline;
    gap: 8px;
    width: 100%;
    padding: 10px 12px;
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    cursor: pointer;
    text-align: left;
    color: inherit;
    font: inherit;
  }

  .section-header:hover {
    border-color: var(--border-bright);
  }

  .collapse-icon {
    font-size: 10px;
    color: var(--text-2);
    width: 12px;
    flex-shrink: 0;
  }

  .section-title {
    font-size: 14px;
    font-weight: 600;
    color: var(--text-0);
  }

  .section-subtitle {
    font-size: 12px;
    color: var(--text-2);
  }

  .custom-count {
    font-size: 11px;
    padding: 1px 6px;
    border-radius: 3px;
    background: var(--yellow-dim);
    color: var(--yellow);
    margin-left: auto;
  }

  .section-body {
    padding: 8px 0 0 0;
  }

  .prompt-card {
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: 14px 16px;
    margin-bottom: 8px;
  }

  .prompt-card.custom {
    border-color: var(--yellow-dim);
  }

  .prompt-header {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 4px;
  }

  .prompt-key {
    font-family: var(--mono);
    font-size: 14px;
    font-weight: 600;
    color: var(--text-0);
  }

  .custom-badge {
    font-size: 11px;
    padding: 1px 6px;
    border-radius: 3px;
    background: var(--yellow-dim);
    color: var(--yellow);
  }

  .prompt-desc {
    font-size: 13px;
    color: var(--text-2);
    margin-bottom: 8px;
    line-height: 1.5;
  }

  .var-tags {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-bottom: 10px;
  }

  .var-tag {
    font-family: var(--mono);
    font-size: 11px;
    padding: 2px 6px;
    border-radius: 3px;
    background: var(--bg-3);
    color: var(--accent);
    border: 1px solid var(--border);
  }

  .prompt-content {
    background: var(--bg-3);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 10px 12px;
    overflow-x: auto;
    font-family: var(--mono);
    font-size: 13px;
    line-height: 1.5;
    color: var(--text-1);
    white-space: pre-wrap;
    word-break: break-word;
    margin-bottom: 8px;
  }

  .prompt-content code {
    font-family: inherit;
    font-size: inherit;
  }

  .edit-area {
    width: 100%;
    min-height: 120px;
    background: var(--bg-3);
    border: 1px solid var(--accent-dim);
    border-radius: var(--radius);
    padding: 10px 12px;
    font-family: var(--mono);
    font-size: 14px;
    line-height: 1.5;
    color: var(--text-0);
    resize: vertical;
    margin-bottom: 8px;
  }

  .edit-area:focus {
    outline: none;
    border-color: var(--accent);
  }

  .actions {
    display: flex;
    gap: 6px;
  }

  .btn {
    font-family: inherit;
    font-size: 12px;
    padding: 4px 10px;
    border-radius: var(--radius);
    cursor: pointer;
    border: 1px solid transparent;
    transition: opacity 0.15s;
  }

  .btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .btn-edit {
    background: var(--bg-3);
    color: var(--text-1);
    border-color: var(--border);
  }

  .btn-edit:hover {
    color: var(--text-0);
    border-color: var(--border-bright);
  }

  .btn-save {
    background: var(--accent-dim);
    color: var(--accent);
    border-color: var(--accent-border);
  }

  .btn-save:hover:not(:disabled) {
    border-color: var(--accent);
  }

  .btn-cancel {
    background: var(--bg-3);
    color: var(--text-2);
    border-color: var(--border);
  }

  .btn-cancel:hover:not(:disabled) {
    color: var(--text-1);
  }

  .btn-reset {
    background: var(--red-bg);
    color: var(--red);
    border-color: var(--red-border);
  }

  .btn-reset:hover:not(:disabled) {
    border-color: var(--red);
  }
</style>
