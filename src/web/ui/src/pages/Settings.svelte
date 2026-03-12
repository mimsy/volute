<script lang="ts">
import type { Prompt } from "@volute/api";
import { onMount } from "svelte";
import {
  type AiProvider,
  fetchAiProviders,
  fetchPrompts,
  pollAiOAuthStatus,
  removeProviderConfig,
  resetPrompt,
  saveProviderConfig,
  startAiOAuth,
  submitAiOAuthCode,
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

// AI Service state
let aiProviders = $state<AiProvider[]>([]);
let aiError = $state("");
let aiSaving = $state(false);
let editingProvider = $state<string | null>(null);
let apiKeyInput = $state("");
let oauthUrl = $state("");
let oauthPolling = $state(false);
let oauthFlowId = $state("");
let oauthNeedsCode = $state(false);
let oauthCodeInput = $state("");

let isRemote = $derived(
  typeof location !== "undefined" &&
    location.hostname !== "localhost" &&
    location.hostname !== "127.0.0.1",
);

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

async function loadAi() {
  try {
    aiProviders = await fetchAiProviders();
  } catch {
    // Non-critical
  }
}

onMount(() => {
  load();
  loadAi();
});

function startProviderEdit(id: string) {
  editingProvider = id;
  apiKeyInput = "";
  oauthUrl = "";
  oauthPolling = false;
  oauthFlowId = "";
  oauthNeedsCode = false;
  oauthCodeInput = "";
  aiError = "";
}

function cancelProviderEdit() {
  editingProvider = null;
  oauthPolling = false;
  aiError = "";
}

async function handleApiKeySave(providerId: string) {
  if (!apiKeyInput.trim() || aiSaving) return;
  aiSaving = true;
  aiError = "";
  try {
    await saveProviderConfig(providerId, apiKeyInput.trim());
    editingProvider = null;
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
  if (aiSaving) return;
  aiSaving = true;
  aiError = "";
  try {
    const result = await startAiOAuth(providerId);
    if (result.url) {
      oauthUrl = result.url;
      oauthFlowId = result.flowId;
      oauthNeedsCode = !!result.needsManualCode;
      oauthPolling = true;
      const poll = async () => {
        while (oauthPolling) {
          await new Promise((r) => setTimeout(r, 2500));
          try {
            const status = await pollAiOAuthStatus(result.flowId);
            if (status.status === "complete") {
              oauthPolling = false;
              cancelProviderEdit();
              await loadAi();
              return;
            } else if (status.status === "error") {
              oauthPolling = false;
              oauthUrl = "";
              aiError = status.error ?? "OAuth failed";
              return;
            }
          } catch {
            // Retry
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
      <span class="section-subtitle">Credentials for turn summaries, scripts, and mind tools</span>
    </div>

    {#each aiProviders as provider (provider.id)}
      <div class="provider-card">
        <div class="provider-row">
          <span class="provider-name">{provider.id}</span>
          {#if provider.configured}
            <span class="custom-badge">{authMethodLabel(provider.authMethod)}</span>
          {/if}
          <div class="provider-actions">
            {#if provider.configured && editingProvider !== provider.id}
              <button class="btn btn-reset" onclick={() => handleProviderRemove(provider.id)} disabled={aiSaving}>
                Remove
              </button>
            {/if}
            {#if !provider.configured && editingProvider !== provider.id}
              <button class="btn btn-edit" onclick={() => startProviderEdit(provider.id)}>
                Configure
              </button>
            {/if}
            {#if editingProvider === provider.id}
              <button class="btn btn-cancel" onclick={cancelProviderEdit}>Cancel</button>
            {/if}
          </div>
        </div>

        {#if editingProvider === provider.id}
          <div class="provider-config">
            <form class="system-form" onsubmit={(e) => { e.preventDefault(); handleApiKeySave(provider.id); }}>
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
            {#if provider.oauth}
              <button class="btn btn-edit" onclick={() => handleOAuth(provider.id)} disabled={aiSaving} style="margin-top: 6px;">
                {provider.oauthName ? `Sign in with ${provider.oauthName}` : "OAuth"}
              </button>
            {/if}
            {#if oauthUrl}
              <div class="oauth-modal">
                {#if oauthNeedsCode}
                  {#if isRemote}
                    <div class="oauth-steps">
                      <div class="oauth-step">1. Open the link below and authorize</div>
                      <div class="oauth-step">2. You'll be redirected to a page that won't load — this is expected</div>
                      <div class="oauth-step">3. Copy the URL from your browser's address bar and paste it below</div>
                    </div>
                  {:else}
                    <span class="system-label">Open the link below to authorize:</span>
                  {/if}
                  <a href={oauthUrl} target="_blank" rel="noopener" class="oauth-link">{oauthUrl}</a>
                  {#if isRemote}
                    <form class="system-form" onsubmit={(e) => { e.preventDefault(); handleOAuthCodeSubmit(); }} style="margin-top: 4px;">
                      <input
                        type="text"
                        bind:value={oauthCodeInput}
                        placeholder="Paste the redirect URL from your address bar"
                        class="system-input"
                      />
                      <button type="submit" class="btn btn-save" disabled={!oauthCodeInput.trim()}>Submit</button>
                    </form>
                  {:else}
                    <span class="dim">{oauthPolling ? "Waiting for authorization..." : ""}</span>
                  {/if}
                {:else}
                  <span class="system-label">Authorize at:</span>
                  <a href={oauthUrl} target="_blank" rel="noopener" class="oauth-link">{oauthUrl}</a>
                  <span class="dim">{oauthPolling ? "Waiting for authorization..." : ""}</span>
                {/if}
              </div>
            {/if}
          </div>
        {/if}
      </div>
    {/each}
    {#if aiError}
      <div class="error">{aiError}</div>
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

  .provider-actions {
    display: flex;
    gap: 6px;
  }

  .provider-config {
    margin-top: 8px;
    padding-top: 8px;
    border-top: 1px solid var(--border);
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

  .oauth-modal {
    margin-top: 8px;
    padding: 10px 12px;
    background: var(--bg-3);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .oauth-link {
    color: var(--accent);
    font-size: 13px;
    word-break: break-all;
  }

  .oauth-steps {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin-bottom: 6px;
  }

  .oauth-step {
    font-size: 13px;
    color: var(--text-1);
  }

  .dim {
    color: var(--text-2);
    font-size: 12px;
  }
</style>
