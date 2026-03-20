<script lang="ts">
import {
  fetchImagegenModels,
  fetchImagegenProviders,
  type ImagegenModelSearchResult,
  type ImagegenProvider,
  removeImagegenProviderConfig,
  saveEnabledImagegenModels,
  saveImagegenProviderConfig,
  searchImagegenModels,
} from "../lib/client";
import Modal from "./Modal.svelte";

let providers = $state<ImagegenProvider[]>([]);
let enabledModels = $state<string[]>([]);
let error = $state("");
let saving = $state(false);

// API key modal
let showApiKeyModal = $state(false);
let selectedProvider = $state("");
let apiKeyInput = $state("");

// Model search modal
let showModelModal = $state(false);
let modelSearch = $state("");
let modelSearchResults = $state<ImagegenModelSearchResult[]>([]);
let searching = $state(false);

let configuredProviders = $derived(providers.filter((p) => p.configured));
let unconfiguredProviders = $derived(providers.filter((p) => !p.configured));

export async function load() {
  try {
    providers = await fetchImagegenProviders();
    const res = await fetchImagegenModels();
    enabledModels = res.models;
  } catch (err) {
    error = err instanceof Error ? err.message : "Failed to load imagegen config";
  }
}

load();

function authMethodLabel(method: string | null): string {
  if (method === "api_key") return "API key";
  if (method === "env_var") return "env var";
  return "";
}

function resetModalState() {
  showApiKeyModal = false;
  showModelModal = false;
  selectedProvider = "";
  apiKeyInput = "";
  modelSearch = "";
  modelSearchResults = [];
  error = "";
}

function openApiKeyModal() {
  resetModalState();
  showApiKeyModal = true;
  // Auto-select if only one unconfigured provider
  if (unconfiguredProviders.length === 1) {
    selectedProvider = unconfiguredProviders[0].id;
  }
}

async function handleApiKeySave() {
  if (!selectedProvider || !apiKeyInput.trim() || saving) return;
  saving = true;
  error = "";
  try {
    await saveImagegenProviderConfig(selectedProvider, apiKeyInput.trim());
    resetModalState();
    await load();
  } catch (err) {
    error = err instanceof Error ? err.message : "Failed to save";
  } finally {
    saving = false;
  }
}

async function handleProviderRemove(id: string) {
  saving = true;
  error = "";
  try {
    await removeImagegenProviderConfig(id);
    await load();
  } catch (err) {
    error = err instanceof Error ? err.message : "Failed to remove";
  } finally {
    saving = false;
  }
}

async function handleModelSearch() {
  if (!modelSearch.trim()) return;
  searching = true;
  try {
    modelSearchResults = await searchImagegenModels(modelSearch.trim());
  } catch (err) {
    error = err instanceof Error ? err.message : "Search failed";
  } finally {
    searching = false;
  }
}

async function addModel(modelId: string) {
  try {
    const updated = [...enabledModels, modelId];
    await saveEnabledImagegenModels(updated);
    enabledModels = updated;
    showModelModal = false;
    modelSearch = "";
    modelSearchResults = [];
  } catch (err) {
    error = err instanceof Error ? err.message : "Failed to add model";
  }
}

async function removeModel(modelId: string) {
  try {
    const updated = enabledModels.filter((id) => id !== modelId);
    await saveEnabledImagegenModels(updated);
    enabledModels = updated;
  } catch (err) {
    error = err instanceof Error ? err.message : "Failed to remove model";
  }
}
</script>

