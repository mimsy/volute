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
} from "../../lib/client";
import Modal from "../ui/Modal.svelte";
import ModelSelect from "./ModelSelect.svelte";

let providers = $state<ImagegenProvider[]>([]);
let enabledModels = $state<string[]>([]);
let defaultModel = $state<string | null>(null);
let error = $state("");
let saving = $state(false);
let loadError = $state("");

// API key modal
let showApiKeyModal = $state(false);
let selectedProvider = $state("");
let apiKeyInput = $state("");

// Model search modal
let showModelModal = $state(false);
let modelSearch = $state("");
let modelSearchResults = $state<ImagegenModelSearchResult[]>([]);
let searching = $state(false);
let searchProvider = $state("");

let configuredProviders = $derived(providers.filter((p) => p.configured));
let unconfiguredProviders = $derived(providers.filter((p) => !p.configured));

function modelsForProvider(providerId: string) {
  return enabledModels.filter((m) => m.startsWith(`${providerId}:`));
}

function authMethodLabel(method: string | null): string {
  if (method === "api_key") return "API key";
  if (method === "env_var") return "env var";
  return "";
}

export async function load() {
  loadError = "";
  try {
    providers = await fetchImagegenProviders();
    const res = await fetchImagegenModels();
    enabledModels = res.models;
    defaultModel = res.defaultModel;
  } catch {
    loadError = "Failed to load imagegen config. Check your connection and try again.";
  }
}

load();

function resetModalState() {
  showApiKeyModal = false;
  showModelModal = false;
  selectedProvider = "";
  apiKeyInput = "";
  modelSearch = "";
  modelSearchResults = [];
  searchProvider = "";
  error = "";
}

function openApiKeyModal() {
  resetModalState();
  showApiKeyModal = true;
  if (unconfiguredProviders.length === 1) {
    selectedProvider = unconfiguredProviders[0].id;
  }
}

async function handleApiKeySave() {
  if (!selectedProvider || !apiKeyInput.trim() || saving) return;
  saving = true;
  error = "";
  const addedProvider = selectedProvider;
  try {
    await saveImagegenProviderConfig(selectedProvider, apiKeyInput.trim());
    resetModalState();
    await load();
    // Open model search for the newly added provider
    searchProvider = addedProvider;
    modelSearch = "";
    modelSearchResults = [];
    showModelModal = true;
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
    // Clear default if it belonged to this provider
    if (defaultModel?.startsWith(`${id}:`)) {
      defaultModel = null;
    }
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
    modelSearchResults = await searchImagegenModels(
      modelSearch.trim(),
      searchProvider || undefined,
    );
  } catch (err) {
    error = err instanceof Error ? err.message : "Search failed";
  } finally {
    searching = false;
  }
}

async function addModel(modelId: string) {
  try {
    const updated = [...enabledModels, modelId];
    const newDefault = enabledModels.length === 0 ? modelId : undefined;
    await saveEnabledImagegenModels(updated, newDefault);
    enabledModels = updated;
    if (newDefault) defaultModel = newDefault;
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
    const newDefault = defaultModel === modelId ? null : undefined;
    await saveEnabledImagegenModels(updated, newDefault);
    enabledModels = updated;
    if (defaultModel === modelId) defaultModel = null;
  } catch (err) {
    error = err instanceof Error ? err.message : "Failed to remove model";
  }
}

// Bridge defaultModel (string|null) to string for ModelSelect
let defaultModelStr = $state("");
$effect(() => {
  defaultModelStr = defaultModel ?? "";
});

// Auto-save default model when it changes
let defaultsLoaded = false;
$effect(() => {
  const dm = defaultModelStr;
  if (!defaultsLoaded) return;
  defaultModel = dm || null;
  saveEnabledImagegenModels(enabledModels, dm || null).catch(() => {});
});
$effect(() => {
  if (enabledModels.length > 0) defaultsLoaded = true;
});
</script>

