<script lang="ts">
import { Input } from "@volute/ui";
import AiProviders from "../components/system/AiProviders.svelte";
import { fetchMe } from "../lib/auth";
import type { AiModel } from "../lib/client";
import { auth, handleAuth } from "../lib/stores.svelte";

let { onComplete }: { onComplete: (spiritConversationId?: string) => void } = $props();

type Step = "welcome" | "system" | "account" | "provider" | "starting";

function initialStep(): Step {
  const p = auth.setupProgress;
  if (p?.hasAccount) return "provider";
  if (p?.hasSystem) return "account";
  return "welcome";
}

let step = $state<Step>(initialStep());
let error = $state("");
let loading = $state(false);

// Step 2: System
let systemName = $state("");
let systemDescription = $state("");
let systemsRegistered = $state(false);
let systemsName = $state("");
let showSystemsRegister = $state(false);
let systemsSlug = $state("");
let systemsSlugManuallyEdited = $state(false);
let systemsApiKey = $state("");
let showSystemsLogin = $state(false);
let systemsError = $state("");
let systemsLoading = $state(false);

// Step 3: Account
let displayName = $state("");
let username = $state("");
let usernameManuallyEdited = $state(false);
let password = $state("");

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

function deriveSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 32);
}

function handleSystemNameInput() {
  if (!systemsSlugManuallyEdited) {
    systemsSlug = deriveSlug(systemName);
  }
}

const SLUG_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
let slugValid = $derived(
  systemsSlug.length >= 3 && systemsSlug.length <= 32 && SLUG_RE.test(systemsSlug),
);
let slugError = $derived(
  systemsSlug.length > 0 && !slugValid
    ? systemsSlug.length < 3
      ? "Must be at least 3 characters"
      : !SLUG_RE.test(systemsSlug)
        ? "Lowercase letters, numbers, and hyphens only (no leading/trailing hyphens)"
        : "Must be 32 characters or fewer"
    : "",
);

// Step 4: Provider + Models
let aiProvidersRef = $state<AiProviders>();
let spiritModel = $state("");
let utilityModel = $state("");
let enabledModelIds = $state<string[]>([]);

function handleProviderLoad(enabledModels: AiModel[]) {
  enabledModelIds = enabledModels.map((m) => m.id);
  if (enabledModels.length > 0 && !spiritModel) {
    spiritModel = enabledModels[0].id;
  }
}

const STEP_ORDER: Step[] = ["welcome", "system", "account", "provider", "starting"];
let stepIndex = $derived(STEP_ORDER.indexOf(step));

function canAdvance(): boolean {
  if (step === "welcome") return true;
  if (step === "system") return !!systemName.trim();
  if (step === "account") return !!displayName.trim() && !!username.trim() && !!password;
  if (step === "provider") return enabledModelIds.length > 0 && !!spiritModel;
  return false;
}

function goBack() {
  const idx = STEP_ORDER.indexOf(step);
  if (idx > 0) {
    step = STEP_ORDER[idx - 1];
    error = "";
  }
}

async function handleSystemSubmit(e: Event) {
  e.preventDefault();
  if (!canAdvance()) return;
  error = "";
  loading = true;
  try {
    const res = await fetch("/api/setup/system", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: systemName.trim(),
        description: systemDescription.trim() || undefined,
      }),
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(data.error || `System setup failed: ${res.status}`);
    }
    step = "account";
  } catch (err) {
    error = err instanceof Error ? err.message : "Something went wrong";
  }
  loading = false;
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

async function handleSystemsRegister() {
  if (!systemsSlug.trim()) return;
  systemsError = "";
  systemsLoading = true;
  try {
    const res = await fetch("/api/setup/system/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug: systemsSlug.trim() }),
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(data.error || `Registration failed: ${res.status}`);
    }
    const data = (await res.json()) as { system: string };
    systemsRegistered = true;
    systemsName = data.system;
    showSystemsRegister = false;
  } catch (err) {
    systemsError = err instanceof Error ? err.message : "Registration failed";
  }
  systemsLoading = false;
}

