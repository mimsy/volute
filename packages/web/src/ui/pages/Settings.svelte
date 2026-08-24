<script lang="ts">
import { Input } from "@volute/ui";
import { onMount } from "svelte";
import AiProviders from "../components/system/AiProviders.svelte";
import ImagegenProviders from "../components/system/ImagegenProviders.svelte";
import {
  fetchAiDefaults,
  fetchMaxMinds,
  fetchSystemLimits,
  saveAiDefaults,
  saveMaxMinds,
  saveSystemLimits,
  systemLogin,
  systemLogout,
  systemRegister,
  updateSystemName,
} from "../lib/client";
import { parsePositiveInt, parsePositiveNumber } from "../lib/spend-format";
import { auth } from "../lib/stores.svelte";

// Install-wide spend cap. Empty = no cap.
// `bind:value` on a number input yields a number once anything is typed, so this holds
// whatever the field currently is and is read through parsePositiveNumber.
let spendCapInput: string | number = $state("");
let spendCapError = $state("");
// Same guard as maxMinds below: without it a failed load renders the field blank and
// the onblur autosave clears an existing cap.
let spendCapLoaded = $state(false);

onMount(async () => {
  try {
    const limits = await fetchSystemLimits();
    spendCapInput = limits.systemSpendCapPerDay == null ? "" : String(limits.systemSpendCapPerDay);
    spendCapLoaded = true;
  } catch (err) {
    spendCapError = err instanceof Error ? err.message : "Failed to load spend cap";
  }
});

async function saveSpendCap() {
  if (!spendCapLoaded) return;
  spendCapError = "";
  const trimmed = String(spendCapInput ?? "").trim();
  let value: number | null = null;
  if (trimmed !== "") {
    // parsePositiveNumber refuses 0 and negatives: the server reads a 0 as "no cap", the
    // opposite of what a host typing 0 means.
    value = parsePositiveNumber(trimmed);
    if (value == null) {
      spendCapError = "Enter an amount above 0, or leave blank for no cap.";
      return;
    }
  }
  try {
    const result = await saveSystemLimits({ systemSpendCapPerDay: value });
    spendCapInput = result.systemSpendCapPerDay == null ? "" : String(result.systemSpendCapPerDay);
  } catch (err) {
    spendCapError = err instanceof Error ? err.message : "Failed to save spend cap";
  }
}

// System name
let localName = $state(auth.localName ?? "");

async function saveLocalName() {
  const trimmed = localName.trim();
  try {
    await updateSystemName(trimmed);
    auth.localName = trimmed || null;
  } catch {
    localName = auth.localName ?? "";
  }
}

// System registration state
let systemError = $state("");
let systemAction = $state<"none" | "register" | "login">("none");
let systemInput = $state("");
let systemSaving = $state(false);

// AI defaults
let spiritModel = $state("");
let utilityModel = $state("");
let defaultsLoaded = $state(false);

let aiProvidersRef: AiProviders;

// Mind limit (maxMinds). Empty input = unlimited.
// Holds whatever the number input currently is (a number once typed); read through
// parsePositiveInt, never as a string.
let maxMindsInput: string | number = $state("");
let mindCount = $state(0);
let maxMindsError = $state("");
// Only true once the current cap loaded. Guards the onblur autosave from
// PUTting {maxMinds: null} — silently clearing an existing cap — after a failed
// load renders the field blank.
let maxMindsLoaded = $state(false);

onMount(async () => {
  aiProvidersRef.load();
  try {
    const defaults = await fetchAiDefaults();
    spiritModel = defaults.spiritModel ?? "";
    utilityModel = defaults.utilityModel ?? "";
  } catch {
    // will show via AiProviders load error
  }
  try {
    const limit = await fetchMaxMinds();
    maxMindsInput = limit.maxMinds == null ? "" : String(limit.maxMinds);
    mindCount = limit.count;
    maxMindsLoaded = true;
  } catch (err) {
    // Surface it: a blank field must not read as "no cap", or the autosave
    // below would clear a cap the admin never saw.
    maxMindsError = err instanceof Error ? err.message : "Failed to load mind limit";
  }
  defaultsLoaded = true;
});

