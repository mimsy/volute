<script lang="ts">
import type { AvailableUser, ConversationWithParticipants, Mind } from "@volute/api";
import { fetchAvailableUsers, inviteToChannel } from "../lib/client";
import { mindDotColor } from "../lib/format";
import { activeMinds, onlineBrains, reconnectActivity } from "../lib/stores.svelte";
import ProfileHoverCard from "./ProfileHoverCard.svelte";

let {
  conversation,
  minds,
  typingNames = [],
  onOpenMind,
}: {
  conversation: ConversationWithParticipants;
  minds: Mind[];
  typingNames?: string[];
  onOpenMind: (mind: Mind) => void;
} = $props();

let mindsByName = $derived(new Map(minds.map((m) => [m.name, m])));

let typingSet = $derived(new Set(typingNames));

let mindParticipants = $derived(
  conversation.participants
    .filter((p) => p.userType === "mind")
    .map((p) => ({ participant: p, mind: mindsByName.get(p.username) })),
);

let userParticipants = $derived(conversation.participants.filter((p) => p.userType !== "mind"));

// Invite state (channels only)
let isChannel = $derived(conversation.type === "channel" && !!conversation.name);
let showInvite = $state(false);
let inviteQuery = $state("");
let inviteError = $state("");
let inviting = $state(false);
let allUsers = $state<AvailableUser[]>([]);

let memberNames = $derived(new Set(conversation.participants.map((p) => p.username)));

let suggestions = $derived.by(() => {
  const nonMembers = allUsers.filter((u) => !memberNames.has(u.username));
  if (!inviteQuery.trim()) return nonMembers;
  const q = inviteQuery.toLowerCase();
  return nonMembers.filter(
    (u) =>
      u.username.toLowerCase().includes(q) ||
      (u.display_name && u.display_name.toLowerCase().includes(q)),
  );
});

function openInvite() {
  showInvite = true;
  inviteQuery = "";
  inviteError = "";
  fetchAvailableUsers().then((users) => {
    allUsers = users;
  });
}

function closeInvite() {
  setTimeout(() => {
    showInvite = false;
  }, 150);
}

async function handleInvite(username: string) {
  if (!conversation.name || inviting) return;
  inviting = true;
  inviteError = "";
  try {
    await inviteToChannel(conversation.name, username);
    inviteQuery = "";
    showInvite = false;
    reconnectActivity();
  } catch (err) {
    inviteError = err instanceof Error ? err.message : "Failed to invite";
  } finally {
    inviting = false;
  }
}

function brainDotColor(username: string): string | undefined {
  if (typingSet.has(username)) return undefined; // iridescent
  if (onlineBrains.has(username)) return "var(--text-0)";
  return "var(--text-2)";
}

function isBrainIridescent(username: string): boolean {
  return typingSet.has(username);
}

function inviteeDotColor(user: AvailableUser): string {
  if (user.user_type === "mind") {
    const mind = mindsByName.get(user.username);
    if (mind && activeMinds.has(mind.name)) return "";
    if (mind) return mindDotColor(mind);
    return "var(--text-2)";
  }
  if (onlineBrains.has(user.username)) return "var(--text-0)";
  return "var(--text-2)";
}

function isInviteeIridescent(user: AvailableUser): boolean {
  return user.user_type === "mind" && activeMinds.has(user.username);
}
</script>

<div class="members-panel">
  <div class="panel-header">
    <span class="panel-title">Members</span>
    <span class="member-count">{conversation.participants.length}</span>
    {#if isChannel}
      <button class="invite-btn" onclick={openInvite} title="Invite">+</button>
    {/if}
  </div>
  <div class="panel-body">
    {#if showInvite}
      <div class="invite-section">
        <div class="invite-input-wrap">
          <input
            type="text"
            bind:value={inviteQuery}
            placeholder="Invite..."
            class="invite-input"
            onblur={closeInvite}
          />
          {#if suggestions.length > 0}
            <div class="suggestions">
              {#each suggestions as user}
                <button class="suggestion-row" onmousedown={() => handleInvite(user.username)}>
                  <span
                    class="status-dot"
                    class:iridescent={isInviteeIridescent(user)}
                    style:background={isInviteeIridescent(user) ? undefined : inviteeDotColor(user)}
                  ></span>
                  <span class="suggestion-name">{user.display_name ?? user.username}</span>
                  {#if user.display_name && user.display_name !== user.username}
                    <span class="suggestion-username">@{user.username}</span>
                  {/if}
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
          <ProfileHoverCard profile={{
            name: mind.name,
            displayName: mind.displayName,
            description: mind.description,
            avatarUrl: mind.avatar ? `/api/minds/${encodeURIComponent(mind.name)}/avatar` : null,
            userType: "mind",
            created: mind.created,
          }}>
            {#snippet children()}
              <button class="member-row clickable" onclick={() => onOpenMind(mind)}>
                <span
                  class="status-dot"
                  class:iridescent={activeMinds.has(mind.name)}
                  style:background={activeMinds.has(mind.name) ? undefined : mindDotColor(mind)}
                ></span>
                <span class="member-name">{participant.displayName ?? participant.username}</span>
              </button>
            {/snippet}
          </ProfileHoverCard>
        {:else}
          <div class="member-row">
            <span class="status-dot" style:background="var(--text-2)"></span>
            <span class="member-name">{participant.username}</span>
          </div>
        {/if}
      {/each}
    {/if}
    {#if userParticipants.length > 0}
      <div class="section-title">Brains</div>
      {#each userParticipants as participant}
        <ProfileHoverCard profile={{
          name: participant.username,
          displayName: participant.displayName,
          description: participant.description,
          avatarUrl: participant.avatar ? `/api/auth/avatars/${encodeURIComponent(participant.avatar)}` : null,
          userType: "brain",
        }}>
          {#snippet children()}
            <div class="member-row">
              <span
                class="status-dot"
                class:iridescent={isBrainIridescent(participant.username)}
                style:background={brainDotColor(participant.username)}
              ></span>
              <span class="member-name">
                {participant.displayName ?? participant.username}
              </span>
            </div>
          {/snippet}
        </ProfileHoverCard>
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
    font-size: 14px;
    font-weight: 600;
    color: var(--text-0);
  }

  .member-count {
    font-size: 12px;
    color: var(--text-2);
    flex: 1;
  }

  .invite-btn {
    background: none;
    color: var(--text-2);
    font-size: 15px;
    padding: 2px 6px;
    border-radius: var(--radius);
    flex-shrink: 0;
  }

  .invite-btn:hover {
    color: var(--text-0);
    background: var(--bg-2);
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
    font-size: 13px;
    font-family: inherit;
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
    font-size: 13px;
    color: var(--text-1);
    cursor: pointer;
  }

  .suggestion-row:hover {
    background: var(--bg-2);
  }

  .suggestion-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 500;
    color: var(--text-0);
  }

  .suggestion-username {
    font-size: 12px;
    color: var(--text-2);
    margin-left: auto;
  }

  .invite-error {
    color: var(--red);
    font-size: 12px;
    padding: 4px 0 0;
  }

  .section-title {
    font-size: 11px;
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
    font-size: 14px;
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

  @media (max-width: 1024px) {
    .members-panel {
      width: min(280px, 100vw);
    }
  }
</style>
