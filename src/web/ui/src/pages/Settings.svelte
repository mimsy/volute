<script lang="ts">
import type { Prompt } from "@volute/api";
import { onMount } from "svelte";
import {
  fetchPrompts,
  resetPrompt,
  systemLogin,
  systemLogout,
  systemRegister,
  updatePrompt,
} from "../lib/client";
import { auth } from "../lib/stores.svelte";

let prompts = $state<Prompt[]>([]);
let loading = $state(true);
let editingKey = $state<string | null>(null);
let editContent = $state("");
let saving = $state(false);
let error = $state("");

// System registration state
let systemError = $state("");
let systemAction = $state<"none" | "register" | "login">("none");
let systemInput = $state("");
let systemSaving = $state(false);

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

onMount(() => {
  load();
});

async function handleSystemAction() {
  if (!systemInput.trim() || systemSaving) return;
  systemSaving = true;
  systemError = "";
  try {
    const fn = systemAction === "register" ? systemRegister : systemLogin;
    const result = await fn(systemInput.trim());
    auth.systemName = result.system;
    systemAction = "none";
    systemInput = "";
  } catch (err) {
    systemError = err instanceof Error ? err.message : `${systemAction} failed`;
  } finally {
    systemSaving = false;
  }
}

async function handleSystemLogout() {
  systemSaving = true;
  systemError = "";
  try {
    await systemLogout();
    auth.systemName = null;
  } catch (err) {
    systemError = err instanceof Error ? err.message : "Logout failed";
  } finally {
    systemSaving = false;
  }
}

function startEdit(prompt: Prompt) {
  editingKey = prompt.key;
  editContent = prompt.content;
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

<div class="settings">
  <!-- System Registration -->
  <div class="section">
    <div class="section-header">
      <span class="section-title">System</span>
      <span class="section-subtitle">Registration with volute.systems for pages and email</span>
    </div>

    {#if auth.systemName}
      <div class="system-card">
        <div class="system-info">
          <span class="system-label">Registered as</span>
          <span class="system-name">{auth.systemName}</span>
        </div>
        <button
          class="btn btn-reset"
          onclick={handleSystemLogout}
          disabled={systemSaving}
        >
          {systemSaving ? "..." : "Disconnect"}
        </button>
      </div>
    {:else}
      <div class="system-card">
        <div class="system-info">
          <span class="system-label">Not registered</span>
        </div>
        {#if systemAction === "none"}
          <div class="system-actions">
            <button class="btn btn-edit" onclick={() => { systemAction = "register"; systemInput = ""; systemError = ""; }}>
              Register
            </button>
            <button class="btn btn-edit" onclick={() => { systemAction = "login"; systemInput = ""; systemError = ""; }}>
              Login with key
            </button>
          </div>
        {:else}
          <form class="system-form" onsubmit={(e) => { e.preventDefault(); handleSystemAction(); }}>
            <input
              type={systemAction === "login" ? "password" : "text"}
              bind:value={systemInput}
              placeholder={systemAction === "register" ? "System name" : "API key"}
              class="system-input"
            />
            <button type="submit" class="btn btn-save" disabled={systemSaving || !systemInput.trim()}>
              {systemSaving ? "..." : systemAction === "register" ? "Register" : "Login"}
            </button>
            <button type="button" class="btn btn-cancel" onclick={() => { systemAction = "none"; systemError = ""; }}>
              Cancel
            </button>
          </form>
        {/if}
      </div>
    {/if}
    {#if systemError}
      <div class="error">{systemError}</div>
    {/if}
  </div>

  <!-- Prompts -->
  {#if error}
    <div class="error">{error}</div>
  {/if}

  {#if loading}
    <div class="loading">Loading prompts...</div>
  {:else}
    {#each groupedPrompts as group (group.category)}
      <div class="section">
        <div class="section-header">
          <span class="section-title">{group.meta.label}</span>
          <span class="section-subtitle">{group.meta.subtitle}</span>
        </div>

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
    {/each}
  {/if}
</div>

<style>
  .settings {
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
    margin-bottom: 32px;
  }

  .section-header {
    display: flex;
    align-items: baseline;
    gap: 10px;
    margin-bottom: 12px;
  }

  .section-title {
    font-size: 15px;
    font-weight: 600;
    color: var(--text-0);
  }

  .section-subtitle {
    font-size: 12px;
    color: var(--text-2);
  }

  .prompt-card {
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: 14px 16px;
    margin-bottom: 10px;
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

  .system-card {
    display: flex;
    align-items: center;
    gap: 12px;
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: 14px 16px;
  }

  .system-info {
    display: flex;
    align-items: baseline;
    gap: 8px;
    flex: 1;
  }

  .system-label {
    font-size: 13px;
    color: var(--text-2);
  }

  .system-name {
    font-size: 14px;
    font-weight: 600;
    color: var(--text-0);
  }

  .system-actions {
    display: flex;
    gap: 6px;
  }

  .system-form {
    display: flex;
    align-items: center;
    gap: 6px;
    flex: 1;
  }

  .system-input {
    flex: 1;
    padding: 6px 10px;
    background: var(--bg-3);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    color: var(--text-0);
    font-size: 13px;
    outline: none;
  }

  .system-input:focus {
    border-color: var(--border-bright);
  }
</style>