{#each configuredProviders as provider (provider.id)}
  <div class="provider-card">
    <div class="provider-row">
      <span class="provider-name">{provider.id}</span>
      <span class="auth-badge">{authMethodLabel(provider.authMethod)}</span>
      <div class="provider-actions">
        <button class="btn btn-reset" onclick={() => handleProviderRemove(provider.id)} disabled={saving}>
          Remove
        </button>
      </div>
    </div>
    <div class="provider-models">
      {#if enabledModels.length > 0}
        <div class="model-tags">
          {#each enabledModels as modelId (modelId)}
            <span class="model-tag">
              {modelId}
              <button class="model-tag-remove" onclick={() => removeModel(modelId)}>x</button>
            </span>
          {/each}
        </div>
      {:else}
        <span class="dim">No models enabled</span>
      {/if}
      <button class="btn btn-edit btn-add-model" onclick={() => { showModelModal = true; }}>
        Add model
      </button>
    </div>
  </div>
{/each}

{#if unconfiguredProviders.length > 0}
  <div class="add-provider-area">
    <button class="link-btn" onclick={openApiKeyModal}>
      Add a provider
    </button>
  </div>
{/if}

{#if !configuredProviders.length && !unconfiguredProviders.length}
  <span class="dim">Loading...</span>
{/if}

{#if error && !showApiKeyModal && !showModelModal}
  <div class="error">{error}</div>
{/if}

<!-- API Key Modal -->
{#if showApiKeyModal}
  <Modal onClose={resetModalState} size="420px" title="Add imagegen provider">
    <div class="modal-body">
      {#if unconfiguredProviders.length > 1}
        <select bind:value={selectedProvider} class="system-input modal-select">
          <option value="">Select provider...</option>
          {#each unconfiguredProviders as p (p.id)}
            <option value={p.id}>{p.id}</option>
          {/each}
        </select>
      {/if}

      {#if selectedProvider}
        <form class="modal-form" onsubmit={(e) => { e.preventDefault(); handleApiKeySave(); }}>
          <input
            type="password"
            bind:value={apiKeyInput}
            placeholder="API key"
            class="system-input"
          />
          <button type="submit" class="btn btn-save" disabled={saving || !apiKeyInput.trim()}>
            {saving ? "..." : "Save"}
          </button>
        </form>
      {/if}
      {#if error}
        <div class="error">{error}</div>
      {/if}
    </div>
  </Modal>
{/if}

<!-- Model Search Modal -->
{#if showModelModal}
  <Modal onClose={() => { showModelModal = false; modelSearch = ""; modelSearchResults = []; }} size="480px" title="Add model">
    <div class="modal-body">
      <form class="modal-form" onsubmit={(e) => { e.preventDefault(); handleModelSearch(); }}>
        <input
          type="text"
          bind:value={modelSearch}
          placeholder="Search Replicate models..."
          class="system-input"
        />
        <button type="submit" class="btn btn-edit" disabled={searching || !modelSearch.trim()}>
          {searching ? "..." : "Search"}
        </button>
      </form>
      {#if modelSearchResults.length > 0}
        <div class="model-list">
          {#each modelSearchResults as model (model.id)}
            <button
              class="model-option"
              onclick={() => addModel(model.id)}
              disabled={enabledModels.includes(model.id)}
            >
              <span class="model-id">{model.id}</span>
              {#if model.description}
                <span class="model-desc">{model.description}</span>
              {/if}
            </button>
          {/each}
        </div>
      {/if}
      {#if error}
        <div class="error">{error}</div>
      {/if}
    </div>
  </Modal>
{/if}

<style>
  .provider-card {
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: 10px 16px;
    margin-bottom: 6px;
  }

  .provider-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .provider-name {
    font-size: 13px;
    font-weight: 500;
    color: var(--text-0);
    flex: 1;
  }

  .auth-badge {
    font-size: 11px;
    padding: 1px 6px;
    border-radius: 3px;
    background: var(--bg-3);
    color: var(--text-2);
  }

  .provider-actions {
    display: flex;
    gap: 6px;
  }

  .provider-models {
    margin-top: 8px;
    padding-top: 8px;
    border-top: 1px solid var(--border);
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }

  .model-tags {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .model-tag {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 12px;
    padding: 3px 8px;
    background: var(--bg-3);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    color: var(--text-0);
  }

  .model-tag-remove {
    background: none;
    border: none;
    color: var(--text-2);
    cursor: pointer;
    font-size: 11px;
    padding: 0 2px;
    line-height: 1;
  }

  .model-tag-remove:hover {
    color: var(--red);
  }

  .btn-add-model {
    font-size: 11px;
    padding: 2px 8px;
  }

  .add-provider-area {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
    margin-top: 12px;
    padding: 20px 16px;
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
  }

  .link-btn {
    font-family: inherit;
    font-size: 12px;
    color: var(--text-2);
    background: none;
    border: none;
    cursor: pointer;
    padding: 2px 0;
    border-bottom: 1px solid transparent;
    transition: color 0.15s, border-color 0.15s;
  }

  .link-btn:hover {
    color: var(--text-1);
    border-bottom-color: var(--text-2);
  }

  .error {
    color: var(--red);
    font-size: 13px;
    margin-top: 8px;
  }

  .dim {
    color: var(--text-2);
    font-size: 12px;
  }

  .modal-body {
    padding: 16px 20px 20px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .modal-form {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .modal-select {
    width: 100%;
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

  .model-list {
    max-height: 300px;
    overflow-y: auto;
    border: 1px solid var(--border);
    border-radius: var(--radius);
  }

  .model-option {
    display: flex;
    flex-direction: column;
    gap: 2px;
    width: 100%;
    padding: 8px 12px;
    background: none;
    border: none;
    border-bottom: 1px solid var(--border);
    color: var(--text-0);
    cursor: pointer;
    text-align: left;
  }

  .model-option:last-child {
    border-bottom: none;
  }

  .model-option:hover:not(:disabled) {
    background: var(--bg-3);
  }

  .model-option:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .model-id {
    font-size: 13px;
    color: var(--text-0);
  }

  .model-desc {
    font-size: 11px;
    color: var(--text-2);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
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

  .btn-reset {
    background: var(--red-bg);
    color: var(--red);
    border-color: var(--red-border);
  }

  .btn-reset:hover:not(:disabled) {
    border-color: var(--red);
  }
</style>
