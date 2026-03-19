<script lang="ts">
import {
  type AiModel,
  type AiProvider,
  fetchAiModels,
  fetchAiProviders,
  pollAiOAuthStatus,
  removeProviderConfig,
  saveEnabledModels,
  saveProviderConfig,
  startAiOAuth,
  submitAiOAuthCode,
} from "../lib/client";
import Modal from "./Modal.svelte";

let {
  showModelDefaults = false,
  spiritModel = $bindable(""),
  utilityModel = $bindable(""),
  onLoad,
}: {
  showModelDefaults?: boolean;
  spiritModel?: string;
  utilityModel?: string;
  onLoad?: (enabledModels: AiModel[]) => void;
} = $props();

// Provider + model state
let providers = $state<AiProvider[]>([]);
let aiModels = $state<AiModel[]>([]);
let error = $state("");
let saving = $state(false);
let loadError = $state("");

// Add provider modal
let showAddProvider = $state(false);
let addProviderMode = $state<"oauth" | "apikey">("oauth");
let providerSearch = $state("");
let selectedProviderId = $state("");
let apiKeyInput = $state("");

// OAuth sub-flow
let oauthProvider = $state("");
let oauthUrl = $state("");
let oauthFlowId = $state("");
let oauthPolling = $state(false);
let oauthNeedsCode = $state(false);
let oauthWaitingForCode = $state(false);
let oauthCodeInput = $state("");
let oauthCodeSubmitting = $state(false);

// Model search modal
let showModelSearch = $state(false);
let modelSearchProvider = $state("");
let modelSearch = $state("");

let configuredProviders = $derived(providers.filter((p) => p.configured));
let unconfiguredProviders = $derived(providers.filter((p) => !p.configured));
let oauthProviders = $derived(unconfiguredProviders.filter((p) => p.oauth));
let filteredProviders = $derived(
  providerSearch.trim()
    ? unconfiguredProviders.filter((p) => p.id.toLowerCase().includes(providerSearch.toLowerCase()))
    : unconfiguredProviders,
);
let enabledModels = $derived(aiModels.filter((m) => m.enabled));
let isRemote = $derived(
  typeof location !== "undefined" &&
    location.hostname !== "localhost" &&
    location.hostname !== "127.0.0.1",
);

const PROVIDER_LABELS: Record<string, string> = {
  "Google Cloud Code Assist": "Google Cloud",
  "ChatGPT Plus/Pro": "OpenAI",
};

function shortProviderLabel(p: AiProvider): string {
  const name = p.oauthName ?? p.id;
  const base = name.replace(/\s*\(.*\)/, "").trim();
  return PROVIDER_LABELS[base] ?? (base || p.id);
}

function modelsForProvider(providerId: string) {
  return enabledModels.filter((m) => m.provider === providerId);
}

let modelSuggestions = $derived(
  modelSearch.trim()
    ? aiModels
        .filter(
          (m) =>
            !m.enabled &&
            m.provider === modelSearchProvider &&
            m.id.toLowerCase().includes(modelSearch.toLowerCase()),
        )
        .slice(0, 12)
    : aiModels.filter((m) => !m.enabled && m.provider === modelSearchProvider).slice(0, 12),
);

function authMethodLabel(method: string | null): string {
  if (method === "api_key") return "API key";
  if (method === "oauth") return "OAuth";
  if (method === "env_var") return "env var";
  return "";
}

// Notify parent whenever enabled models change
$effect(() => {
  if (enabledModels) {
    onLoad?.(enabledModels);
  }
});

export async function load() {
  loadError = "";
  try {
    providers = await fetchAiProviders();
    aiModels = await fetchAiModels();
  } catch {
    loadError = "Failed to load providers. Check your connection and try again.";
  }
}

function resetAddProvider() {
  showAddProvider = false;
  oauthProvider = "";
  oauthUrl = "";
  oauthFlowId = "";
  oauthPolling = false;
  oauthNeedsCode = false;
  oauthWaitingForCode = false;
  oauthCodeInput = "";
  oauthCodeSubmitting = false;
  addProviderMode = "oauth";
  providerSearch = "";
  selectedProviderId = "";
  apiKeyInput = "";
  error = "";
}

function openAddProvider() {
  resetAddProvider();
  showAddProvider = true;
}

