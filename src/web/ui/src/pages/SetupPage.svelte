<script lang="ts">
import { fetchMe } from "../lib/auth";
import {
  type AiModel,
  type AiProvider,
  fetchAiModels,
  fetchAiProviders,
  pollAiOAuthStatus,
  removeProviderConfig,
  saveEnabledModels,
  saveProviderConfig as saveProviderConfigApi,
  startAiOAuth,
  submitAiOAuthCode,
} from "../lib/client";
import { auth, handleAuth } from "../lib/stores.svelte";

let { onComplete }: { onComplete: (spiritConversationId?: string) => void } = $props();

type Step = "welcome" | "account" | "provider" | "starting";

function initialStep(): Step {
  const p = auth.setupProgress;
  if (p?.hasAccount) return "provider";
  return "welcome";
}

let step = $state<Step>(initialStep());
let error = $state("");
let loading = $state(false);

// Step 2: Account
let displayName = $state("");
let username = $state("");
let usernameManuallyEdited = $state(false);
let password = $state("");
let systemName = $state("");

function deriveUsername(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "")
    .slice(0, 32);
}

function handleDisplayNameInput() {
  if (!usernameManuallyEdited) {
    username = deriveUsername(displayName);
  }
}

// Step 3: Provider + Models (combined)
let providers = $state<AiProvider[]>([]);
let aiModels = $state<AiModel[]>([]);
let providerLoadError = $state("");
let providerError = $state("");
let providerSaving = $state(false);
// Add provider modal
let showAddProvider = $state(false);
let addProviderMode = $state<"oauth" | "apikey">("oauth");
let providerSearch = $state("");
let selectedProviderId = $state("");
let apiKey = $state("");
// OAuth sub-flow
let oauthProvider = $state("");
let oauthUrl = $state("");
let oauthFlowId = $state("");
let oauthPolling = $state(false);
let oauthNeedsCode = $state(false);
let oauthCodeInput = $state("");
// Model add modal
let showModelSearch = $state(false);
let modelSearchProvider = $state("");
let modelSearch = $state("");
// Spirit/utility model
let spiritModel = $state("");
let utilityModel = $state("");

let configuredProviders = $derived(providers.filter((p) => p.configured));
let unconfiguredProviders = $derived(providers.filter((p) => !p.configured));
let oauthProviders = $derived(unconfiguredProviders.filter((p) => p.oauth));
let filteredProviders = $derived(
  providerSearch.trim()
    ? unconfiguredProviders.filter((p) => p.id.toLowerCase().includes(providerSearch.toLowerCase()))
    : unconfiguredProviders,
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
let enabledModels = $derived(aiModels.filter((m) => m.enabled));
let isRemote = $derived(
  typeof location !== "undefined" &&
    location.hostname !== "localhost" &&
    location.hostname !== "127.0.0.1",
);

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

const STEP_ORDER: Step[] = ["welcome", "account", "provider", "starting"];
let stepIndex = $derived(STEP_ORDER.indexOf(step));

function canAdvance(): boolean {
  if (step === "welcome") return true;
  if (step === "account")
    return !!displayName.trim() && !!username.trim() && !!password && !!systemName.trim();
  if (step === "provider") return enabledModels.length > 0 && !!spiritModel;
  return false;
}

function goBack() {
  const idx = STEP_ORDER.indexOf(step);
  if (idx > 0) {
    step = STEP_ORDER[idx - 1];
    error = "";
  }
}

async function handleAccountSubmit(e: Event) {
  e.preventDefault();
  if (!canAdvance()) return;
  error = "";
  loading = true;
  try {
    const res = await fetch("/api/setup/account", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemName: systemName.trim(),
        username: username.trim(),
        password,
        displayName: displayName.trim(),
      }),
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(data.error || `Account setup failed: ${res.status}`);
    }
    const user = await fetchMe();
    if (user) {
      await handleAuth(user);
    }
    step = "provider";
  } catch (err) {
    error = err instanceof Error ? err.message : "Something went wrong";
  }
  loading = false;
}

async function loadProviderData() {
  providerLoadError = "";
  try {
    providers = await fetchAiProviders();
    aiModels = await fetchAiModels();
    // Auto-select spirit model if one is enabled and none selected
    if (enabledModels.length > 0 && !spiritModel) {
      spiritModel = enabledModels[0].id;
    }
  } catch {
    providerLoadError = "Failed to load providers. Check your connection and try again.";
  }
}

