<script lang="ts">
import { changePassword } from "../lib/auth";
import Modal from "./Modal.svelte";

let { onClose }: { onClose: () => void } = $props();

let currentPassword = $state("");
let newPassword = $state("");
let confirmPassword = $state("");
let error = $state("");
let success = $state("");
let saving = $state(false);

async function handleChangePassword(e: Event) {
  e.preventDefault();
  error = "";
  success = "";

  if (newPassword !== confirmPassword) {
    error = "New passwords do not match";
    return;
  }
  if (newPassword.length < 1) {
    error = "New password cannot be empty";
    return;
  }

  saving = true;
  try {
    await changePassword(currentPassword, newPassword);
    success = "Password changed successfully";
    currentPassword = "";
    newPassword = "";
    confirmPassword = "";
  } catch (err) {
    error = err instanceof Error ? err.message : "Failed to change password";
  } finally {
    saving = false;
  }
}
</script>

<Modal size="420px" title="User Settings" {onClose}>
  <div class="modal-body">
    <form onsubmit={handleChangePassword}>
      <h3 class="section-title">Change Password</h3>

      {#if error}
        <div class="message error">{error}</div>
      {/if}
      {#if success}
        <div class="message success">{success}</div>
      {/if}

      <label class="field">
        <span class="label">Current password</span>
        <input type="password" bind:value={currentPassword} autocomplete="current-password" />
      </label>
      <label class="field">
        <span class="label">New password</span>
        <input type="password" bind:value={newPassword} autocomplete="new-password" />
      </label>
      <label class="field">
        <span class="label">Confirm new password</span>
        <input type="password" bind:value={confirmPassword} autocomplete="new-password" />
      </label>

      <button class="save-btn" type="submit" disabled={saving}>
        {saving ? "Saving..." : "Change Password"}
      </button>
    </form>
  </div>
</Modal>

<style>
  .modal-body {
    padding: 16px;
  }

  .section-title {
    font-size: 12px;
    font-weight: 600;
    color: var(--text-1);
    margin: 0 0 12px;
  }

  .field {
    display: block;
    margin-bottom: 10px;
  }

  .label {
    display: block;
    font-size: 11px;
    color: var(--text-2);
    margin-bottom: 4px;
  }

  input {
    width: 100%;
    padding: 6px 10px;
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    color: var(--text-0);
    font-size: 12px;
    font-family: var(--mono);
    box-sizing: border-box;
  }

  input:focus {
    outline: none;
    border-color: var(--accent);
  }

  .save-btn {
    margin-top: 4px;
    padding: 6px 14px;
    background: var(--accent-dim);
    color: var(--accent);
    border-radius: var(--radius);
    font-size: 11px;
    font-weight: 500;
  }

  .save-btn:hover:not(:disabled) {
    background: var(--accent);
    color: var(--bg-0);
  }

  .save-btn:disabled {
    opacity: 0.5;
  }

  .message {
    font-size: 11px;
    padding: 6px 10px;
    border-radius: var(--radius);
    margin-bottom: 10px;
  }

  .message.error {
    color: var(--red);
    background: var(--red-bg);
  }

  .message.success {
    color: var(--accent);
    background: var(--accent-dim);
  }
</style>
