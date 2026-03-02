<script lang="ts">
import { changePassword, deleteAvatar, fetchMe, updateProfile, uploadAvatar } from "../lib/auth";
import Modal from "./Modal.svelte";

let { onClose }: { onClose: () => void } = $props();

// Profile state
let displayName = $state("");
let description = $state("");
let avatarUrl = $state<string | null>(null);
let profileError = $state("");
let profileSuccess = $state("");
let savingProfile = $state(false);
let avatarFile = $state<File | null>(null);
let avatarPreview = $state<string | null>(null);
let uploadingAvatar = $state(false);

// Password state
let currentPassword = $state("");
let newPassword = $state("");
let confirmPassword = $state("");
let error = $state("");
let success = $state("");
let saving = $state(false);

// Load profile on mount
$effect(() => {
  loadProfile();
});

async function loadProfile() {
  const me = await fetchMe();
  if (me) {
    displayName = me.display_name ?? "";
    description = me.description ?? "";
    avatarUrl = me.avatar ? `/api/auth/avatars/${me.avatar}` : null;
  }
}

async function handleSaveProfile(e: Event) {
  e.preventDefault();
  profileError = "";
  profileSuccess = "";
  savingProfile = true;
  try {
    await updateProfile({
      display_name: displayName.trim() || null,
      description: description.trim() || null,
    });
    profileSuccess = "Profile updated";
  } catch (err) {
    profileError = err instanceof Error ? err.message : "Failed to update profile";
  } finally {
    savingProfile = false;
  }
}

function handleAvatarSelect(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  avatarFile = file;
  avatarPreview = URL.createObjectURL(file);
}

async function handleUploadAvatar() {
  if (!avatarFile) return;
  uploadingAvatar = true;
  profileError = "";
  try {
    const filename = await uploadAvatar(avatarFile);
    avatarUrl = `/api/auth/avatars/${filename}`;
    avatarFile = null;
    avatarPreview = null;
  } catch (err) {
    profileError = err instanceof Error ? err.message : "Failed to upload avatar";
  } finally {
    uploadingAvatar = false;
  }
}

async function handleRemoveAvatar() {
  profileError = "";
  try {
    await deleteAvatar();
    avatarUrl = null;
    avatarFile = null;
    avatarPreview = null;
  } catch (err) {
    profileError = err instanceof Error ? err.message : "Failed to remove avatar";
  }
}

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
    <form onsubmit={handleSaveProfile}>
      <h3 class="section-title">Profile</h3>

      {#if profileError}
        <div class="message error">{profileError}</div>
      {/if}
      {#if profileSuccess}
        <div class="message success">{profileSuccess}</div>
      {/if}

      <div class="avatar-section">
        <div class="avatar-preview">
          {#if avatarPreview}
            <img src={avatarPreview} alt="Avatar preview" class="avatar-img" />
          {:else if avatarUrl}
            <img src={avatarUrl} alt="Avatar" class="avatar-img" />
          {:else}
            <div class="avatar-placeholder">?</div>
          {/if}
        </div>
        <div class="avatar-actions">
          <label class="avatar-upload-btn">
            Choose file
            <input type="file" accept="image/png,image/jpeg,image/gif,image/webp" onchange={handleAvatarSelect} hidden />
          </label>
          {#if avatarFile}
            <button type="button" class="save-btn" onclick={handleUploadAvatar} disabled={uploadingAvatar}>
              {uploadingAvatar ? "Uploading..." : "Upload"}
            </button>
          {/if}
          {#if avatarUrl && !avatarFile}
            <button type="button" class="remove-btn" onclick={handleRemoveAvatar}>Remove</button>
          {/if}
        </div>
      </div>

      <label class="field">
        <span class="label">Display name</span>
        <input type="text" bind:value={displayName} maxlength={100} placeholder="Optional display name" />
      </label>
      <label class="field">
        <span class="label">Description</span>
        <textarea bind:value={description} maxlength={500} placeholder="A short description" rows="3"></textarea>
      </label>

      <button class="save-btn" type="submit" disabled={savingProfile}>
        {savingProfile ? "Saving..." : "Save Profile"}
      </button>
    </form>

    <hr class="divider" />

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

  input,
  textarea {
    width: 100%;
    padding: 6px 10px;
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    color: var(--text-0);
    font-size: 12px;
    font-family: var(--mono);
    box-sizing: border-box;
    resize: vertical;
  }

  input:focus,
  textarea:focus {
    outline: none;
    border-color: var(--accent);
  }

  .avatar-section {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 12px;
  }

  .avatar-preview {
    width: 48px;
    height: 48px;
    border-radius: 50%;
    overflow: hidden;
    flex-shrink: 0;
    background: var(--bg-2);
    border: 1px solid var(--border);
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .avatar-img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .avatar-placeholder {
    font-size: 18px;
    color: var(--text-2);
  }

  .avatar-actions {
    display: flex;
    gap: 8px;
    align-items: center;
  }

  .avatar-upload-btn {
    padding: 4px 10px;
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    color: var(--text-1);
    font-size: 11px;
    cursor: pointer;
  }

  .avatar-upload-btn:hover {
    border-color: var(--border-bright);
  }

  .remove-btn {
    padding: 4px 10px;
    background: none;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    color: var(--red);
    font-size: 11px;
    cursor: pointer;
  }

  .remove-btn:hover {
    background: var(--red-bg);
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

  .divider {
    border: none;
    border-top: 1px solid var(--border);
    margin: 16px 0;
  }
</style>