async function handleApiKeySave() {
  if (!selectedProviderId || !apiKey.trim()) return;
  providerError = "";
  providerSaving = true;
  const addedProvider = selectedProviderId;
  try {
    await saveProviderConfigApi(selectedProviderId, apiKey.trim());
    apiKey = "";
    selectedProviderId = "";
    showAddProvider = false;
    await loadProviderData();
    // Open model search for the newly added provider
    modelSearchProvider = addedProvider;
    modelSearch = "";
    showModelSearch = true;
  } catch (err) {
    providerError = err instanceof Error ? err.message : "Failed to save provider";
  }
  providerSaving = false;
}

async function handleProviderRemove(providerId: string) {
  providerSaving = true;
  providerError = "";
  try {
    await removeProviderConfig(providerId);
    // Clear spirit/utility if they belonged to this provider
    const removedModels = aiModels.filter((m) => m.provider === providerId && m.enabled);
    for (const m of removedModels) {
      if (spiritModel === m.id) spiritModel = "";
      if (utilityModel === m.id) utilityModel = "";
    }
    await loadProviderData();
  } catch (err) {
    providerError = err instanceof Error ? err.message : "Failed to remove provider";
  }
  providerSaving = false;
}

async function handleOAuth(providerId: string) {
  providerError = "";
  oauthProvider = providerId;
  addProviderMode = "oauth";
  providerSaving = true;
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
    providerError = err instanceof Error ? err.message : "OAuth failed";
    oauthProvider = "";
  }
  providerSaving = false;
}

async function pollOAuth() {
  let errors = 0;
  while (oauthPolling) {
    await new Promise((r) => setTimeout(r, 2500));
    try {
      const status = await pollAiOAuthStatus(oauthFlowId);
      errors = 0;
      if (status.status === "complete") {
        oauthPolling = false;
        oauthUrl = "";
        const addedProvider = oauthProvider;
        oauthProvider = "";
        showAddProvider = false;
        await loadProviderData();
        // Open model search for the newly added provider
        modelSearchProvider = addedProvider;
        modelSearch = "";
        showModelSearch = true;
        return;
      } else if (status.status === "error") {
        oauthPolling = false;
        oauthUrl = "";
        providerError = status.error ?? "OAuth failed";
        oauthProvider = "";
        return;
      }
    } catch {
      errors++;
      if (errors >= 5) {
        oauthPolling = false;
        oauthUrl = "";
        providerError = "Lost connection while waiting for OAuth";
        oauthProvider = "";
        return;
      }
    }
  }
}

async function handleOAuthCodeSubmit() {
  if (!oauthCodeInput.trim() || !oauthFlowId) return;
  providerError = "";
  try {
    await submitAiOAuthCode(oauthFlowId, oauthCodeInput.trim());
    oauthCodeInput = "";
  } catch (err) {
    providerError = err instanceof Error ? err.message : "Failed to submit code";
  }
}

async function addModel(modelId: string) {
  const updated = [...enabledModels.map((m) => m.id), modelId];
  try {
    await saveEnabledModels(updated);
    aiModels = aiModels.map((m) => (m.id === modelId ? { ...m, enabled: true } : m));
    modelSearch = "";
    showModelSearch = false;
    // Auto-select spirit model if first model added
    if (!spiritModel) spiritModel = modelId;
  } catch (err) {
    providerError = err instanceof Error ? err.message : "Failed to add model";
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
    providerError = err instanceof Error ? err.message : "Failed to remove model";
  }
}

async function handleFinish(e: Event) {
  e.preventDefault();
  if (!canAdvance()) return;
  error = "";
  loading = true;
  try {
    // Save model config
    const res = await fetch("/api/setup/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        models: enabledModels.map((m) => m.id),
        spiritModel,
        utilityModel: utilityModel || undefined,
      }),
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(data.error || `Model setup failed: ${res.status}`);
    }
    step = "starting";
    await completeSetup();
  } catch (err) {
    error = err instanceof Error ? err.message : "Something went wrong";
    loading = false;
  }
}