{#if loadError}
  <div class="error">{loadError}</div>
  <button class="retry-btn" onclick={() => load()}>Retry</button>
{:else if providers.length === 0}
  <div class="loading-text">Loading providers...</div>
{:else}
  <!-- Configured providers with their models -->
  {#each configuredProviders as provider (provider.id)}
    {@const providerModels = modelsForProvider(provider.id)}
    <div class="provider-card">
      <div class="provider-header">
        <span class="provider-name">{provider.id}</span>
        <span class="auth-badge">{authMethodLabel(provider.authMethod)}</span>
        <button class="remove-btn" onclick={() => handleProviderRemove(provider.id)} disabled={saving}>Remove</button>
      </div>
      <div class="provider-models">
        {#if providerModels.length > 0}
          <div class="model-tags">
            {#each providerModels as modelId (modelId)}
              <span class="model-tag">
                {modelId}
                <button class="model-tag-remove" onclick={() => removeModel(modelId)}>×</button>
              </span>
            {/each}
          </div>
        {:else}
          <span class="dim">No models enabled</span>
        {/if}
        <button class="add-model-btn" onclick={() => { searchProvider = provider.id; modelSearch = ""; modelSearchResults = []; showModelModal = true; }}>Add model</button>
      </div>
    </div>
  {/each}

  <!-- Add provider button -->
  {#if unconfiguredProviders.length > 0}
    <button class="add-provider-btn" onclick={openApiKeyModal} type="button">
      + Add a provider
    </button>
  {/if}

  <!-- Default model selection -->
  {#if enabledModels.length > 0}
    <div class="model-defaults">
      <span class="label">Default model</span>
      <ModelSelect
        items={enabledModels.map((id) => ({ id, label: id }))}
        bind:value={defaultModelStr}
        placeholder="Search models..."
        emptyLabel="Select a model"
      />
      <div class="hint">Used when minds generate images without specifying a model.</div>
    </div>
  {/if}

  {#if error && !showApiKeyModal && !showModelModal}
    <div class="error">{error}</div>
  {/if}
{/if}

<!-- API Key Modal -->
{#if showApiKeyModal}
  <Modal onClose={resetModalState} size="420px" title="Add imagegen provider">
    <div class="modal-body">
      {#if unconfiguredProviders.length > 1}
        <div class="autocomplete">
          <select class="select-input" bind:value={selectedProvider}>
            <option value="">Select provider...</option>
            {#each unconfiguredProviders as p (p.id)}
              <option value={p.id}>{p.id}</option>
            {/each}
          </select>
        </div>
      {/if}

      {#if selectedProvider}
        <form class="api-key-form" onsubmit={(e) => { e.preventDefault(); handleApiKeySave(); }}>
          <input
            type="password"
            bind:value={apiKeyInput}
            placeholder="API key"
            class="text-input"
          />
          <button type="submit" class="save-btn" disabled={saving || !apiKeyInput.trim()}>
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
  <Modal onClose={() => { showModelModal = false; modelSearch = ""; modelSearchResults = []; }} size="480px" title="Add model — {searchProvider}">
    <div class="modal-body">
      <form class="api-key-form" onsubmit={(e) => { e.preventDefault(); handleModelSearch(); }}>
        <input
          type="text"
          bind:value={modelSearch}
          placeholder="Search models..."
          class="text-input"
        />
        <button type="submit" class="save-btn" disabled={searching || !modelSearch.trim()}>
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
  .error {
    color: var(--red);
    font-size: 13px;
    margin-top: 8px;
  }

  .dim {
    color: var(--text-2);
    font-size: 12px;
  }

  .loading-text {
    color: var(--text-2);
    font-size: 13px;
    text-align: center;
    padding: 20px 0;
  }

  /* --- Provider cards --- */

  .provider-card {
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: 10px 16px;
    margin-bottom: 6px;
  }

  .provider-header {
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

  .remove-btn {
    font-family: inherit;
    font-size: 11px;
    padding: 2px 8px;
    background: none;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    color: var(--text-2);
    cursor: pointer;
  }

  .remove-btn:hover { color: var(--red); border-color: var(--red); }
  .remove-btn:disabled { opacity: 0.5; cursor: not-allowed; }

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
    font-size: 13px;
    padding: 0 2px;
    line-height: 1;
  }

  .model-tag-remove:hover { color: var(--red); }

  .add-model-btn {
    font-family: inherit;
    font-size: 11px;
    padding: 2px 8px;
    background: var(--bg-3);
    color: var(--text-1);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    cursor: pointer;
  }

  .add-model-btn:hover { color: var(--text-0); border-color: var(--border-bright); }

  /* --- Add provider button --- */

  .add-provider-btn {
    display: block;
    width: 100%;
    margin-top: 8px;
    padding: 10px 16px;
    background: var(--bg-2);
    border: 1px dashed var(--border);
    border-radius: var(--radius-lg);
    color: var(--text-2);
    font-family: inherit;
    font-size: 13px;
    cursor: pointer;
    transition: color 0.15s, border-color 0.15s;
  }

  .add-provider-btn:hover {
    color: var(--text-1);
    border-color: var(--border-bright);
  }

  .retry-btn {
    display: block;
    margin-top: 8px;
    padding: 8px 16px;
    background: var(--accent-dim);
    color: var(--accent);
    border: 1px solid var(--accent-border);
    border-radius: var(--radius);
    font-size: 13px;
    font-family: inherit;
    cursor: pointer;
  }

  /* --- Modal content --- */

  .modal-body {
    padding: 16px 20px 20px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .text-input {
    width: 100%;
    padding: 8px 10px;
    background: var(--bg-3);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    color: var(--text-0);
    font-size: 13px;
    font-family: inherit;
    outline: none;
    box-sizing: border-box;
  }

  .text-input:focus { border-color: var(--border-bright); }

  .select-input {
    width: 100%;
    padding: 8px 10px;
    background: var(--bg-3);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    color: var(--text-0);
    font-size: 13px;
    font-family: inherit;
    outline: none;
    box-sizing: border-box;
    cursor: pointer;
  }

  .select-input:focus { border-color: var(--border-bright); }

  .api-key-form {
    display: flex;
    gap: 6px;
  }

  .api-key-form .text-input { flex: 1; }

  .save-btn {
    padding: 8px 16px;
    background: var(--accent-dim);
    color: var(--accent);
    border: 1px solid var(--accent-border);
    border-radius: var(--radius);
    font-size: 13px;
    font-family: inherit;
    cursor: pointer;
    white-space: nowrap;
  }

  .save-btn:disabled { opacity: 0.4; cursor: default; }

  /* --- Model search modal --- */

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
    font-family: inherit;
    font-size: 13px;
  }

  .model-option:last-child { border-bottom: none; }
  .model-option:hover:not(:disabled) { background: var(--bg-3); }
  .model-option:disabled { opacity: 0.5; cursor: default; }

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

  /* --- Model defaults --- */

  .model-defaults {
    margin-top: 16px;
    padding-top: 16px;
    border-top: 1px solid var(--border);
  }

  .label {
    display: block;
    color: var(--text-1);
    font-size: 13px;
    margin-bottom: 6px;
  }

  .hint {
    color: var(--text-2);
    font-size: 12px;
    margin-top: 6px;
  }
</style>
