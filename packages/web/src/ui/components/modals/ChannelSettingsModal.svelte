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
// svelte-ignore state_referenced_locally
let charLimit = $state(settings?.charLimit != null ? String(settings.charLimit) : "");
// svelte-ignore state_referenced_locally
let isPrivate = $state(settings?.private ?? false);
let saving = $state(false);
let error = $state("");

async function handleSave() {
  if (saving) return;
  error = "";

  const trimmedLimit = charLimit.trim();
  let parsedLimit: number | null = null;
  if (trimmedLimit) {
    const n = Number(trimmedLimit);
    if (!Number.isInteger(n) || n <= 0) {
      error = "Char limit must be a positive whole number.";
      return;
    }
    parsedLimit = n;
  }

  saving = true;
  const next: ChannelSettings = {
    description: description.trim() || null,
    rules: rules.trim() || null,
    charLimit: parsedLimit,
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