async function handleApiKeySave() {
  if (!selectedProviderId || !apiKeyInput.trim()) return;
  error = "";
  saving = true;
  const addedProvider = selectedProviderId;
  try {
    await saveProviderConfig(selectedProviderId, apiKeyInput.trim());
    resetAddProvider();
    await load();
    // Open model search for the newly added provider
    modelSearchProvider = addedProvider;
    modelSearch = "";
    showModelSearch = true;
  } catch (err) {
    error = err instanceof Error ? err.message : "Failed to save provider";
  }
  saving = false;
}

async function handleProviderRemove(providerId: string) {
  saving = true;
  error = "";
  try {
    await removeProviderConfig(providerId);
    // Clear spirit/utility if they belonged to this provider
    const removedModels = aiModels.filter((m) => m.provider === providerId && m.enabled);
    for (const m of removedModels) {
      if (spiritModel === m.id) spiritModel = "";
      if (utilityModel === m.id) utilityModel = "";
    }
    await load();
  } catch (err) {
    error = err instanceof Error ? err.message : "Failed to remove provider";
  }
  saving = false;
}

async function handleOAuth(providerId: string) {
  error = "";
  oauthProvider = providerId;
  saving = true;
  try {
    const result = await startAiOAuth(providerId);
    if (result.url) {
      oauthUrl = result.url;
      oauthFlowId = result.flowId;
      oauthNeedsCode = !!result.needsManualCode;
      oauthPolling = true;
      window.open(result.url, "_blank");
      pollOAuth();
    }
  } catch (err) {
    error = err instanceof Error ? err.message : "OAuth failed";
    oauthProvider = "";
  }
  saving = false;
}

async function pollOAuth() {
  let errors = 0;
  while (oauthPolling) {
    await new Promise((r) => setTimeout(r, 2500));
    try {
      const status = await pollAiOAuthStatus(oauthFlowId);
      errors = 0;
      if (status.waitingForCode) {
        oauthWaitingForCode = true;
      }
      if (status.status === "complete") {
        oauthPolling = false;
        const addedProvider = oauthProvider;
        resetAddProvider();
        await load();
        // Open model search for the newly added provider
        modelSearchProvider = addedProvider;
        modelSearch = "";
        showModelSearch = true;
        return;
      } else if (status.status === "error") {
        oauthPolling = false;
        oauthUrl = "";
        oauthWaitingForCode = false;
        error = status.error ?? "OAuth failed";
        oauthProvider = "";
        return;
      }
    } catch {
      errors++;
      if (errors >= 5) {
        oauthPolling = false;
        oauthUrl = "";
        error = "Lost connection while waiting for OAuth";
        oauthProvider = "";
        return;
      }
    }
  }
}

async function handleOAuthCodeSubmit() {
  if (!oauthCodeInput.trim() || !oauthFlowId) return;
  error = "";
  oauthCodeSubmitting = true;
  try {
    await submitAiOAuthCode(oauthFlowId, oauthCodeInput.trim());
    oauthCodeInput = "";
  } catch (err) {
    error = err instanceof Error ? err.message : "Failed to submit code";
  }
  oauthCodeSubmitting = false;
}

function handleOAuthCodeInputChange() {
  const val = oauthCodeInput.trim();
  if (val && /^https?:\/\//.test(val)) {
    handleOAuthCodeSubmit();
  }
}

async function addModel(modelId: string) {
  const updated = [...enabledModels.map((m) => m.id), modelId];
  try {
    await saveEnabledModels(updated);
    aiModels = aiModels.map((m) => (m.id === modelId ? { ...m, enabled: true } : m));
    modelSearch = "";
    showModelSearch = false;
    if (!spiritModel) spiritModel = modelId;
  } catch (err) {
    error = err instanceof Error ? err.message : "Failed to add model";
  }
}