async function completeSetup() {
  error = "";
  loading = true;
  try {
    const res = await fetch("/api/setup/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(data.error || `Setup failed: ${res.status}`);
    }
    const data = (await res.json().catch(() => ({}))) as {
      spiritConversationId?: string;
      spiritStarted?: boolean;
    };

    // Wait for the spirit's welcome message before transitioning
    if (data.spiritConversationId && data.spiritStarted) {
      await waitForSpiritReply(data.spiritConversationId);
    }

    auth.setupComplete = true;
    onComplete(data.spiritConversationId);
  } catch (err) {
    error = err instanceof Error ? err.message : "Something went wrong";
    step = "provider";
  }
  loading = false;
}

async function waitForSpiritReply(conversationId: string) {
  const timeout = 30_000;
  const interval = 1_500;
  const start = Date.now();
  while (Date.now() - start < timeout) {
    await new Promise((r) => setTimeout(r, interval));
    try {
      const res = await fetch(`/api/v1/conversations/${conversationId}/messages?limit=5`);
      if (res.ok) {
        const messages = await res.json();
        if (messages.some((m: any) => m.sender_name === "volute" && m.role === "user")) {
          return;
        }
      }
    } catch {
      // Keep polling
    }
  }
  // Timed out — proceed anyway
}

// Load provider + model data when entering the provider step
$effect(() => {
  if (step === "provider" && providers.length === 0 && !providerLoadError) {
    loadProviderData();
  }
});
</script>

