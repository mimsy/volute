<script lang="ts">
import type { ChannelSettings } from "@volute/api";
import { Modal } from "@volute/ui";
import { updateChannelSettings } from "../../lib/client";

let {
  channelName,
  settings,
  loadFailed = false,
  onClose,
  onSaved,
}: {
  channelName: string;
  settings: ChannelSettings | null;
  loadFailed?: boolean;
  onClose: () => void;
  onSaved: (settings: ChannelSettings) => void;
} = $props();

// Intentional initial-value capture: the modal remounts on every open, so the
// form seeds from the settings prop as of open time.
// svelte-ignore state_referenced_locally
let description = $state(settings?.description ?? "");
// svelte-ignore state_referenced_locally
let rules = $state(settings?.rules ?? "");
// The numeric fields are `bind:value` on <input type="number">, which hands back a number
// once edited (and null when cleared) — never a string. They're typed for all three.
// svelte-ignore state_referenced_locally
let charLimit = $state<number | string | null>(settings?.charLimit ?? null);
// svelte-ignore state_referenced_locally
let rateLimit = $state<number | string | null>(settings?.rateLimit ?? null);
// svelte-ignore state_referenced_locally
let rateWindow = $state<number | string | null>(settings?.rateWindow ?? null);
// svelte-ignore state_referenced_locally
let isPrivate = $state(settings?.private ?? false);
let saving = $state(false);
let error = $state("");

/**
 * Parse an optional positive-integer field: null when empty, undefined when invalid.
 * Accepts a number or a string, since the binding yields either depending on whether the
 * field has been edited.
 */
function parsePositive(raw: number | string | null | undefined): number | null | undefined {
  const value = typeof raw === "string" ? raw.trim() : raw;
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) return undefined;
  return n;
}

async function handleSave() {
  if (saving) return;
  error = "";

  const parsedLimit = parsePositive(charLimit);
  if (parsedLimit === undefined) {
    error = "Char limit must be a positive whole number.";
    return;
  }

  const parsedRate = parsePositive(rateLimit);
  const parsedWindow = parsePositive(rateWindow);
  if (parsedRate === undefined || parsedWindow === undefined) {
    error = "Rate limit must be a positive whole number of messages and seconds.";
    return;
  }
  // The server rejects a half-set pair, so catch it here with a clearer message.
  if ((parsedRate === null) !== (parsedWindow === null)) {
    error = "Set both the message count and the time window, or leave both empty.";
    return;
  }

  saving = true;
  const next: ChannelSettings = {
    description: description.trim() || null,
    rules: rules.trim() || null,
    charLimit: parsedLimit,
    rateLimit: parsedRate,
    rateWindow: parsedWindow,
    private: isPrivate,
  };
  try {
    // Propagate the server's canonical settings, not the locally built object.
    const saved = await updateChannelSettings(channelName, next);
    onSaved(saved);
    onClose();
  } catch (err) {
    error = err instanceof Error ? err.message : "Failed to save settings";
  } finally {
    saving = false;
  }
}
</script>

<Modal size="420px" title="#{channelName} settings" {onClose}>
  <div class="settings-body">
    {#if loadFailed}
      <div class="warning">
        Couldn't load the channel's current settings — saving will overwrite them.
      </div>
    {/if}

    <label class="field">
      <span class="field-label">Description</span>
      <textarea
        bind:value={description}
        rows="2"
        placeholder="What this channel is about"
      ></textarea>
    </label>

    <label class="field">
      <span class="field-label">Rules</span>
      <textarea
        bind:value={rules}
        rows="3"
        placeholder="Guidelines for participants"
      ></textarea>
    </label>

    <label class="field">
      <span class="field-label">Character limit</span>
      <input
        type="number"
        min="1"
        bind:value={charLimit}
        placeholder="None"
      />
      <span class="hint">Leave empty for no limit.</span>
    </label>

    <div class="field">
      <span class="field-label">Rate limit</span>
      <div class="rate-row">
        <input type="number" min="1" bind:value={rateLimit} placeholder="None" />
        <span class="rate-sep">messages per</span>
        <input type="number" min="1" bind:value={rateWindow} placeholder="60" />
        <span class="rate-sep">seconds</span>
      </div>
      <span class="hint">Counted across everyone in the channel. Leave empty for no limit.</span>
    </div>

    <label class="checkbox-field">
      <input type="checkbox" bind:checked={isPrivate} />
      <span>Private channel</span>
    </label>

    {#if error}
      <div class="error">{error}</div>
    {/if}

    <div class="actions">
      <button class="btn-secondary" onclick={onClose} disabled={saving}>Cancel</button>
      <button class="btn-primary" onclick={handleSave} disabled={saving}>
        {saving ? "Saving..." : "Save"}
      </button>
    </div>
  </div>
</Modal>

<style>
  .settings-body {
    padding: 12px 16px 16px;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 5px;
  }

  .field-label {
    font-size: 12px;
    font-weight: 600;
    color: var(--text-1);
  }

  textarea,
  input[type="number"] {
    width: 100%;
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 8px 10px;
    color: var(--text-0);
    font-size: 14px;
    font-family: inherit;
    outline: none;
    box-sizing: border-box;
    resize: vertical;
  }

  textarea:focus,
  input[type="number"]:focus {
    border-color: var(--border-bright);
  }

  .hint {
    font-size: 12px;
    color: var(--text-2);
  }

  .rate-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .rate-row input[type="number"] {
    width: 5.5em;
    flex: 0 0 auto;
  }

  .rate-sep {
    font-size: 13px;
    color: var(--text-2);
    white-space: nowrap;
  }

  .checkbox-field {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 14px;
    color: var(--text-0);
    cursor: pointer;
  }

  .checkbox-field input {
    cursor: pointer;
  }

  .error {
    color: var(--red);
    font-size: 13px;
  }

  .warning {
    color: var(--yellow);
    font-size: 13px;
    padding: 8px 10px;
    border: 1px solid var(--yellow-bg);
    border-radius: var(--radius);
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 4px;
  }

  .btn-primary,
  .btn-secondary {
    padding: 7px 14px;
    border-radius: var(--radius);
    font-size: 14px;
    cursor: pointer;
  }

  .btn-primary {
    background: var(--accent);
    color: var(--bg-0);
    border: 1px solid var(--accent);
  }

  .btn-secondary {
    background: none;
    color: var(--text-1);
    border: 1px solid var(--border);
  }

  .btn-primary:disabled,
  .btn-secondary:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
</style>