async function removeModel(modelId: string) {
  const updated = enabledModels.map((m) => m.id).filter((id) => id !== modelId);
  try {
    await saveEnabledModels(updated);
    aiModels = aiModels.map((m) => (m.id === modelId ? { ...m, enabled: false } : m));
    if (spiritModel === modelId) spiritModel = "";
    if (utilityModel === modelId) utilityModel = "";
  } catch (err) {
    error = err instanceof Error ? err.message : "Failed to remove model";
  }
}
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
            {#each providerModels as model (model.id)}
              <span class="model-tag">
                {model.id}
                <button class="model-tag-remove" onclick={() => removeModel(model.id)}>×</button>
              </span>
            {/each}
          </div>
        {:else}
          <span class="dim">No models enabled</span>
        {/if}
        {#if aiModels.some((m) => !m.enabled && m.provider === provider.id)}
          <button class="add-model-btn" onclick={() => { modelSearchProvider = provider.id; modelSearch = ""; showModelSearch = true; }}>Add model</button>
        {/if}
      </div>
    </div>
  {/each}

  <!-- Add provider button -->
  {#if unconfiguredProviders.length > 0}
    <button class="add-provider-btn" onclick={openAddProvider} type="button">
      + Add a provider
    </button>
  {/if}

  <!-- System / utility model selection -->
  {#if showModelDefaults && enabledModels.length > 0}
    <div class="model-defaults">
      <label class="label" for="spiritModel">System model</label>
      <select id="spiritModel" class="select-input" bind:value={spiritModel}>
        <option value="">Select a model</option>
        {#each enabledModels as model (model.id)}
          <option value={model.id}>{model.name}</option>
        {/each}
      </select>
      <div class="hint">Used by the system spirit and as the default for new minds.</div>

      <label class="label mt" for="utilityModel">Utility model <span class="optional">(optional)</span></label>
      <select id="utilityModel" class="select-input" bind:value={utilityModel}>
        <option value="">None</option>
        {#each enabledModels as model (model.id)}
          <option value={model.id}>{model.name}</option>
        {/each}
      </select>
      <div class="hint">A smaller model for summaries and background tasks.</div>
    </div>
  {/if}

  {#if error && !showAddProvider}
    <div class="error">{error}</div>
  {/if}
{/if}

<!-- Add provider modal (API key with autocomplete) -->
{#if showAddProvider && !oauthProvider}
  <Modal onClose={() => { if (!oauthPolling) resetAddProvider(); }} size="420px" title="Add a provider">
    <div class="modal-body">
      {#if addProviderMode === "oauth"}
        {#if oauthProviders.length > 0}
          <span class="oauth-heading">Sign in with</span>
          <div class="oauth-buttons modal-oauth-buttons">
            {#each oauthProviders as p (p.id)}
              <button class="btn-provider" onclick={() => handleOAuth(p.id)} disabled={saving} type="button">
                {shortProviderLabel(p)}
              </button>
            {/each}
          </div>
        {/if}
        <button class="link-btn" onclick={() => { addProviderMode = "apikey"; providerSearch = ""; selectedProviderId = ""; }} type="button">
          {oauthProviders.length > 0 ? "or add an API key" : "Add an API key"}
        </button>
      {:else}
        <div class="api-key-section">
          <div class="autocomplete">
            <input
              type="text"
              class="text-input"
              placeholder="Search providers..."
              bind:value={providerSearch}
              oninput={() => { selectedProviderId = ""; }}
            />
            {#if !selectedProviderId && filteredProviders.length > 0}
              <div class="autocomplete-list">
                {#each filteredProviders as p (p.id)}
                  <button class="autocomplete-option" onclick={() => { selectedProviderId = p.id; providerSearch = p.id; }} type="button">
                    {p.id}
                  </button>
                {/each}
              </div>
            {/if}
          </div>
          {#if selectedProviderId}
            <form class="api-key-form" onsubmit={(e) => { e.preventDefault(); handleApiKeySave(); }}>
              <input type="password" placeholder="API key" bind:value={apiKeyInput} class="text-input" />
              <button type="submit" class="save-btn" disabled={saving || !apiKeyInput.trim()}>
                {saving ? "..." : "Save"}
              </button>
            </form>
          {/if}
        </div>
        {#if oauthProviders.length > 0}
          <button class="link-btn" onclick={() => { addProviderMode = "oauth"; }} type="button">
            back to sign-in options
          </button>
        {/if}
      {/if}

      {#if error}
        <div class="error">{error}</div>
      {/if}
    </div>
  </Modal>
{/if}

<!-- OAuth flow modal -->
{#if oauthProvider}
  <Modal onClose={() => { if (!oauthPolling) resetAddProvider(); }} size="420px" title="Sign in with {providers.find(p => p.id === oauthProvider)?.oauthName ?? oauthProvider}">
    <div class="modal-body">
      {#if oauthCodeSubmitting}
        <span class="dim">Verifying...</span>
      {:else if oauthUrl && ((oauthNeedsCode && isRemote) || oauthWaitingForCode)}
        <div class="oauth-steps">
          <div class="oauth-step"><span class="step-num">1</span> Authorize in the opened window</div>
          <div class="oauth-step"><span class="step-num">2</span> Copy the redirect URL and paste below</div>
        </div>
        <form class="api-key-form" onsubmit={(e) => { e.preventDefault(); handleOAuthCodeSubmit(); }}>
          <input type="text" bind:value={oauthCodeInput} oninput={handleOAuthCodeInputChange} placeholder="Paste the redirect URL here" class="text-input" />
          <button type="submit" class="save-btn" disabled={!oauthCodeInput.trim()}>Submit</button>
        </form>
      {:else if oauthUrl && !oauthNeedsCode}
        <p class="modal-text">Authorize at:</p>
        <a href={oauthUrl} target="_blank" rel="noopener" class="oauth-link">{oauthUrl}</a>
        {#if oauthPolling}
          <span class="dim">Waiting for authorization...</span>
        {/if}
      {:else if oauthPolling}
        <span class="dim">Waiting for authorization...</span>
      {:else if saving}
        <span class="dim">Starting OAuth...</span>
      {/if}
      {#if error}
        <div class="error">{error}</div>
      {/if}
    </div>
  </Modal>
{/if}

<!-- Model search modal -->
{#if showModelSearch}
  <Modal onClose={() => { showModelSearch = false; }} size="420px" title="Add model — {modelSearchProvider}">
    <div class="modal-body">
      <input
        type="text"
        bind:value={modelSearch}
        placeholder="Search models..."
        class="text-input"
      />
      {#if modelSuggestions.length > 0}
        <div class="model-list">
          {#each modelSuggestions as model (model.id)}
            <button class="model-option" onclick={() => addModel(model.id)}>
              {model.id}
            </button>
          {/each}
        </div>
      {:else}
        <span class="dim">No more models available</span>
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

  .oauth-heading {
    font-size: 13px;
    color: var(--text-2);
    letter-spacing: 0.02em;
    text-align: center;
  }

  .oauth-buttons {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 8px;
  }

  .modal-oauth-buttons {
    display: grid;
    grid-template-columns: 1fr 1fr;
    width: 100%;
  }

  .btn-provider {
    font-family: inherit;
    font-size: 14px;
    font-weight: 500;
    padding: 10px 24px;
    border-radius: var(--radius-lg);
    cursor: pointer;
    border: 1px solid var(--accent-border);
    background: var(--accent-dim);
    color: var(--accent);
    transition: border-color 0.15s, opacity 0.15s;
  }

  .btn-provider:hover:not(:disabled) { border-color: var(--accent); }
  .btn-provider:disabled { opacity: 0.5; cursor: not-allowed; }

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

  .modal-text {
    font-size: 13px;
    color: var(--text-2);
    margin: 0;
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

  /* --- API key section --- */

  .api-key-section {
    display: flex;
    flex-direction: column;
    gap: 10px;
    width: 100%;
  }

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

  /* --- Autocomplete --- */

  .autocomplete {
    position: relative;
  }

  .autocomplete-list {
    position: absolute;
    top: 100%;
    left: 0;
    right: 0;
    z-index: 10;
    max-height: 200px;
    overflow-y: auto;
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-top: none;
    border-radius: 0 0 var(--radius) var(--radius);
  }

  .autocomplete-option {
    display: block;
    width: 100%;
    padding: 8px 12px;
    font-size: 13px;
    font-family: inherit;
    background: none;
    border: none;
    border-bottom: 1px solid var(--border);
    color: var(--text-0);
    cursor: pointer;
    text-align: left;
  }

  .autocomplete-option:last-child { border-bottom: none; }
  .autocomplete-option:hover { background: var(--bg-3); }

  /* --- OAuth steps --- */

  .oauth-steps {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .oauth-step {
    font-size: 13px;
    color: var(--text-1);
    display: flex;
    align-items: baseline;
    gap: 8px;
  }

  .step-num {
    font-size: 11px;
    font-weight: 600;
    width: 18px;
    height: 18px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
    background: var(--bg-3);
    color: var(--text-2);
    flex-shrink: 0;
  }

  .oauth-link {
    color: var(--accent);
    font-size: 13px;
    word-break: break-all;
  }

  /* --- Model search modal --- */

  .model-list {
    max-height: 260px;
    overflow-y: auto;
    border: 1px solid var(--border);
    border-radius: var(--radius);
  }

  .model-option {
    display: block;
    width: 100%;
    padding: 8px 12px;
    font-size: 13px;
    font-family: inherit;
    background: none;
    border: none;
    border-bottom: 1px solid var(--border);
    color: var(--text-0);
    cursor: pointer;
    text-align: left;
  }

  .model-option:last-child { border-bottom: none; }
  .model-option:hover { background: var(--bg-3); }

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

  .optional {
    color: var(--text-2);
    font-weight: 400;
  }

  .mt { margin-top: 14px; }

  .hint {
    color: var(--text-2);
    font-size: 12px;
    margin-top: 6px;
  }
</style>
