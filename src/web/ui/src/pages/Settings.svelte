<script lang="ts">
import { onMount } from "svelte";
import AiProviders from "../components/AiProviders.svelte";
import {
  fetchImagegenConfig,
  saveImagegenConfig,
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

// Imagegen state
let imagegenEnabled = $state(false);
let imagegenSaving = $state(false);
let imagegenError = $state("");

let aiProvidersRef: AiProviders;

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
    imagegenError = `Failed to update image generation: ${err instanceof Error ? err.message : "unknown error"}`;
  } finally {
    imagegenSaving = false;
  }
}

onMount(() => {
  aiProvidersRef.load();
  loadImagegen();
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

    <AiProviders bind:this={aiProvidersRef} />
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
    {#if imagegenError}
      <div class="error">{imagegenError}</div>
    {/if}
  </div>

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
