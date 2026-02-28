<script lang="ts">
import type { ConversationWithParticipants, Mind } from "@volute/api";
import { inviteToChannel } from "../lib/client";
import { getDisplayStatus, mindDotColor } from "../lib/format";
import { activeMinds, reconnectActivity } from "../lib/stores.svelte";
import StatusBadge from "./StatusBadge.svelte";

let {
  conversation,
  minds,
  onOpenMind,
}: {
  conversation: ConversationWithParticipants;
  minds: Mind[];
  onOpenMind: (mind: Mind) => void;
} = $props();

let mindsByName = $derived(new Map(minds.map((m) => [m.name, m])));

let mindParticipants = $derived(
  conversation.participants
    .filter((p) => p.userType === "mind")
    .map((p) => ({ participant: p, mind: mindsByName.get(p.username) })),
);

let userParticipants = $derived(conversation.participants.filter((p) => p.userType !== "mind"));

// Invite state (channels only)
let isChannel = $derived(conversation.type === "channel" && !!conversation.name);
let inviteQuery = $state("");
let inviteError = $state("");
let inviting = $state(false);
let showSuggestions = $state(false);

let memberNames = $derived(new Set(conversation.participants.map((p) => p.username)));

let suggestions = $derived(
  inviteQuery.trim()
    ? minds.filter(
        (m) => !memberNames.has(m.name) && m.name.toLowerCase().includes(inviteQuery.toLowerCase()),
      )
    : minds.filter((m) => !memberNames.has(m.name)),
);

async function handleInvite(name: string) {
  if (!conversation.name || inviting) return;
  inviting = true;
  inviteError = "";
  try {
    await inviteToChannel(conversation.name, name);
    inviteQuery = "";
    showSuggestions = false;
    reconnectActivity();
  } catch (err) {
    inviteError = err instanceof Error ? err.message : "Failed to invite";
  } finally {
    inviting = false;
  }
}

function handleInputFocus() {
  showSuggestions = true;
}

function handleInputBlur() {
  // Delay to allow click on suggestion
  setTimeout(() => {
    showSuggestions = false;
  }, 150);
}
</script>

<div class="members-panel">
  <div class="panel-header">
    <span class="panel-title">Members</span>
    <span class="member-count">{conversation.participants.length}</span>
  </div>
  <div class="panel-body">
    {#if isChannel}
      <div class="invite-section">
        <div class="invite-input-wrap">
          <input
            type="text"
            bind:value={inviteQuery}
            placeholder="Invite a mind..."
            class="invite-input"
            onfocus={handleInputFocus}
            onblur={handleInputBlur}
          />
          {#if showSuggestions && suggestions.length > 0}
            <div class="suggestions">
              {#each suggestions as mind}
                <button class="suggestion-row" onmousedown={() => handleInvite(mind.name)}>
                  <span
                    class="status-dot"
                    class:iridescent={activeMinds.has(mind.name)}
                    style:background={activeMinds.has(mind.name) ? undefined : mindDotColor(mind)}
                  ></span>
                  <span class="suggestion-name">{mind.name}</span>
                  <StatusBadge status={getDisplayStatus(mind)} />
                </button>
              {/each}
            </div>
          {/if}
        </div>
        {#if inviteError}
          <div class="invite-error">{inviteError}</div>
        {/if}
      </div>
    {/if}
    {#if mindParticipants.length > 0}
      <div class="section-title">Minds</div>
      {#each mindParticipants as { participant, mind }}
        {#if mind}
          <button class="member-row clickable" onclick={() => onOpenMind(mind)}>
            <span
              class="status-dot"
              class:iridescent={activeMinds.has(mind.name)}
              style:background={activeMinds.has(mind.name) ? undefined : mindDotColor(mind)}
            ></span>
            <span class="member-name">{participant.username}</span>
            <StatusBadge status={getDisplayStatus(mind)} />
          </button>
        {:else}
          <div class="member-row">
            <span class="status-dot" style:background="var(--text-2)"></span>
            <span class="member-name">{participant.username}</span>
          </div>
        {/if}
      {/each}
    {/if}
    {#if userParticipants.length > 0}
      <div class="section-title">Users</div>
      {#each userParticipants as participant}
        <div class="member-row">
          <span class="member-name">{participant.username}</span>
        </div>
      {/each}
    {/if}
  </div>
</div>

<style>
  .members-panel {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: var(--bg-1);
    border-left: 1px solid var(--border);
    width: 280px;
    flex-shrink: 0;
    overflow: hidden;
  }

  .panel-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px 16px;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }

  .panel-title {
    font-size: 13px;
    font-weight: 600;
    color: var(--text-0);
  }

  .member-count {
    font-size: 11px;
    color: var(--text-2);
  }

  .panel-body {
    flex: 1;
    overflow: auto;
    padding: 12px 0;
  }

  .invite-section {
    padding: 0 12px 8px;
    border-bottom: 1px solid var(--border);
    margin-bottom: 4px;
  }

  .invite-input-wrap {
    position: relative;
  }

  .invite-input {
    width: 100%;
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 6px 10px;
    color: var(--text-0);
    font-size: 12px;
    font-family: var(--mono);
    outline: none;
    box-sizing: border-box;
  }

  .invite-input:focus {
    border-color: var(--border-bright);
  }

  .suggestions {
    position: absolute;
    top: 100%;
    left: 0;
    right: 0;
    background: var(--bg-1);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    margin-top: 4px;
    max-height: 200px;
    overflow: auto;
    z-index: 10;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
  }

  .suggestion-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    width: 100%;
    background: none;
    border: none;
    text-align: left;
    font-size: 12px;
    color: var(--text-1);
    cursor: pointer;
  }

  .suggestion-row:hover {
    background: var(--bg-2);
  }

  .suggestion-name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 500;
    color: var(--text-0);
  }

  .invite-error {
    color: var(--red);
    font-size: 11px;
    padding: 4px 0 0;
  }

  .section-title {
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-2);
    padding: 8px 16px 4px;
  }

  .member-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 16px;
    font-size: 13px;
    color: var(--text-1);
    width: 100%;
    background: none;
    border: none;
    text-align: left;
  }

  .member-row.clickable {
    cursor: pointer;
  }

  .member-row.clickable:hover {
    background: var(--bg-2);
  }

  .member-name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 500;
    color: var(--text-0);
  }

  .status-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .status-dot.iridescent {
    animation: iridescent 3s ease-in-out infinite;
  }

  @keyframes iridescent {
    0%   { background: #4ade80; }
    16%  { background: #60a5fa; }
    33%  { background: #c084fc; }
    50%  { background: #f472b6; }
    66%  { background: #fbbf24; }
    83%  { background: #34d399; }
    100% { background: #4ade80; }
  }
</style>
