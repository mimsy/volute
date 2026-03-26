<script lang="ts">
import type { Mind } from "@volute/api";
import { SettingsSection } from "@volute/ui";
import { fetchMinds, updateMindProfile, uploadMindAvatar } from "../../lib/client";
import { data } from "../../lib/stores.svelte";
import { useSavedFeedback } from "../../lib/useSavedFeedback.svelte";

let {
  mind,
  onUpdated,
}: {
  mind: Mind;
  onUpdated: () => void;
} = $props();

let displayName = $state("");
let description = $state("");
let fileInput = $state<HTMLInputElement | null>(null);

const { savedField, showSaved } = useSavedFeedback();

// Sync local state from mind prop on changes
$effect(() => {
  displayName = mind.displayName ?? "";
  description = mind.description ?? "";
});

async function handleAvatarChange(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  await uploadMindAvatar(mind.name, file);
  data.minds = await fetchMinds();
  onUpdated();
  input.value = "";
}

async function saveDisplayName() {
  const value = displayName.trim();
  if (value === (mind.displayName ?? "")) return;
  await updateMindProfile(mind.name, { displayName: value });
  showSaved("displayName");
  onUpdated();
}

async function saveDescription() {
  const value = description.trim();
  if (value === (mind.description ?? "")) return;
  await updateMindProfile(mind.name, { description: value });
  showSaved("description");
  onUpdated();
}
</script>

<SettingsSection title="Profile" subtitle="Avatar, display name, and description">

  <div class="profile-fields">
    <div class="field-row">
      <span class="field-label">Avatar</span>
      <button type="button" class="avatar-wrapper" onclick={() => fileInput?.click()}>
        {#if mind.avatar}
          <img
            src={`/api/minds/${encodeURIComponent(mind.name)}/avatar`}
            alt=""
            class="avatar-img"
          />
        {:else}
          <div class="avatar-placeholder">?</div>
        {/if}
        <div class="avatar-overlay">Change</div>
        <input
          bind:this={fileInput}
          type="file"
          accept="image/*"
          onchange={handleAvatarChange}
          hidden
        />
      </button>
    </div>

    <div class="field-row">
      <label class="field-label" for="profile-display-name">Display name</label>
      <div class="field-input-wrap">
        <input
          id="profile-display-name"
          type="text"
          bind:value={displayName}
          onblur={saveDisplayName}
          placeholder={mind.name}
        />
        {#if savedField === "displayName"}
          <span class="saved-indicator">Saved</span>
        {/if}
      </div>
    </div>

    <div class="field-row">
      <label class="field-label" for="profile-description">Description</label>
      <div class="field-input-wrap">
        <textarea
          id="profile-description"
          rows="2"
          bind:value={description}
          onblur={saveDescription}
          placeholder="A short description"
        ></textarea>
        {#if savedField === "description"}
          <span class="saved-indicator">Saved</span>
        {/if}
      </div>
    </div>
  </div>
</SettingsSection>

<style>
  .profile-fields {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .field-row {
    display: flex;
    align-items: flex-start;
    gap: 12px;
  }

  .field-label {
    width: 100px;
    flex-shrink: 0;
    font-size: 13px;
    color: var(--text-1);
    padding-top: 6px;
  }

  .field-input-wrap {
    flex: 1;
    position: relative;
  }

  .field-input-wrap input,
  .field-input-wrap textarea {
    width: 100%;
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    color: var(--text-0);
    font-family: inherit;
    font-size: 13px;
    padding: 6px 8px;
    box-sizing: border-box;
  }

  .field-input-wrap input:focus,
  .field-input-wrap textarea:focus {
    outline: none;
    border-color: var(--border-bright);
  }

  .field-input-wrap textarea {
    resize: vertical;
    line-height: 1.4;
  }

  .saved-indicator {
    position: absolute;
    right: 8px;
    top: 6px;
    font-size: 11px;
    color: var(--accent);
    animation: fade-out 1.5s ease forwards;
  }

  @keyframes fade-out {
    0%, 60% { opacity: 1; }
    100% { opacity: 0; }
  }

  .avatar-wrapper {
    width: 80px;
    height: 80px;
    border-radius: var(--radius);
    overflow: hidden;
    cursor: pointer;
    position: relative;
    flex-shrink: 0;
    padding: 0;
    border: none;
    background: none;
  }

  .avatar-img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }

  .avatar-placeholder {
    width: 100%;
    height: 100%;
    background: var(--bg-2);
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--text-2);
    font-size: 24px;
  }

  .avatar-overlay {
    position: absolute;
    inset: 0;
    background: rgba(0, 0, 0, 0.45);
    display: flex;
    align-items: center;
    justify-content: center;
    color: #fff;
    font-size: 12px;
    opacity: 0;
    transition: opacity 0.15s;
  }

  .avatar-wrapper:hover .avatar-overlay {
    opacity: 1;
  }
</style>
