<script lang="ts">
import { onMount } from "svelte";
import Modal from "../components/Modal.svelte";
import {
  type AiModel,
  type AiProvider,
  fetchAiModels,
  fetchAiProviders,
  fetchImagegenConfig,
  pollAiOAuthStatus,
  removeProviderConfig,
  saveEnabledModels,
  saveImagegenConfig,
  saveProviderConfig,
  startAiOAuth,
  submitAiOAuthCode,
  systemLogin,
  systemLogout,
  systemRegister,
} from "../lib/client";
import { auth } from "../lib/stores.svelte";

// System registration state
let systemError = $state("");
let systemAction = $state<"none" | "register" | "login">("none");
let systemInput = $state("");
let systemSaving = $state(false);

// AI Service state
let aiProviders = $state<AiProvider[]>([]);
let aiModels = $state<AiModel[]>([]);
let aiError = $state("");
let aiSaving = $state(false);

// Imagegen state
let imagegenEnabled = $state(false);
let imagegenSaving = $state(false);

// Modal state
let showApiKeyModal = $state(false);
let showOAuthModal = $state(false);
let selectedProvider = $state("");
let apiKeyInput = $state("");
let oauthUrl = $state("");
let oauthPolling = $state(false);
let oauthFlowId = $state("");
let oauthNeedsCode = $state(false);
let oauthCodeInput = $state("");

let configuredProviders = $derived(aiProviders.filter((p) => p.configured));
let unconfiguredProviders = $derived(aiProviders.filter((p) => !p.configured));
let oauthProviders = $derived(unconfiguredProviders.filter((p) => p.oauth));

let isRemote = $derived(
  typeof location !== "undefined" &&
    location.hostname !== "localhost" &&
    location.hostname !== "127.0.0.1",
);

async function loadAi() {
  try {
    aiProviders = await fetchAiProviders();
    aiModels = await fetchAiModels();
  } catch (err) {
    aiError = err instanceof Error ? err.message : "Failed to load AI config";
  }
}

async function loadImagegen() {
  try {
    const config = await fetchImagegenConfig();
    imagegenEnabled = config.enabled;
  } catch (err) {
    console.warn("Failed to load imagegen config:", err);
  }
}

async function toggleImagegen() {
  imagegenSaving = true;
  try {
    await saveImagegenConfig(!imagegenEnabled);
    imagegenEnabled = !imagegenEnabled;
  } catch (err) {
    aiError = `Failed to update image generation: ${err instanceof Error ? err.message : "unknown error"}`;
  } finally {
    imagegenSaving = false;
  }
}

onMount(() => {
  loadAi();
  loadImagegen();
});

function resetModalState() {
  showApiKeyModal = false;
  showOAuthModal = false;
  oauthPolling = false;
  oauthUrl = "";
  oauthFlowId = "";
  oauthNeedsCode = false;
  oauthCodeInput = "";
  selectedProvider = "";
  apiKeyInput = "";
  aiError = "";
}

function openApiKeyModal() {
  resetModalState();
  showApiKeyModal = true;
}

async function handleApiKeySave() {
  if (!selectedProvider || !apiKeyInput.trim() || aiSaving) return;
  aiSaving = true;
  aiError = "";
  try {
    await saveProviderConfig(selectedProvider, apiKeyInput.trim());
    resetModalState();
    await loadAi();
  } catch (err) {
    aiError = err instanceof Error ? err.message : "Failed to save";
  } finally {
    aiSaving = false;
  }
}

async function handleProviderRemove(providerId: string) {
  aiSaving = true;
  aiError = "";
  try {
    await removeProviderConfig(providerId);
    await loadAi();
  } catch (err) {
    aiError = err instanceof Error ? err.message : "Failed to remove";
  } finally {
    aiSaving = false;
  }
}