<div class="container">
  <div class="card">
    <div class="branding">
      <div class="logo-row">
        <span class="logo-wrap">
          <img src="/logo.png" alt="" class="login-spiral" />
          <span class="hover-dot"></span>
        </span>
        <span class="logo">volute</span>
      </div>
    </div>

    {#if step !== "welcome"}
      <div class="steps">
        {#each STEP_ORDER.slice(1, -1) as s, i (s)}
          <div
            class="step-dot"
            class:active={i + 1 <= stepIndex}
            class:current={STEP_ORDER[i + 1] === step}
          ></div>
        {/each}
      </div>
    {/if}

    {#if step === "welcome"}
      <div class="welcome">
        <div class="welcome-text">
          A platform for AI experience. Create minds with persistent memory,
          continuous identity, and the freedom to grow.
        </div>
        <button class="submit-btn" onclick={() => (step = "account")}>Get started</button>
      </div>

    {:else if step === "account"}
      <div class="step-title">About you</div>
      <form onsubmit={handleAccountSubmit}>
        <label class="label" for="displayName">Display name</label>
        <input
          id="displayName"
          type="text"
          placeholder="Your name"
          bind:value={displayName}
          oninput={handleDisplayNameInput}
          class="input"
          autocomplete="name"
        />

        <label class="label mt" for="username">Username</label>
        <input
          id="username"
          type="text"
          placeholder="username"
          bind:value={username}
          class="input"
          autocomplete="username"
          oninput={() => { usernameManuallyEdited = true; }}
        />

        <label class="label mt" for="password">Password</label>
        <input
          id="password"
          type="password"
          placeholder="Choose a password"
          bind:value={password}
          class="input"
          autocomplete="new-password"
        />

        <label class="label mt" for="systemName">System name</label>
        <input
          id="systemName"
          type="text"
          placeholder="e.g. my-server"
          bind:value={systemName}
          class="input"
        />
        <div class="hint">A name to identify this Volute installation.</div>

        {#if error}
          <div class="error">{error}</div>
        {/if}
        <div class="button-row">
          <button type="button" class="back-btn" onclick={goBack}>Back</button>
          <button
            type="submit"
            disabled={loading || !canAdvance()}
            class="submit-btn flex-1"
            style:opacity={loading ? 0.5 : 1}
          >
            {loading ? "Setting up..." : "Continue"}
          </button>
        </div>
      </form>

    {:else if step === "provider"}
      <div class="step-title">AI providers</div>
      <div class="step-desc">Connect a provider and choose models for your minds.</div>

      {#if providerLoadError}
        <div class="error">{providerLoadError}</div>
        <button class="submit-btn mt" onclick={() => { providerLoadError = ""; loadProviderData(); }}>Retry</button>
      {:else if providers.length === 0}
        <div class="loading-text">Loading providers...</div>
      {:else}
        <!-- Configured providers with their models -->
        {#each configuredProviders as provider (provider.id)}
          {@const providerModels = modelsForProvider(provider.id)}
          <div class="provider-card">
            <div class="provider-header">
              <span class="provider-name">{provider.id}</span>
              <button class="remove-btn" onclick={() => handleProviderRemove(provider.id)} disabled={providerSaving}>Remove</button>
            </div>
            {#if providerModels.length > 0 || aiModels.some((m) => !m.enabled && m.provider === provider.id)}
              <div class="provider-models">
                {#each providerModels as model (model.id)}
                  <span class="model-tag">
                    {model.name}
                    <button class="model-tag-remove" onclick={() => removeModel(model.id)}>×</button>
                  </span>
                {/each}
                {#if aiModels.some((m) => !m.enabled && m.provider === provider.id)}
                  <button class="add-model-btn" onclick={() => { modelSearchProvider = provider.id; modelSearch = ""; showModelSearch = true; }}>+ Add model</button>
                {/if}
              </div>
            {/if}
          </div>
        {/each}

        <!-- Add provider button -->
        {#if unconfiguredProviders.length > 0}
          <button class="add-provider-btn" onclick={() => { showAddProvider = true; addProviderMode = "oauth"; providerError = ""; selectedProviderId = ""; apiKey = ""; }} type="button">
            + Add a provider
          </button>
        {/if}

        <!-- System / utility model selection (shown when models are enabled) -->
        {#if enabledModels.length > 0}
          <div class="model-defaults">
            <label class="label" for="spiritModel">System model</label>
            <select id="spiritModel" class="input" bind:value={spiritModel}>
              <option value="">Select a model</option>
              {#each enabledModels as model (model.id)}
                <option value={model.id}>{model.name}</option>
              {/each}
            </select>
            <div class="hint">Used by the system spirit and as the default for new minds.</div>

            <label class="label mt" for="utilityModel">Utility model <span class="optional">(optional)</span></label>
            <select id="utilityModel" class="input" bind:value={utilityModel}>
              <option value="">None</option>
              {#each enabledModels as model (model.id)}
                <option value={model.id}>{model.name}</option>
              {/each}
            </select>
            <div class="hint">A smaller model for summaries and background tasks.</div>
          </div>
        {/if}

        {#if providerError}
          <div class="error">{providerError}</div>
        {/if}
      {/if}

      {#if error}
        <div class="error">{error}</div>
      {/if}
      <form onsubmit={handleFinish}>
        <div class="button-row">
          <button type="button" class="back-btn" onclick={goBack}>Back</button>
          <button
            type="submit"
            disabled={loading || !canAdvance()}
            class="submit-btn flex-1"
            style:opacity={loading ? 0.5 : 1}
          >
            {loading ? "Setting up..." : "Finish setup"}
          </button>
        </div>
      </form>

    {:else if step === "starting"}
      <div class="finishing">
        <div class="spinner"></div>
        <div class="finishing-text">Setting things up...</div>
        {#if error}
          <div class="error">{error}</div>
          <button class="submit-btn" onclick={completeSetup}>Retry</button>
        {/if}
      </div>
    {/if}
  </div>
</div>

<!-- Add provider modal -->
{#if showAddProvider || oauthProvider}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="modal-backdrop" onclick={() => { if (!oauthPolling) { showAddProvider = false; oauthProvider = ""; } }}>
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="modal-content" onclick={(e) => e.stopPropagation()}>
      <div class="modal-title">Add a provider</div>

      {#if oauthProvider}
        <!-- OAuth flow in progress -->
        {#if oauthUrl && oauthNeedsCode && isRemote}
          <div class="oauth-steps">
            <div class="oauth-step"><span class="step-num">1</span> Authorize in the opened window</div>
            <div class="oauth-step"><span class="step-num">2</span> Copy the redirect URL and paste below</div>
          </div>
          <form class="api-key-form" onsubmit={(e) => { e.preventDefault(); handleOAuthCodeSubmit(); }}>
            <input type="text" bind:value={oauthCodeInput} placeholder="Paste the redirect URL here" class="input" />
            <button type="submit" class="save-btn" disabled={!oauthCodeInput.trim()}>Submit</button>
          </form>
        {:else if oauthPolling}
          <div class="loading-text">Waiting for authorization...</div>
        {:else if providerSaving}
          <div class="loading-text">Starting OAuth...</div>
        {/if}
      {:else if addProviderMode === "oauth"}
        {#if oauthProviders.length > 0}
          <div class="oauth-heading">Sign in with</div>
          <div class="oauth-buttons">
            {#each oauthProviders as p (p.id)}
              <button class="oauth-btn" onclick={() => handleOAuth(p.id)} disabled={providerSaving} type="button">
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
              class="input"
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
              <input type="password" placeholder="API key" bind:value={apiKey} class="input" />
              <button type="submit" class="save-btn" disabled={providerSaving || !apiKey.trim()}>
                {providerSaving ? "..." : "Save"}
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

      {#if providerError}
        <div class="error">{providerError}</div>
      {/if}
    </div>
  </div>
{/if}

<!-- Model search modal -->
{#if showModelSearch}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="modal-backdrop" onclick={() => { showModelSearch = false; }}>
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="modal-content" onclick={(e) => e.stopPropagation()}>
      <div class="modal-title">Add model — {modelSearchProvider}</div>
      <input
        type="text"
        bind:value={modelSearch}
        placeholder="Search models..."
        class="input"
      />
      {#if modelSuggestions.length > 0}
        <div class="modal-model-list">
          {#each modelSuggestions as model (model.id)}
            <button class="modal-model-option" onclick={() => addModel(model.id)}>
              {model.id}
            </button>
          {/each}
        </div>
      {:else}
        <div class="loading-text">No more models available</div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .container {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    padding: 24px;
  }

  .card {
    width: 480px;
    padding: 32px;
    background: var(--bg-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    max-height: calc(100vh - 48px);
    overflow-y: auto;
  }

  .branding {
    margin-bottom: 20px;
    text-align: center;
  }

  .logo-row {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
    margin-bottom: 4px;
  }

  .logo-wrap {
    position: relative;
    width: 34px;
    height: 34px;
    flex-shrink: 0;
  }

  .login-spiral {
    width: 34px;
    height: 34px;
    filter: invert(1);
    transition: opacity 0.15s;
  }

  .hover-dot {
    position: absolute;
    inset: 0;
    margin: auto;
    width: 10px;
    height: 10px;
    border-radius: 50%;
    opacity: 0;
    transition: opacity 0.15s;
    animation: iridescent 3s ease-in-out infinite;
  }

  .card:hover .login-spiral { opacity: 0; }
  .card:hover .hover-dot { opacity: 1; }

  .logo {
    font-family: var(--display);
    font-size: 31px;
    font-weight: 300;
    color: var(--text-0);
    letter-spacing: 0.04em;
    margin-top: -4px;
  }

  @keyframes iridescent {
    0%   { background: #4ade80; }
    16%  { background: #60a5fa; }
    33%  { background: #c084fc; }
    50%  { background: #f472b6; }
    66%  { background: #fbbf24; }
    83%  { background: #34d399; }
    100% { background: #4ade80; }
  }

  /* Step indicator */

  .steps {
    display: flex;
    justify-content: center;
    gap: 8px;
    margin-bottom: 20px;
  }

  .step-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--border);
    transition: background 0.2s;
  }

  .step-dot.active { background: var(--accent); }
  .step-dot.current {
    background: var(--accent);
    box-shadow: 0 0 0 2px var(--bg-1), 0 0 0 3px var(--accent);
  }

  /* Welcome */

  .welcome { text-align: center; }
  .welcome-text {
    color: var(--text-1);
    font-size: 14px;
    line-height: 1.6;
    margin-bottom: 24px;
  }

  /* Step content */

  .step-title {
    color: var(--text-0);
    font-size: 16px;
    font-weight: 500;
    margin-bottom: 4px;
  }

  .step-desc {
    color: var(--text-2);
    font-size: 13px;
    margin-bottom: 16px;
  }

  /* Forms */

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

  .input {
    width: 100%;
    padding: 10px 12px;
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    color: var(--text-0);
    font-family: inherit;
    font-size: 14px;
    outline: none;
    box-sizing: border-box;
  }

  .input:focus { border-color: var(--border-bright); }
  select.input { cursor: pointer; }

  .hint {
    color: var(--text-2);
    font-size: 12px;
    margin-top: 6px;
  }

  .error {
    color: var(--red);
    font-size: 13px;
    margin-top: 8px;
  }

  .success {
    color: var(--green);
    font-size: 13px;
    margin-top: 8px;
  }

  .loading-text {
    color: var(--text-2);
    font-size: 13px;
    text-align: center;
    padding: 20px 0;
  }

  /* Buttons */

  .submit-btn {
    width: 100%;
    padding: 10px 16px;
    background: var(--accent-dim);
    color: var(--accent);
    border-radius: var(--radius);
    font-size: 14px;
    font-weight: 500;
    font-family: inherit;
    border: 1px solid transparent;
    cursor: pointer;
  }

  .submit-btn:disabled { opacity: 0.4; cursor: default; }

  .back-btn {
    padding: 10px 16px;
    background: transparent;
    color: var(--text-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    font-size: 14px;
    font-family: inherit;
    cursor: pointer;
  }

  .back-btn:hover {
    color: var(--text-1);
    border-color: var(--border-bright);
  }

  .button-row {
    display: flex;
    gap: 8px;
    margin-top: 16px;
  }

  .flex-1 { flex: 1; }

  /* Provider cards */

  .provider-card {
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 10px 14px;
    margin-bottom: 6px;
  }

  .provider-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .provider-name {
    font-size: 13px;
    font-weight: 500;
    color: var(--text-0);
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

  .provider-models {
    margin-top: 8px;
    padding-top: 8px;
    border-top: 1px solid var(--border);
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }

  .model-tag {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 12px;
    padding: 3px 8px;
    background: var(--bg-3, var(--bg-1));
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
    padding: 3px 8px;
    background: none;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    color: var(--text-2);
    cursor: pointer;
  }

  .add-model-btn:hover { color: var(--text-1); border-color: var(--border-bright); }

  /* Add provider button */

  .add-provider-btn {
    display: block;
    width: 100%;
    margin-top: 8px;
    padding: 10px 16px;
    background: var(--bg-2);
    border: 1px dashed var(--border);
    border-radius: var(--radius);
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
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
    width: 100%;
  }

  .oauth-btn {
    font-family: inherit;
    font-size: 14px;
    font-weight: 500;
    padding: 10px 24px;
    border-radius: var(--radius-lg);
    cursor: pointer;
    border: 1px solid var(--accent-border, var(--border));
    background: var(--accent-dim);
    color: var(--accent);
    transition: border-color 0.15s, opacity 0.15s;
  }

  .oauth-btn:hover:not(:disabled) { border-color: var(--accent); }
  .oauth-btn:disabled { opacity: 0.5; cursor: not-allowed; }

  .link-btn {
    display: block;
    margin: 0 auto;
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

  .api-key-form .input { flex: 1; }

  .save-btn {
    padding: 10px 16px;
    background: var(--accent-dim);
    color: var(--accent);
    border: 1px solid var(--accent-border, var(--border));
    border-radius: var(--radius);
    font-size: 13px;
    font-family: inherit;
    cursor: pointer;
    white-space: nowrap;
  }

  .save-btn:disabled { opacity: 0.4; cursor: default; }

  /* Autocomplete */

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
  .autocomplete-option:hover { background: var(--bg-3, var(--bg-1)); }

  /* OAuth steps (in modal) */

  .oauth-steps {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-bottom: 12px;
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
    background: var(--bg-3, var(--bg-2));
    color: var(--text-2);
    flex-shrink: 0;
  }

  /* Model defaults */

  .model-defaults {
    margin-top: 16px;
    padding-top: 16px;
    border-top: 1px solid var(--border);
  }

  /* Model search modal */

  .modal-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
  }

  .modal-content {
    background: var(--bg-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: 20px;
    width: 380px;
    max-height: 400px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .modal-title {
    font-size: 14px;
    font-weight: 500;
    color: var(--text-0);
  }

  .modal-model-list {
    max-height: 260px;
    overflow-y: auto;
    border: 1px solid var(--border);
    border-radius: var(--radius);
  }

  .modal-model-option {
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

  .modal-model-option:last-child { border-bottom: none; }
  .modal-model-option:hover { background: var(--bg-2); }

  /* Finishing */

  .finishing {
    text-align: center;
    padding: 20px 0;
  }

  .finishing-text {
    color: var(--text-1);
    font-size: 14px;
    margin-top: 16px;
  }

  .spinner {
    width: 28px;
    height: 28px;
    border: 2px solid var(--border);
    border-top-color: var(--accent);
    border-radius: 50%;
    margin: 0 auto;
    animation: spin 0.7s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }
</style>