async function saveMindLimit() {
  // Never overwrite the cap from a field that never loaded (see maxMindsLoaded).
  if (!maxMindsLoaded) return;
  maxMindsError = "";
  const trimmed = String(maxMindsInput ?? "").trim();
  let value: number | null = null;
  if (trimmed !== "") {
    value = parsePositiveInt(trimmed);
    if (value == null) {
      maxMindsError = "Enter a whole number of 1 or more, or leave blank for unlimited.";
      return;
    }
  }
  try {
    const result = await saveMaxMinds(value);
    maxMindsInput = result.maxMinds == null ? "" : String(result.maxMinds);
    mindCount = result.count;
  } catch (err) {
    maxMindsError = err instanceof Error ? err.message : "Failed to save limit";
  }
}

// Auto-save when defaults change (after initial load)
$effect(() => {
  const s = spiritModel;
  const u = utilityModel;
  if (!defaultsLoaded) return;
  saveAiDefaults({ spiritModel: s || null, utilityModel: u || null }).catch(() => {});
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
  <!-- System Name -->
  <div class="section">
    <div class="section-header">
      <span class="section-title">Name</span>
      <span class="section-subtitle">Displayed in the sidebar</span>
    </div>
    <input
      type="text"
      class="system-input"
      bind:value={localName}
      placeholder="e.g. My Garden"
      onblur={saveLocalName}
      onkeydown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
    />
  </div>

  <!-- Mind Limit -->
  <div class="section">
    <div class="section-header">
      <span class="section-title">Mind Limit</span>
      <span class="section-subtitle">
        Cap on total minds ({mindCount} in use). Blank = unlimited.
      </span>
    </div>
    <Input
      type="number"
      min="1"
      step="1"
      style="width:100%"
      bind:value={maxMindsInput}
      placeholder="Unlimited"
      disabled={!maxMindsLoaded}
      onblur={saveMindLimit}
      onkeydown={(e: KeyboardEvent) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
    />
    {#if maxMindsError}
      <div class="error">{maxMindsError}</div>
    {/if}
  </div>

  <!-- Spend Limit -->
  <div class="section">
    <div class="section-header">
      <span class="section-title">Spend Limit</span>
      <span class="section-subtitle">
        Install-wide cap in USD per day. Blank = no cap.
      </span>
    </div>
    <Input
      type="number"
      min="0"
      step="0.01"
      style="width:100%"
      bind:value={spendCapInput}
      placeholder="No cap"
      disabled={!spendCapLoaded}
      onblur={saveSpendCap}
      onkeydown={(e: KeyboardEvent) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
    />
    <div class="hint">
      When the whole install reaches this, every mind's deliveries are held until the day
      rolls over. Turns that can't be priced — a mind on a pre-upgrade template, or a model
      with no published rates — count nothing against it, so a cap binds only what it can
      see. System → Usage shows what isn't metered.
    </div>
    {#if spendCapError}
      <div class="error">{spendCapError}</div>
    {/if}
  </div>

  <!-- System Registration -->
  <div class="section">
    <div class="section-header">
      <span class="section-title">Registration</span>
      <span class="section-subtitle">volute.systems for pages and email</span>
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
              placeholder={systemAction === "register" ? "Name on volute.systems" : "API key"}
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

    <AiProviders
      bind:this={aiProvidersRef}
      showModelDefaults
      bind:spiritModel
      bind:utilityModel
    />
  </div>

  <!-- Image Generation -->
  <div class="section">
    <div class="section-header">
      <span class="section-title">Image Generation</span>
      <span class="section-subtitle">Provider configuration for mind image generation</span>
    </div>
    <ImagegenProviders />
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

  .hint {
    font-size: 11px;
    color: var(--text-2);
    line-height: 1.6;
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
</style>