async function handleOAuth(providerId: string) {
  resetModalState();
  selectedProvider = providerId;
  showOAuthModal = true;
  aiSaving = true;
  try {
    const result = await startAiOAuth(providerId);
    if (result.url) {
      oauthUrl = result.url;
      oauthFlowId = result.flowId;
      oauthNeedsCode = !!result.needsManualCode;
      oauthPolling = true;
      const poll = async () => {
        let errors = 0;
        while (oauthPolling) {
          await new Promise((r) => setTimeout(r, 2500));
          try {
            const status = await pollAiOAuthStatus(result.flowId);
            errors = 0;
            if (status.status === "complete") {
              oauthPolling = false;
              resetModalState();
              await loadAi();
              return;
            } else if (status.status === "error") {
              oauthPolling = false;
              oauthUrl = "";
              aiError = status.error ?? "OAuth failed";
              return;
            }
          } catch {
            errors++;
            if (errors >= 5) {
              oauthPolling = false;
              oauthUrl = "";
              aiError = "Lost connection while waiting for OAuth";
              return;
            }
          }
        }
      };
      poll();
    }
  } catch (err) {
    aiError = err instanceof Error ? err.message : "OAuth failed";
  } finally {
    aiSaving = false;
  }
}

async function handleOAuthCodeSubmit() {
  if (!oauthCodeInput.trim() || !oauthFlowId) return;
  aiError = "";
  try {
    await submitAiOAuthCode(oauthFlowId, oauthCodeInput.trim());
    oauthCodeInput = "";
  } catch (err) {
    aiError = err instanceof Error ? err.message : "Failed to submit code";
  }
}

// Model state
let showModelModal = $state(false);
let modelModalProvider = $state("");
let modelSearch = $state("");
let enabledModels = $derived(aiModels.filter((m) => m.enabled));
let modelSuggestions = $derived(
  modelSearch.trim()
    ? aiModels
        .filter(
          (m) =>
            !m.enabled &&
            m.provider === modelModalProvider &&
            m.id.toLowerCase().includes(modelSearch.toLowerCase()),
        )
        .slice(0, 12)
    : aiModels.filter((m) => !m.enabled && m.provider === modelModalProvider).slice(0, 12),
);

function openModelModal(providerId: string) {
  modelModalProvider = providerId;
  modelSearch = "";
  showModelModal = true;
}

function modelsForProvider(providerId: string) {
  return enabledModels.filter((m) => m.provider === providerId);
}

async function addModel(modelId: string) {
  const updated = [...enabledModels.map((m) => m.id), modelId];
  try {
    await saveEnabledModels(updated);
    aiModels = aiModels.map((m) => (m.id === modelId ? { ...m, enabled: true } : m));
    modelSearch = "";
    showModelModal = false;
  } catch (err) {
    aiError = err instanceof Error ? err.message : "Failed to update models";
  }
}

async function removeModel(modelId: string) {
  const updated = enabledModels.map((m) => m.id).filter((id) => id !== modelId);
  try {
    await saveEnabledModels(updated);
    aiModels = aiModels.map((m) => (m.id === modelId ? { ...m, enabled: false } : m));
  } catch (err) {
    aiError = err instanceof Error ? err.message : "Failed to update models";
  }
}

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

