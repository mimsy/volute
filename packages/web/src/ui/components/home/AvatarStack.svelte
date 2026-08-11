<script lang="ts">
import type { Participant } from "@volute/api";
import { isMind } from "@volute/api/user-type";

type AvatarParticipant = Pick<Participant, "username" | "userType" | "displayName" | "avatar">;

let {
  participants,
  max = 4,
}: {
  participants: AvatarParticipant[];
  max?: number;
} = $props();

let shown = $derived(participants.slice(0, max));
let overflow = $derived(Math.max(0, participants.length - max));

function avatarUrl(p: AvatarParticipant): string | null {
  if (!p.avatar) return null;
  return isMind(p)
    ? `/api/v1/minds/${encodeURIComponent(p.username)}/avatar`
    : `/api/v1/auth/avatars/${encodeURIComponent(p.avatar)}`;
}

function initial(p: AvatarParticipant): string {
  return (p.displayName ?? p.username ?? "?").charAt(0).toUpperCase();
}
</script>

<div class="avatar-stack">
  {#each shown as p (p.username)}
    {@const url = avatarUrl(p)}
    <span class="avatar" title={p.displayName ?? p.username}>
      {#if url}
        <img src={url} alt="" />
      {:else}
        <span class="initial">{initial(p)}</span>
      {/if}
    </span>
  {/each}
  {#if overflow > 0}
    <span class="avatar more">+{overflow}</span>
  {/if}
</div>

<style>
  .avatar-stack {
    display: flex;
    align-items: center;
  }

  .avatar {
    width: 20px;
    height: 20px;
    border-radius: 50%;
    overflow: hidden;
    border: 1.5px solid var(--bg-0);
    background: var(--bg-2);
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    margin-left: -6px;
  }

  .avatar:first-child {
    margin-left: 0;
  }

  .avatar img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .initial {
    font-size: 10px;
    font-weight: 600;
    color: var(--text-1);
  }

  .more {
    font-size: 9px;
    font-weight: 600;
    color: var(--text-2);
  }
</style>
