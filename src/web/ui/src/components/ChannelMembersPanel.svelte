<script lang="ts">
import type { ConversationWithParticipants, Mind } from "@volute/api";
import { mindDotColor } from "../lib/format";
import { activeMinds, onlineBrains } from "../lib/stores.svelte";
import InviteModal from "./InviteModal.svelte";
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

let isChannel = $derived(conversation.type === "channel" && !!conversation.name);
let showInvite = $state(false);

function brainDotColor(username: string): string | undefined {
  if (typingSet.has(username)) return undefined; // iridescent
  if (onlineBrains.has(username)) return "var(--text-0)";
  return "var(--text-2)";
}

function isBrainIridescent(username: string): boolean {
  return typingSet.has(username);
}
</script>

<div class="members-panel">
  <div class="panel-header">
    <span class="panel-title">Members</span>
    <span class="member-count">{conversation.participants.length}</span>
    {#if isChannel}
      <button class="invite-btn" onclick={() => showInvite = true} title="Invite">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M8 3v10M3 8h10"/></svg>
      </button>
    {/if}
  </div>
  <div class="panel-body">
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
              <svg class="type-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="8" width="16" height="12" rx="2"/><circle cx="9" cy="14" r="1.5"/><circle cx="15" cy="14" r="1.5"/><line x1="12" y1="4" x2="12" y2="8"/><circle cx="12" cy="3" r="1"/></svg>
            </button>
          {/snippet}
        </ProfileHoverCard>
      {:else}
        <div class="member-row">
          <span class="status-dot" style:background="var(--text-2)"></span>
          <span class="member-name">{participant.username}</span>
          <svg class="type-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="8" width="16" height="12" rx="2"/><circle cx="9" cy="14" r="1.5"/><circle cx="15" cy="14" r="1.5"/><line x1="12" y1="4" x2="12" y2="8"/><circle cx="12" cy="3" r="1"/></svg>
        </div>
      {/if}
    {/each}
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
            <svg class="type-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><circle cx="9" cy="11" r="1.5"/><circle cx="15" cy="11" r="1.5"/><line x1="10" y1="16" x2="14" y2="16"/></svg>
          </div>
        {/snippet}
      </ProfileHoverCard>
    {/each}
  </div>
</div>

{#if showInvite && conversation.name}
  <InviteModal
    channelName={conversation.name}
    {minds}
    onClose={() => showInvite = false}
  />
{/if}

<style>
  .members-panel {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: var(--bg-1);
    width: 100%;
    overflow: hidden;
  }

  .panel-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px 40px 12px 16px;
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
    display: flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    background: none;
    color: var(--text-2);
    flex-shrink: 0;
    cursor: pointer;
    padding: 0;
    transition: color 0.1s;
  }

  .invite-btn svg {
    width: 14px;
    height: 14px;
  }

  .invite-btn:hover {
    color: var(--text-0);
  }

  .panel-body {
    flex: 1;
    overflow: auto;
    padding: 12px 0;
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

  .type-icon {
    width: 18px;
    height: 18px;
    flex-shrink: 0;
    color: var(--text-1);
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
      width: 100%;
    }
  }
</style>
