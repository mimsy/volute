<script lang="ts">
import type { ConversationWithParticipants, Mind } from "../lib/api";
import { getDisplayStatus, mindDotColor } from "../lib/format";
import { activeMinds } from "../lib/stores.svelte";
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
</script>

<div class="members-panel">
  <div class="panel-header">
    <span class="panel-title">Members</span>
    <span class="member-count">{conversation.participants.length}</span>
  </div>
  <div class="panel-body">
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
