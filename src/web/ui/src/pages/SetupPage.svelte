<script lang="ts">
import { SvelteSet } from "svelte/reactivity";
import { fetchMe } from "../lib/auth";
import { auth, handleAuth } from "../lib/stores.svelte";

let { onComplete }: { onComplete: (spiritConversationId?: string) => void } = $props();

type Step = "welcome" | "account" | "provider" | "models" | "starting";
let step = $state<Step>("welcome");
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

// Step 3: Provider
type Provider = { id: string; name: string; oauthAvailable: boolean };
let providers = $state<Provider[]>([]);
let selectedProviderId = $state("");
let apiKey = $state("");
let providerValidated = $state(false);
let providerError = $state("");
let validatingProvider = $state(false);

// Step 4: Models
type Model = {
  id: string;
  name: string;
  provider: string;
  contextWindow: number;
  enabled: boolean;
};
let models = $state<Model[]>([]);
let enabledModels = new SvelteSet<string>();
let spiritModel = $state("");
let utilityModel = $state("");

let enabledModelList = $derived(models.filter((m) => enabledModels.has(m.id)));

const STEP_ORDER: Step[] = ["welcome", "account", "provider", "models", "starting"];
let stepIndex = $derived(STEP_ORDER.indexOf(step));

function canAdvance(): boolean {
  if (step === "welcome") return true;
  if (step === "account")
    return !!displayName.trim() && !!username.trim() && !!password && !!systemName.trim();
  if (step === "provider") return providerValidated;
  if (step === "models") return enabledModelList.length > 0 && !!spiritModel;
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

async function fetchProviders() {
  try {
    const res = await fetch("/api/system/ai/providers");
    if (res.ok) {
      providers = await res.json();
    }
  } catch {
    // Non-critical
  }
}

async function validateProvider() {
  if (!selectedProviderId || !apiKey.trim()) return;
  providerError = "";
  validatingProvider = true;
  try {
    const res = await fetch("/api/setup/provider", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerId: selectedProviderId, apiKey: apiKey.trim() }),
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(data.error || `Validation failed: ${res.status}`);
    }
    providerValidated = true;
  } catch (err) {
    providerError = err instanceof Error ? err.message : "Validation failed";
    providerValidated = false;
  }
  validatingProvider = false;
}

async function fetchModels() {
  try {
    const res = await fetch("/api/system/ai/models");
    if (res.ok) {
      models = await res.json();
      enabledModels.clear();
      for (const m of models.filter((m) => m.enabled)) enabledModels.add(m.id);
      // Pre-select spirit model if any are enabled
      if (enabledModelList.length > 0 && !spiritModel) {
        spiritModel = enabledModelList[0].id;
      }
    }
  } catch {
    // Non-critical
  }
}

function toggleModel(id: string) {
  if (enabledModels.has(id)) {
    enabledModels.delete(id);
    if (spiritModel === id) spiritModel = "";
    if (utilityModel === id) utilityModel = "";
  } else {
    enabledModels.add(id);
  }
}