function authMethodLabel(method: string | null): string {
  if (method === "api_key") return "API key";
  if (method === "oauth") return "OAuth";
  if (method === "env_var") return "env var";
  return "";
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

  <!-- AI Providers -->
  <div class="section">
    <div class="section-header">
      <span class="section-title">AI Providers</span>
      <span class="section-subtitle">Authentication for minds and system AI features</span>
    </div>

    {#each configuredProviders as provider (provider.id)}
      {@const providerModels = modelsForProvider(provider.id)}
      <div class="provider-card">
        <div class="provider-row">
          <span class="provider-name">{provider.id}</span>
          <span class="auth-badge">{authMethodLabel(provider.authMethod)}</span>
          <div class="provider-actions">
            <button class="btn btn-reset" onclick={() => handleProviderRemove(provider.id)} disabled={aiSaving}>
              Remove
            </button>
          </div>
        </div>
        <div class="provider-models">
          {#if providerModels.length > 0}
            <div class="model-tags">
              {#each providerModels as model (model.id)}
                <span class="model-tag">
                  {model.id}
                  <button class="model-tag-remove" onclick={() => removeModel(model.id)}>x</button>
                </span>
              {/each}
            </div>
          {:else}
            <span class="dim">No models enabled</span>
          {/if}
          {#if aiModels.some((m) => !m.enabled && m.provider === provider.id)}
            <button class="btn btn-edit btn-add-model" onclick={() => openModelModal(provider.id)}>
              Add model
            </button>
          {/if}
        </div>
      </div>
    {/each}

    {#if unconfiguredProviders.length > 0}
      <div class="add-provider-area">
        {#if oauthProviders.length > 0}
          <span class="add-provider-heading">Sign in with</span>
          <div class="oauth-buttons">
            {#each oauthProviders as p (p.id)}
              <button
                class="btn-provider"
                onclick={() => handleOAuth(p.id)}
                disabled={aiSaving}
              >
                {p.oauthName ?? p.id}
              </button>
            {/each}
          </div>
        {/if}
        <button class="link-btn" onclick={openApiKeyModal}>
          {oauthProviders.length > 0 ? "or add an API key" : "Add an API key"}
        </button>
      </div>
    {/if}

    {#if aiError && !showApiKeyModal && !showOAuthModal}
      <div class="error">{aiError}</div>
    {/if}
  </div>

  <!-- Image Generation -->
  <div class="section">
    <div class="section-header">
      <span class="section-title">Image Generation</span>
      <span class="section-subtitle">Enable avatar generation for new minds</span>
    </div>
    <div class="toggle-card">
      <div class="toggle-info">
        <span class="toggle-label">Enable image generation</span>
        <span class="toggle-description">Seeds will be able to generate avatars during orientation. Requires an imagegen skill in the shared pool.</span>
      </div>
      <label class="setting-toggle">
        <input
          type="checkbox"
          checked={imagegenEnabled}
          disabled={imagegenSaving}
          onchange={toggleImagegen}
        />
        <span class="toggle-track">
          <span class="toggle-thumb"></span>
        </span>
      </label>
    </div>
  </div>

</div>

<!-- OAuth Modal -->
{#if showOAuthModal}
  <Modal onClose={resetModalState} size="420px" title="Sign in with {aiProviders.find(p => p.id === selectedProvider)?.oauthName ?? selectedProvider}">
    <div class="modal-body">
      {#if oauthUrl}
        {#if oauthNeedsCode}
          {#if isRemote}
            <div class="oauth-steps">
              <div class="oauth-step"><span class="step-num">1</span> Open the link below and authorize</div>
              <div class="oauth-step"><span class="step-num">2</span> You'll be redirected to a page that won't load — this is expected</div>
              <div class="oauth-step"><span class="step-num">3</span> Copy the URL from your browser's address bar and paste it below</div>
            </div>
          {:else}
            <p class="modal-text">Open the link below to authorize:</p>
          {/if}
          <a href={oauthUrl} target="_blank" rel="noopener" class="oauth-link">{oauthUrl}</a>
          {#if isRemote}
            <form class="modal-form" onsubmit={(e) => { e.preventDefault(); handleOAuthCodeSubmit(); }}>
              <input
                type="text"
                bind:value={oauthCodeInput}
                placeholder="Paste the redirect URL here"
                class="system-input"
              />
              <button type="submit" class="btn btn-save" disabled={!oauthCodeInput.trim()}>Submit</button>
            </form>
          {:else}
            {#if oauthPolling}
              <span class="dim">Waiting for authorization...</span>
            {/if}
          {/if}
        {:else}
          <p class="modal-text">Authorize at:</p>
          <a href={oauthUrl} target="_blank" rel="noopener" class="oauth-link">{oauthUrl}</a>
          {#if oauthPolling}
            <span class="dim">Waiting for authorization...</span>
          {/if}
        {/if}
      {:else if aiSaving}
        <span class="dim">Starting OAuth flow...</span>
      {/if}
      {#if aiError}
        <div class="error">{aiError}</div>
      {/if}
    </div>
  </Modal>
{/if}

<!-- Model Modal -->
{#if showModelModal}
  <Modal onClose={() => { showModelModal = false; }} size="420px" title="Add model — {modelModalProvider}">
    <div class="modal-body">
      <input
        type="text"
        bind:value={modelSearch}
        placeholder="Search models..."
        class="system-input"
      />
      {#if modelSuggestions.length > 0}
        <div class="model-list">
          {#each modelSuggestions as model (model.id)}
            <button class="model-option" onclick={() => addModel(model.id)}>
              <span class="model-id">{model.id}</span>
            </button>
          {/each}
        </div>
      {:else}
        <span class="dim">No more models available</span>
      {/if}
    </div>
  </Modal>
{/if}

<!-- API Key Modal -->
{#if showApiKeyModal}
  <Modal onClose={resetModalState} size="420px" title="Add API key">
    <div class="modal-body">
      <select bind:value={selectedProvider} class="system-input modal-select">
        <option value="">Select provider...</option>
        {#each unconfiguredProviders as p (p.id)}
          <option value={p.id}>{p.id}</option>
        {/each}
      </select>

      {#if selectedProvider}
        <form class="modal-form" onsubmit={(e) => { e.preventDefault(); handleApiKeySave(); }}>
          <input
            type="password"
            bind:value={apiKeyInput}
            placeholder="API key"
            class="system-input"
          />
          <button type="submit" class="btn btn-save" disabled={aiSaving || !apiKeyInput.trim()}>
            {aiSaving ? "..." : "Save"}
          </button>
        </form>
      {/if}
      {#if aiError}
        <div class="error">{aiError}</div>
      {/if}
    </div>
  </Modal>
{/if}

<style>
  .settings {
    max-width: 720px;
    margin: 0 auto;
    animation: fadeIn 0.2s ease both;
  }

  .error {
    color: var(--red);
    font-size: 13px;
    margin-top: 8px;
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

  /* --- Add provider area --- */

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

  .add-provider-heading {
    font-size: 13px;
    color: var(--text-2);
    letter-spacing: 0.02em;
  }

  .oauth-buttons {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 8px;
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

  .btn-provider:hover:not(:disabled) {
    border-color: var(--accent);
  }

  .btn-provider:disabled {
    opacity: 0.5;
    cursor: not-allowed;
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

  .modal-form {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .modal-select {
    width: 100%;
  }

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

  /* --- Models (inline in provider cards) --- */

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

  /* --- Model modal list --- */

  .model-list {
    max-height: 260px;
    overflow-y: auto;
    border: 1px solid var(--border);
    border-radius: var(--radius);
  }

  .model-option {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 8px 12px;
    font-size: 13px;
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

  .model-option:hover {
    background: var(--bg-3);
  }

  .model-id {
    color: var(--text-0);
    flex: 1;
  }

  /* --- Shared --- */

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

  .dim {
    color: var(--text-2);
    font-size: 12px;
  }

  /* --- Toggle card --- */

  .toggle-card {
    display: flex;
    align-items: center;
    gap: 12px;
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: 14px 16px;
  }

  .toggle-info {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .toggle-label {
    font-size: 13px;
    font-weight: 500;
    color: var(--text-0);
  }

  .toggle-description {
    font-size: 12px;
    color: var(--text-2);
  }

  .setting-toggle {
    flex-shrink: 0;
    cursor: pointer;
    display: flex;
    align-items: center;
  }

  .setting-toggle input {
    position: absolute;
    opacity: 0;
    width: 0;
    height: 0;
  }

  .toggle-track {
    display: inline-block;
    width: 32px;
    height: 18px;
    background: var(--bg-3);
    border-radius: 9px;
    position: relative;
    transition: background 0.15s;
  }

  .setting-toggle input:checked + .toggle-track {
    background: var(--accent);
  }

  .toggle-thumb {
    position: absolute;
    top: 2px;
    left: 2px;
    width: 14px;
    height: 14px;
    background: var(--text-2);
    border-radius: 50%;
    transition: transform 0.15s, background 0.15s;
  }

  .setting-toggle input:checked + .toggle-track .toggle-thumb {
    transform: translateX(14px);
    background: var(--bg-0);
  }

  .setting-toggle input:disabled + .toggle-track {
    opacity: 0.5;
  }
</style>
