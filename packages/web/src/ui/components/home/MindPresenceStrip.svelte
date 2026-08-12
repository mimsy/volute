<script lang="ts">
import type { Mind } from "@volute/api";
import { navigate } from "../../lib/navigate";
import { activeMinds, data as storeData } from "../../lib/stores.svelte";

// Non-spirit minds only — the spirit runs the system and isn't a peer in the strip.
let minds = $derived(storeData.minds.filter((m) => (m.mindType ?? "mind") === "mind"));

type PresenceState = "active" | "idle" | "asleep" | "stopped";

function presence(mind: Mind): PresenceState {
  if (mind.status === "sleeping") return "asleep";
  if (mind.status === "stopped") return "stopped";
  return activeMinds.has(mind.name) ? "active" : "idle";
}

const STATE_LABEL: Record<PresenceState, string> = {
  active: "active",
  idle: "awake",
  asleep: "asleep",
  stopped: "stopped",
};

function avatarUrl(mind: Mind): string | null {
  return mind.avatar ? `/api/v1/minds/${encodeURIComponent(mind.name)}/avatar` : null;
}

function initial(mind: Mind): string {
  return (mind.displayName ?? mind.name).charAt(0).toUpperCase();
}
</script>

{#if minds.length > 0}
  <div class="presence-strip">
    {#each minds as mind (mind.name)}
      {@const state = presence(mind)}
      {@const url = avatarUrl(mind)}
      <button
        class="presence-item state-{state}"
        title="{mind.displayName ?? mind.name} · {STATE_LABEL[state]}"
        onclick={() => navigate(`/minds/${mind.name}`)}
      >
        <span class="avatar-wrap">
          {#if url}
            <img class="avatar" src={url} alt="" />
          {:else}
            <span class="avatar initial">{initial(mind)}</span>
          {/if}
          {#if state === "asleep"}
            <span class="badge moon" aria-hidden="true">
              <svg viewBox="0 0 16 16" fill="currentColor"><path d="M6 2a6 6 0 1 0 8 8A5 5 0 0 1 6 2z"/></svg>
            </span>
          {:else if state === "active"}
            <span class="badge dot" aria-hidden="true"></span>
          {/if}
        </span>
        <span class="name">{mind.displayName ?? mind.name}</span>
      </button>
    {/each}
  </div>
{/if}

<style>
  .presence-strip {
    display: flex;
    flex-wrap: wrap;
    gap: 14px;
    padding: 4px 0 16px;
  }

  .presence-item {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 5px;
    width: 52px;
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
    color: var(--text-2);
  }

  .presence-item:hover .name {
    color: var(--text-0);
  }

  .avatar-wrap {
    position: relative;
    width: 40px;
    height: 40px;
  }

  .avatar {
    width: 40px;
    height: 40px;
    border-radius: 50%;
    object-fit: cover;
    background: var(--bg-2);
    display: flex;
    align-items: center;
    justify-content: center;
    border: 1px solid var(--border);
  }

  .initial {
    font-size: 16px;
    font-weight: 600;
    color: var(--text-1);
  }

  .state-stopped .avatar {
    filter: grayscale(1);
    opacity: 0.5;
  }

  .state-asleep .avatar {
    opacity: 0.6;
  }

  .badge {
    position: absolute;
    right: -1px;
    bottom: -1px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
    border: 2px solid var(--bg-0);
  }

  .badge.dot {
    width: 11px;
    height: 11px;
    background: var(--accent);
  }

  .badge.moon {
    width: 14px;
    height: 14px;
    background: var(--bg-2);
    color: var(--text-2);
  }

  .badge.moon svg {
    width: 8px;
    height: 8px;
  }

  .name {
    font-size: 11px;
    max-width: 52px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
