<script lang="ts">
import { onMount } from "svelte";
import {
  type AvailableUser,
  type Conversation,
  createConversationWithParticipants,
  fetchAvailableUsers,
  type Mind,
} from "../lib/api";
import { mindDotColor } from "../lib/format";
import Modal from "./Modal.svelte";

let {
  minds,
  onClose,
  onPick,
  onGroupCreated,
}: {
  minds: Mind[];
  onClose: () => void;
  onPick: (name: string) => void;
  onGroupCreated: (conv: Conversation) => void;
} = $props();

let users = $state<AvailableUser[]>([]);
let selected = $state<string[]>([]);
let query = $state("");
let title = $state("");
let loading = $state(true);
let creating = $state(false);
let error = $state("");
let inputEl = $state<HTMLInputElement | null>(null);
let dropdownOpen = $state(false);

onMount(() => {
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

let filtered = $derived(
  users.filter(
    (u) => !selected.includes(u.username) && u.username.toLowerCase().includes(query.toLowerCase()),
  ),
);

function addUser(username: string) {
  if (!selected.includes(username)) {
    selected = [...selected, username];
  }
  query = "";
  inputEl?.focus();
}

function removeUser(username: string) {
  selected = selected.filter((s) => s !== username);
  inputEl?.focus();
}

function handleKeydown(e: KeyboardEvent) {
  if (e.key === "Enter") {
    e.preventDefault();
    if (filtered.length > 0) {
      addUser(filtered[0].username);
    }
  } else if (e.key === "Escape") {
    if (query) {
      e.preventDefault();
      query = "";
    } else {
      onClose();
    }
  } else if (e.key === "Backspace" && !query && selected.length > 0) {
    selected = selected.slice(0, -1);
  }
}

function mindForUser(username: string): Mind | undefined {
  return minds.find((m) => m.name === username);
}

let hasMind = $derived(users.some((u) => u.user_type === "mind" && selected.includes(u.username)));

async function handleCreate() {
  if (selected.length === 0) return;
  if (selected.length === 1) {
    onPick(selected[0]);
    return;
  }
  if (!hasMind) {
    error = "Select at least one mind";
    return;
  }
  creating = true;
  error = "";
  try {
    const conv = await createConversationWithParticipants(selected, title || undefined);
    onGroupCreated(conv);
  } catch (e) {
    error = e instanceof Error ? e.message : "Failed to create";
    creating = false;
  }
}

let buttonLabel = $derived(
  selected.length === 0
    ? "Select a user"
    : selected.length === 1
      ? "Chat"
      : creating
        ? "Creating..."
        : "Create group",
);
let buttonDisabled = $derived(
  selected.length === 0 || creating || (selected.length > 1 && !hasMind),
);
</script>

<Modal size="300px" {onClose}>
  <div class="modal-content">
    <div class="modal-title">New conversation</div>

    {#if selected.length > 1}
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
      <div class="tag-input-wrapper">
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
          class="tag-input"
          onclick={() => inputEl?.focus()}
          onkeydown={() => {}}
        >
          {#each selected as username}
            {@const mind = mindForUser(username)}
            <span class="tag">
              {#if mind}
                <span
                  class="dot"
                  style:background={mindDotColor(mind)}
                  style:box-shadow={mindDotColor(mind) !== "var(--text-2)" ? `0 0 4px ${mindDotColor(mind)}` : "none"}
                ></span>
              {/if}
              <span class="tag-name">{username}</span>
              <!-- svelte-ignore a11y_no_static_element_interactions -->
              <span
                class="tag-remove"
                onclick={(e) => { e.stopPropagation(); removeUser(username); }}
                onkeydown={() => {}}
              >&times;</span>
            </span>
          {/each}
          <input
            bind:this={inputEl}
            bind:value={query}
            placeholder={selected.length === 0 ? "Search users..." : ""}
            class="tag-text-input"
            onkeydown={handleKeydown}
            onfocus={() => (dropdownOpen = true)}
            onblur={() => setTimeout(() => (dropdownOpen = false), 150)}
          />
        </div>

        {#if dropdownOpen && !loading && filtered.length > 0}
          <div class="dropdown">
            {#each filtered as u}
              {@const mind = mindForUser(u.username)}
              <!-- svelte-ignore a11y_no_static_element_interactions -->
              <div
                class="dropdown-item"
                onmousedown={() => addUser(u.username)}
                onkeydown={() => {}}
              >
                {#if mind}
                  <span
                    class="dot"
                    style:background={mindDotColor(mind)}
                    style:box-shadow={mindDotColor(mind) !== "var(--text-2)" ? `0 0 4px ${mindDotColor(mind)}` : "none"}
                  ></span>
                {/if}
                <span class="item-name">{u.username}</span>
                {#if u.user_type === "mind"}
                  <span class="item-badge">mind</span>
                {/if}
              </div>
            {/each}
          </div>
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
</Modal>

<style>
  .modal-content {
    padding: 20px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    max-height: 60vh;
    overflow: auto;
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

  .tag-input-wrapper {
    position: relative;
  }

  .tag-input {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px;
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 6px 8px;
    min-height: 32px;
    cursor: text;
  }

  .tag-input:focus-within {
    border-color: var(--accent);
  }

  .tag {
    display: flex;
    align-items: center;
    gap: 4px;
    background: var(--bg-3);
    border-radius: 3px;
    padding: 2px 6px;
    font-size: 11px;
    color: var(--text-0);
    white-space: nowrap;
  }

  .tag-name {
    line-height: 1;
  }

  .tag-remove {
    cursor: pointer;
    color: var(--text-2);
    font-size: 13px;
    line-height: 1;
    margin-left: 2px;
  }

  .tag-remove:hover {
    color: var(--text-0);
  }

  .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .tag-text-input {
    flex: 1;
    min-width: 60px;
    background: none;
    border: none;
    outline: none;
    color: var(--text-0);
    font-size: 12px;
    padding: 2px 0;
    font-family: var(--mono);
  }

  .tag-text-input::placeholder {
    color: var(--text-2);
  }

  .dropdown {
    position: absolute;
    top: 100%;
    left: 0;
    right: 0;
    margin-top: 4px;
    background: var(--bg-1);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    max-height: 200px;
    overflow: auto;
    z-index: 10;
  }

  .dropdown-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    cursor: pointer;
    font-size: 12px;
    color: var(--text-0);
  }

  .dropdown-item:hover {
    background: var(--bg-2);
  }

  .item-name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .item-badge {
    color: var(--accent);
    font-size: 10px;
    flex-shrink: 0;
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
