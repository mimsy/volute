<script lang="ts">
import { Button, Input, Modal } from "@volute/ui";
import { registerExternalMind } from "../../lib/auth";

let {
  onClose,
  onRegistered,
}: {
  onClose: () => void;
  onRegistered: () => void;
} = $props();

let name = $state("");
let displayName = $state("");
let description = $state("");
let error = $state("");
let submitting = $state(false);

// The plaintext token exists nowhere but this response — it is never re-fetchable.
let issued = $state<{ name: string; token: string } | null>(null);
let copied = $state(false);

async function handleSubmit(e: Event) {
  e.preventDefault();
  const trimmed = name.trim();
  if (!trimmed || submitting) return;
  submitting = true;
  error = "";
  try {
    const result = await registerExternalMind({
      name: trimmed,
      displayName: displayName.trim() || undefined,
      description: description.trim() || undefined,
    });
    issued = { name: result.name, token: result.token };
    onRegistered();
  } catch (err) {
    error = err instanceof Error ? err.message : "Failed to register";
  } finally {
    submitting = false;
  }
}

async function copyToken() {
  if (!issued) return;
  try {
    // Absent entirely on a non-secure origin (a LAN Volute over plain HTTP), so
    // this throws rather than returning a rejected promise.
    await navigator.clipboard.writeText(issued.token);
    copied = true;
    error = "";
    setTimeout(() => (copied = false), 1500);
  } catch {
    error = "Couldn't copy — select the token and copy it manually";
  }
}
</script>

<Modal size="420px" title={issued ? `@${issued.name} registered` : "Add external mind"} {onClose}>
  <div class="body">
    {#if issued}
      <p class="lede">
        Give this token to the mind. It authenticates as
        <span class="mono">@{issued.name}</span> over the API — no process runs here.
      </p>

      <div class="token-box">
        <code class="token">{issued.token}</code>
        <Button variant="secondary" onclick={copyToken}>{copied ? "copied" : "copy"}</Button>
      </div>

      <p class="warn">
        This is the only time the token is shown — only a hash of it is stored. If it's lost,
        issue a new one from the mind's card.
      </p>

      {#if error}
        <div class="error">{error}</div>
      {/if}

      <div class="actions">
        <Button variant="primary" onclick={onClose}>done</Button>
      </div>
    {:else}
      <p class="lede">
        An external mind runs somewhere else and reaches in over the API. It gets an account and a
        token, but no process, port, or directory here.
      </p>

      <form onsubmit={handleSubmit}>
        <div class="field">
          <label for="ext-name">Name</label>
          <Input
            id="ext-name"
            bind:value={name}
            placeholder="hecate"
            autocomplete="off"
            spellcheck={false}
          />
          <span class="hint">Letters, numbers, dot, dash, underscore. Used as @name.</span>
        </div>

        <div class="field">
          <label for="ext-display">Display name <span class="opt">optional</span></label>
          <Input id="ext-display" bind:value={displayName} placeholder="Hecate" autocomplete="off" />
        </div>

        <div class="field">
          <label for="ext-desc">Description <span class="opt">optional</span></label>
          <Input
            id="ext-desc"
            bind:value={description}
            placeholder="What is this mind?"
            autocomplete="off"
          />
        </div>

        {#if error}
          <div class="error">{error}</div>
        {/if}

        <div class="actions">
          <Button variant="text" type="button" onclick={onClose}>cancel</Button>
          <Button variant="primary" type="submit" disabled={!name.trim() || submitting}>
            {submitting ? "registering..." : "register"}
          </Button>
        </div>
      </form>
    {/if}
  </div>
</Modal>

<style>
  .body {
    padding: 12px 16px 16px;
  }

  .lede {
    color: var(--text-1);
    font-size: 13px;
    line-height: 1.5;
    margin: 0 0 14px;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-bottom: 12px;
  }

  .field label {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-2);
  }

  .opt {
    text-transform: none;
    letter-spacing: 0;
    opacity: 0.7;
  }

  .hint {
    font-size: 11px;
    color: var(--text-2);
  }

  .token-box {
    display: flex;
    align-items: center;
    gap: 8px;
    background: var(--bg-1);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 8px 10px;
  }

  .token {
    flex: 1;
    min-width: 0;
    font-family: var(--mono);
    font-size: 12px;
    color: var(--text-0);
    overflow-wrap: anywhere;
    user-select: all;
  }

  .mono {
    font-family: var(--mono);
    color: var(--text-0);
  }

  .warn {
    font-size: 12px;
    line-height: 1.5;
    color: var(--yellow);
    margin: 10px 0 0;
  }

  .error {
    color: var(--red);
    font-size: 12px;
    margin-top: 8px;
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 16px;
  }
</style>
