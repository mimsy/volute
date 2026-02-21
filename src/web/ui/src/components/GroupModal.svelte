<script lang="ts">
import {
  type AvailableUser,
  type Conversation,
  createConversationWithParticipants,
  fetchAvailableUsers,
} from "../lib/api";

let { onClose, onCreated }: { onClose: () => void; onCreated: (conv: Conversation) => void } =
  $props();

let users = $state<AvailableUser[]>([]);
let selected = $state<Set<string>>(new Set());
let title = $state("");
let loading = $state(false);
let error = $state("");

$effect(() => {
  fetchAvailableUsers()
    .then((u) => {
      users = u;
    })
    .catch(() => {
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
  if (!hasMind) {
    error = "Select at least one mind";
    return;
  }
  loading = true;
  error = "";
  try {
    const conv = await createConversationWithParticipants([...selected], title || undefined);
    onCreated(conv);
  } catch (e) {
    error = e instanceof Error ? e.message : "Failed to create";
    loading = false;
  }
}
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="overlay" onclick={onClose} onkeydown={() => {}}>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="modal" onclick={(e) => e.stopPropagation()} onkeydown={() => {}}>
    <div class="modal-title">New group conversation</div>

    <input
      bind:value={title}
      placeholder="Title (optional)"
      class="title-input"
    />

    <div class="hint">Select participants (at least one mind):</div>
    <div class="user-list">
      {#each users as u}
        <label class="user-row">
          <input
            type="checkbox"
            checked={selected.has(u.username)}
            onchange={() => toggle(u.username)}
          />
          <span>{u.username}</span>
          <span class="user-type" class:mind={u.user_type === "mind"}>{u.user_type}</span>
        </label>
      {/each}
    </div>

    {#if error}
      <div class="error">{error}</div>
    {/if}

    <div class="actions">
      <button class="cancel-btn" onclick={onClose}>Cancel</button>
      <button
        class="create-btn"
        onclick={handleCreate}
        disabled={loading || !hasMind}
        style:opacity={loading || !hasMind ? 0.5 : 1}
      >
        {loading ? "Creating..." : "Create"}
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
    width: 340px;
    max-height: 70vh;
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
  }

  .user-list {
    flex: 1;
    overflow: auto;
    max-height: 250px;
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

  .user-type {
    color: var(--text-2);
    font-size: 10px;
    margin-left: auto;
  }

  .user-type.mind {
    color: var(--accent);
  }

  .error {
    color: var(--red);
    font-size: 11px;
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
