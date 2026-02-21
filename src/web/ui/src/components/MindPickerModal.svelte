<script lang="ts">
import {
  type AvailableUser,
  type Conversation,
  createConversationWithParticipants,
  fetchAvailableUsers,
} from "../lib/api";

let {
  onClose,
  onPick,
  onGroupCreated,
}: {
  onClose: () => void;
  onPick: (name: string) => void;
  onGroupCreated: (conv: Conversation) => void;
} = $props();

let users = $state<AvailableUser[]>([]);
let selected = $state<Set<string>>(new Set());
let title = $state("");
let loading = $state(true);
let creating = $state(false);
let error = $state("");

$effect(() => {
  fetchAvailableUsers()
    .then((u) => {
      users = u;
      loading = false;
    })
    .catch(() => {
      loading = false;
      error = "Failed to load users";
    });
});

function toggle(username: string) {
  const next = new Set(selected);
  if (next.has(username)) next.delete(username);
  else next.add(username);
  selected = next;
}

let hasMind = $derived(users.some((u) => u.user_type === "mind" && selected.has(u.username)));

async function handleCreate() {
  if (selected.size === 0) return;
  if (selected.size === 1) {
    onPick([...selected][0]);
    return;
  }
  // Group: need at least one mind
  if (!hasMind) {
    error = "Select at least one mind";
    return;
  }
  creating = true;
  error = "";
  try {
    const conv = await createConversationWithParticipants([...selected], title || undefined);
    onGroupCreated(conv);
  } catch (e) {
    error = e instanceof Error ? e.message : "Failed to create";
    creating = false;
  }
}

let buttonLabel = $derived(
  selected.size === 0
    ? "Select a user"
    : selected.size === 1
      ? "Chat"
      : creating
        ? "Creating..."
        : "Create group",
);
let buttonDisabled = $derived(selected.size === 0 || creating || (selected.size > 1 && !hasMind));
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="overlay" onclick={onClose} onkeydown={() => {}}>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="modal" onclick={(e) => e.stopPropagation()} onkeydown={() => {}}>
    <div class="modal-title">New conversation</div>

    {#if selected.size > 1}
      <input
        bind:value={title}
        placeholder="Title (optional)"
        class="title-input"
      />
    {/if}

    {#if loading}
      <div class="hint">Loading users...</div>
    {:else if error && users.length === 0}
      <div class="error">{error}</div>
    {:else}
      <div class="user-list">
        {#each users as u}
          <label class="user-row">
            <input
              type="checkbox"
              checked={selected.has(u.username)}
              onchange={() => toggle(u.username)}
            />
            <span class="user-name">{u.username}</span>
            {#if u.user_type === "mind"}
              <span class="user-type mind">mind</span>
            {/if}
          </label>
        {/each}
        {#if users.length === 0}
          <div class="hint">No users found</div>
        {/if}
      </div>
    {/if}

    {#if error && users.length > 0}
      <div class="error">{error}</div>
    {/if}

    <div class="actions">
      <button class="cancel-btn" onclick={onClose}>Cancel</button>
      <button
        class="create-btn"
        onclick={handleCreate}
        disabled={buttonDisabled}
        style:opacity={buttonDisabled ? 0.5 : 1}
      >
        {buttonLabel}
      </button>
    </div>
  </div>
</div>

<style>
  .overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
  }

  .modal {
    background: var(--bg-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: 20px;
    width: 300px;
    max-height: 60vh;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .modal-title {
    font-weight: 600;
    color: var(--text-0);
    font-size: 14px;
  }

  .title-input {
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 8px 10px;
    color: var(--text-0);
    font-size: 12px;
    outline: none;
    font-family: var(--mono);
  }

  .hint {
    color: var(--text-2);
    font-size: 11px;
    padding: 8px;
  }

  .error {
    color: var(--red);
    font-size: 11px;
  }

  .user-list {
    flex: 1;
    overflow: auto;
    max-height: 300px;
  }

  .user-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 4px;
    cursor: pointer;
    font-size: 12px;
    color: var(--text-0);
  }

  .user-name {
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .user-type {
    color: var(--text-2);
    font-size: 10px;
    margin-left: auto;
  }

  .user-type.mind {
    color: var(--accent);
  }

  .actions {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
  }

  .cancel-btn {
    padding: 6px 14px;
    background: var(--bg-2);
    color: var(--text-1);
    border-radius: var(--radius);
    font-size: 12px;
    border: 1px solid var(--border);
  }

  .create-btn {
    padding: 6px 14px;
    background: var(--accent-dim);
    color: var(--accent);
    border-radius: var(--radius);
    font-size: 12px;
    font-weight: 500;
  }
</style>