async function handleSystemsLogin() {
  if (!systemsApiKey.trim()) return;
  systemsError = "";
  systemsLoading = true;
  try {
    const res = await fetch("/api/setup/system/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: systemsApiKey.trim() }),
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(data.error || `Login failed: ${res.status}`);
    }
    const data = (await res.json()) as { system: string };
    systemsRegistered = true;
    systemsName = data.system;
    showSystemsLogin = false;
    systemsApiKey = "";
  } catch (err) {
    systemsError = err instanceof Error ? err.message : "Login failed";
  }
  systemsLoading = false;
}

async function handleSystemsDisconnect() {
  systemsError = "";
  systemsLoading = true;
  try {
    await fetch("/api/setup/system/disconnect", { method: "POST" });
    systemsRegistered = false;
    systemsName = "";
  } catch (err) {
    systemsError = err instanceof Error ? err.message : "Disconnect failed";
  }
  systemsLoading = false;
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
        models: enabledModelIds,
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

// Load systems status when entering the system step
$effect(() => {
  if (step === "system" && !systemsRegistered) {
    fetch("/api/setup/system/systems-status")
      .then((r) => r.json())
      .then((data: any) => {
        if (data.registered) {
          systemsRegistered = true;
          systemsName = data.system;
        }
      })
      .catch(() => {});
  }
});

// Load provider + model data when entering the provider step
let providerDataLoaded = false;
$effect(() => {
  if (step === "provider" && !providerDataLoaded) {
    providerDataLoaded = true;
    aiProvidersRef?.load();
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
        <button class="submit-btn" onclick={() => (step = "system")}>Get started</button>
      </div>

    {:else if step === "system"}
      <div class="step-title">Your system</div>
      <form onsubmit={handleSystemSubmit}>
        <label class="label" for="systemName">System name</label>
        <Input
          inputSize="md"
          id="systemName"
          type="text"
          placeholder="e.g. My Garden"
          bind:value={systemName}
          oninput={handleSystemNameInput}
        />
        <div class="hint">A display name for this Volute installation.</div>

        <label class="label mt" for="systemDescription">Description <span class="optional">(optional)</span></label>
        <textarea
          id="systemDescription"
          placeholder="What is this system for?"
          bind:value={systemDescription}
          class="textarea"
          rows="2"
        ></textarea>

        <div class="systems-section">
          {#if systemsRegistered}
            <div class="systems-status">
              <span class="systems-label">Registered as <strong>{systemsName}</strong></span>
              <button type="button" class="link-btn" onclick={handleSystemsDisconnect} disabled={systemsLoading}>Disconnect</button>
            </div>
          {:else if showSystemsRegister}
            <div class="systems-register">
              <label class="label" for="systemsSlug">System username</label>
              <div class="slug-row">
                <Input
                  id="systemsSlug"
                  type="text"
                  placeholder="my-garden"
                  bind:value={systemsSlug}
                  oninput={() => { systemsSlugManuallyEdited = true; }}
                />
                <button type="button" class="save-btn" onclick={handleSystemsRegister} disabled={systemsLoading || !slugValid}>
                  {systemsLoading ? "..." : "Register"}
                </button>
              </div>
              {#if slugError}
                <div class="error">{slugError}</div>
              {:else}
                <div class="hint">Used for your subdomain on volute.systems.</div>
              {/if}
              <button type="button" class="link-btn mt-sm" onclick={() => { showSystemsRegister = false; showSystemsLogin = true; }}>
                or login with an existing key
              </button>
            </div>
          {:else if showSystemsLogin}
            <div class="systems-login">
              <label class="label" for="systemsApiKey">API key</label>
              <div class="slug-row">
                <Input
                  id="systemsApiKey"
                  type="password"
                  placeholder="Paste your API key"
                  bind:value={systemsApiKey}
                />
                <button type="button" class="save-btn" onclick={handleSystemsLogin} disabled={systemsLoading || !systemsApiKey.trim()}>
                  {systemsLoading ? "..." : "Login"}
                </button>
              </div>
              <button type="button" class="link-btn mt-sm" onclick={() => { showSystemsLogin = false; showSystemsRegister = true; }}>
                back to registration
              </button>
            </div>
          {:else}
            <button type="button" class="systems-btn" onclick={() => { showSystemsRegister = true; }}>
              Register with volute.systems
            </button>
            <button type="button" class="link-btn" onclick={() => { showSystemsLogin = true; }}>
              or login with an existing key
            </button>
          {/if}
          {#if systemsError}
            <div class="error">{systemsError}</div>
          {/if}
        </div>

        {#if error}
          <div class="error">{error}</div>
        {/if}
        <div class="button-row">
          <button type="button" class="back-btn" onclick={goBack}>Back</button>
          <button
            type="submit"
            disabled={loading || !canAdvance()}
            class="submit-btn flex-1"

          >
            {loading ? "Setting up..." : "Continue"}
          </button>
        </div>
      </form>

    {:else if step === "account"}
      <div class="step-title">Your account</div>
      <form onsubmit={handleAccountSubmit}>
        <label class="label" for="displayName">Display name</label>
        <Input
          inputSize="md"
          id="displayName"
          type="text"
          placeholder="Your name"
          bind:value={displayName}
          oninput={handleDisplayNameInput}
          autocomplete="name"
        />

        {#if usernameManuallyEdited}
          <label class="label mt" for="username">Username</label>
          <Input
            id="username"
            type="text"
            placeholder="username"
            bind:value={username}
            autocomplete="username"
          />
        {:else if username}
          <div class="username-preview">
            You'll sign in as <strong>{username}</strong> <button type="button" class="change-btn" onclick={() => { usernameManuallyEdited = true; }}>(change)</button>
          </div>
        {/if}

        <label class="label mt" for="password">Password</label>
        <Input
          inputSize="md"
          id="password"
          type="password"
          placeholder="Choose a password"
          bind:value={password}
          autocomplete="new-password"
        />

        {#if error}
          <div class="error">{error}</div>
        {/if}
        <div class="button-row">
          <button type="button" class="back-btn" onclick={goBack}>Back</button>
          <button
            type="submit"
            disabled={loading || !canAdvance()}
            class="submit-btn flex-1"

          >
            {loading ? "Setting up..." : "Continue"}
          </button>
        </div>
      </form>

    {:else if step === "provider"}
      <div class="step-title">AI providers</div>
      <div class="step-desc">Connect a provider and choose models for your minds.</div>

      <AiProviders
        bind:this={aiProvidersRef}
        showModelDefaults
        bind:spiritModel
        bind:utilityModel
        onLoad={handleProviderLoad}
      />

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

  .username-preview {
    margin-top: 10px;
    font-size: 13px;
    color: var(--text-2);
  }

  .username-preview strong {
    color: var(--text-0);
  }

  .change-btn {
    display: inline;
    font-family: inherit;
    font-size: 12px;
    color: var(--text-2);
    background: none;
    border: none;
    cursor: pointer;
    padding: 0;
  }

  .change-btn:hover {
    color: var(--text-1);
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


  /* Buttons */

  .submit-btn {
    width: 100%;
    padding: 10px 16px;
    background: var(--accent);
    color: var(--bg-0, #1a1a1a);
    border-radius: var(--radius);
    font-size: 14px;
    font-weight: 500;
    font-family: inherit;
    border: 1px solid transparent;
    cursor: pointer;
    transition: background 0.15s, opacity 0.15s;
  }

  .submit-btn:hover:not(:disabled) {
    background: color-mix(in srgb, var(--accent) 85%, white);
  }

  .submit-btn:disabled {
    background: var(--bg-2);
    color: var(--text-2);
    border-color: var(--border);
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

  .flex-1 { flex: 1; }

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

  .textarea {
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
    resize: vertical;
    min-height: 44px;
  }

  .textarea:focus {
    border-color: var(--border-bright);
  }

  .systems-section {
    margin-top: 16px;
    padding-top: 16px;
    border-top: 1px solid var(--border);
  }

  .systems-status {
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 13px;
    color: var(--text-1);
  }

  .systems-label strong {
    color: var(--text-0);
  }

  .systems-btn {
    display: block;
    width: 100%;
    padding: 8px 16px;
    background: var(--bg-2);
    border: 1px dashed var(--border);
    border-radius: var(--radius);
    color: var(--text-2);
    font-family: inherit;
    font-size: 13px;
    cursor: pointer;
    margin-bottom: 4px;
  }

  .systems-btn:hover {
    color: var(--text-1);
    border-color: var(--border-bright);
  }

  .slug-row {
    display: flex;
    gap: 6px;
  }

  .slug-row :global(.input) { flex: 1; }

  .mt-sm { margin-top: 6px; }
</style>