async function handleModelsSubmit(e: Event) {
  e.preventDefault();
  if (!canAdvance()) return;
  error = "";
  loading = true;
  try {
    const res = await fetch("/api/setup/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        models: [...enabledModels],
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
    const data = (await res.json().catch(() => ({}))) as { spiritConversationId?: string };
    auth.setupComplete = true;
    onComplete(data.spiritConversationId);
  } catch (err) {
    error = err instanceof Error ? err.message : "Something went wrong";
    step = "models";
  }
  loading = false;
}

// Fetch providers when entering the provider step
$effect(() => {
  if (step === "provider" && providers.length === 0) {
    fetchProviders();
  }
});

// Fetch models when entering the models step
$effect(() => {
  if (step === "models" && models.length === 0) {
    fetchModels();
  }
});

function resetProviderValidation() {
  providerValidated = false;
  providerError = "";
}
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
        {#each STEP_ORDER.slice(1) as s, i (s)}
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
      <div class="step-title">AI provider</div>
      <div class="step-desc">Connect an AI provider to power your minds.</div>

      {#if providers.length === 0}
        <div class="loading-text">Loading providers...</div>
      {:else}
        <div class="provider-list">
          {#each providers as provider (provider.id)}
            <button
              class="provider-card"
              class:selected={selectedProviderId === provider.id}
              onclick={() => { selectedProviderId = provider.id; apiKey = ""; resetProviderValidation(); }}
              type="button"
            >
              <span class="provider-name">{provider.name}</span>
            </button>
          {/each}
        </div>

        {#if selectedProviderId}
          <label class="label mt" for="apiKey">API key</label>
          <input
            id="apiKey"
            type="password"
            placeholder="sk-..."
            bind:value={apiKey}
            oninput={resetProviderValidation}
            class="input"
          />

          {#if providerError}
            <div class="error">{providerError}</div>
          {/if}

          {#if providerValidated}
            <div class="success">Provider connected successfully.</div>
          {/if}

          {#if !providerValidated}
            <button
              class="submit-btn mt"
              disabled={validatingProvider || !apiKey.trim()}
              onclick={validateProvider}
              style:opacity={validatingProvider ? 0.5 : 1}
            >
              {validatingProvider ? "Validating..." : "Validate"}
            </button>
          {/if}
        {/if}
      {/if}

      {#if error}
        <div class="error">{error}</div>
      {/if}
      <div class="button-row">
        <button type="button" class="back-btn" onclick={goBack}>Back</button>
        <button
          class="submit-btn flex-1"
          disabled={!canAdvance()}
          onclick={() => { step = "models"; error = ""; }}
        >
          Continue
        </button>
      </div>

    {:else if step === "models"}
      <div class="step-title">Models</div>
      <div class="step-desc">Choose which models to enable and set defaults.</div>

      {#if models.length === 0}
        <div class="loading-text">Loading models...</div>
      {:else}
        <form onsubmit={handleModelsSubmit}>
          <div class="model-list">
            {#each models as model (model.id)}
              <label class="model-row">
                <input
                  type="checkbox"
                  checked={enabledModels.has(model.id)}
                  onchange={() => toggleModel(model.id)}
                />
                <span class="model-info">
                  <span class="model-name">{model.name}</span>
                  <span class="model-meta">{model.provider}</span>
                </span>
              </label>
            {/each}
          </div>

          {#if enabledModelList.length > 0}
            <label class="label mt" for="spiritModel">System model</label>
            <select id="spiritModel" class="input" bind:value={spiritModel}>
              <option value="">Select a model</option>
              {#each enabledModelList as model (model.id)}
                <option value={model.id}>{model.name}</option>
              {/each}
            </select>
            <div class="hint">Used for spirit conversations and as the default mind model.</div>

            <label class="label mt" for="utilityModel">Utility model</label>
            <select id="utilityModel" class="input" bind:value={utilityModel}>
              <option value="">None</option>
              {#each enabledModelList as model (model.id)}
                <option value={model.id}>{model.name}</option>
              {/each}
            </select>
            <div class="hint">For turn summaries and background tasks. A smaller, cheaper model is recommended.</div>
          {/if}

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
              {loading ? "Setting up..." : "Finish setup"}
            </button>
          </div>
        </form>
      {/if}

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

<style>
  .container {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    padding: 24px;
  }

  .card {
    width: 440px;
    padding: 32px;
    background: var(--bg-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
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

  .card:hover .login-spiral {
    opacity: 0;
  }

  .card:hover .hover-dot {
    opacity: 1;
  }

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

  .step-dot.active {
    background: var(--accent);
  }

  .step-dot.current {
    background: var(--accent);
    box-shadow: 0 0 0 2px var(--bg-1), 0 0 0 3px var(--accent);
  }

  /* Welcome */

  .welcome {
    text-align: center;
  }

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

  .mt {
    margin-top: 14px;
  }

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

  .input:focus {
    border-color: var(--border-bright);
  }

  select.input {
    cursor: pointer;
  }

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
    margin-top: 16px;
    background: var(--accent-dim);
    color: var(--accent);
    border-radius: var(--radius);
    font-size: 14px;
    font-weight: 500;
    font-family: inherit;
    border: none;
    cursor: pointer;
  }

  .submit-btn:disabled {
    opacity: 0.4;
    cursor: default;
  }

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

  .flex-1 {
    flex: 1;
  }

  /* Provider cards */

  .provider-list {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-bottom: 8px;
  }

  .provider-card {
    padding: 10px 16px;
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    color: var(--text-1);
    font-size: 13px;
    font-family: inherit;
    cursor: pointer;
    transition: border-color 0.15s;
  }

  .provider-card:hover {
    border-color: var(--border-bright);
  }

  .provider-card.selected {
    border-color: var(--accent);
    color: var(--text-0);
  }

  .provider-name {
    font-weight: 500;
  }

  /* Model list */

  .model-list {
    display: flex;
    flex-direction: column;
    gap: 2px;
    max-height: 240px;
    overflow-y: auto;
    margin-bottom: 8px;
  }

  .model-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 10px;
    border-radius: var(--radius);
    cursor: pointer;
  }

  .model-row:hover {
    background: var(--bg-2);
  }

  .model-info {
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .model-name {
    font-size: 13px;
    color: var(--text-0);
  }

  .model-meta {
    font-size: 11px;
    color: var(--text-2);
  }

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
