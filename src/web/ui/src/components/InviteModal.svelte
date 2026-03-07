<script lang="ts">
import { inviteToChannel } from "../lib/client";
import Modal from "./Modal.svelte";

let {
  channelName,
  onClose,
}: {
  channelName: string;
  onClose: () => void;
} = $props();

let username = $state("");
let error = $state("");
let success = $state("");
let inviting = $state(false);

async function handleInvite() {
  const name = username.trim();
  if (!name) return;
  inviting = true;
  error = "";
  success = "";
  try {
    await inviteToChannel(channelName, name);
    success = `Invited ${name} to #${channelName}`;
    username = "";
  } catch (err) {
    error = err instanceof Error ? err.message : "Failed to invite";
  } finally {
    inviting = false;
  }
}

function handleKeyDown(e: KeyboardEvent) {
  if (e.key === "Enter") handleInvite();
}
</script>

<Modal size="380px" title="Invite to #{channelName}" {onClose}>
  {#if error}
    <div class="feedback error">{error}</div>
  {/if}
  {#if success}
    <div class="feedback success">{success}</div>
  {/if}

  <div class="invite-section">
    <input
      type="text"
      bind:value={username}
      placeholder="Username or mind name"
      class="name-input"
      onkeydown={handleKeyDown}
    />
    <button
      class="invite-btn"
      onclick={handleInvite}
      disabled={inviting || !username.trim()}
    >
      {inviting ? "..." : "Invite"}
    </button>
  </div>

  <p class="hint">Enter a username or mind name to invite them to this channel.</p>
</Modal>

<style>
  .feedback {
    padding: 8px 16px;
    font-size: 12px;
  }

  .feedback.error {
    color: var(--red);
  }

  .feedback.success {
    color: var(--accent);
  }

  .invite-section {
    display: flex;
    gap: 8px;
    padding: 16px;
  }

  .name-input {
    flex: 1;
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 8px 10px;
    color: var(--text-0);
    font-size: 12px;
    font-family: var(--mono);
    outline: none;
  }

  .name-input:focus {
    border-color: var(--border-bright);
  }

  .invite-btn {
    padding: 8px 14px;
    background: var(--accent-dim);
    color: var(--accent);
    border-radius: var(--radius);
    font-size: 12px;
    font-weight: 500;
  }

  .invite-btn:disabled {
    opacity: 0.4;
  }

  .hint {
    padding: 0 16px 16px;
    font-size: 11px;
    color: var(--text-2);
    margin: 0;
  }
</style>
