<script lang="ts">
import type { ConversationWithParticipants, Mind } from "@volute/api";
import { mindDotColor } from "../lib/format";
import { activeMinds, onlineBrains } from "../lib/stores.svelte";
import InviteModal from "./modals/InviteModal.svelte";
import ProfileHoverCard from "./ProfileHoverCard.svelte";
import Icon from "./ui/Icon.svelte";

let {
  conversation,
  minds,
  typingNames = [],
  onOpenMind,
  onClose,
}: {
  conversation: ConversationWithParticipants;
  minds: Mind[];
  typingNames?: string[];
  onOpenMind: (mind: Mind) => void;
  onClose?: () => void;
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
    <div class="header-actions">
      {#if isChannel}
        <button class="header-action-btn" onclick={() => showInvite = true} title="Invite">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M8 3v10M3 8h10"/></svg>
        </button>
      {/if}
      {#if onClose}
        <button class="header-action-btn" onclick={onClose} title="Close">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>
        </button>
      {/if}
    </div>
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
              <Icon kind="mind" class="type-icon" />
            </button>
          {/snippet}
        </ProfileHoverCard>
      {:else}
        <div class="member-row">
          <span class="status-dot" style:background="var(--text-2)"></span>
          <span class="member-name">{participant.username}</span>
          <Icon kind="mind" class="type-icon" />
        </div>
      {/if}
    {/each}
    {#each userParticipants as participant}
      <ProfileHoverCard profile={{
        name: participant.username,
        displayName: participant.displayName,
        description: participant.description,
        avatarUrl: participant.avatar ? `/api/auth/avatars/${encodeURIComponent(participant.avatar)}` : null,
        userType: participant.userType,
      }}>
        {#snippet children()}
          <div class="member-row">
            {#if participant.userType === "system"}
              <span
                class="status-dot"
                style:background="var(--text-0)"
              ></span>
            {:else}
              <span
                class="status-dot"
                class:iridescent={isBrainIridescent(participant.username)}
                style:background={brainDotColor(participant.username)}
              ></span>
            {/if}
            <span class="member-name">
              {participant.displayName ?? participant.username}
            </span>
            <Icon kind={participant.userType === "system" ? "spiral" : "brain"} class="type-icon" />
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

  .header-actions {
    display: flex;
    align-items: center;
    gap: 4px;
    margin-left: auto;
  }

  .header-action-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    background: none;
    border: none;
    color: var(--text-2);
    padding: 0;
    cursor: pointer;
    border-radius: var(--radius);
    transition: color 0.1s, background 0.1s;
  }

  .header-action-btn svg {
    width: 14px;
    height: 14px;
  }

  .header-action-btn:hover {
    color: var(--text-0);
    background: var(--bg-2);
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

  .member-row :global(.type-icon) {
    width: 15px;
    height: 15px;
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
