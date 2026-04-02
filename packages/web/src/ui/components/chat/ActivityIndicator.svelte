<script lang="ts">
import type { Mind } from "@volute/api";
import { activeMinds } from "../../lib/stores.svelte";

let {
  typingNames,
  mindParticipants,
  minds = [],
  onOpenMind,
}: {
  typingNames: string[];
  mindParticipants: string[];
  minds?: Mind[];
  onOpenMind?: (mind: Mind) => void;
} = $props();

let mindSet = $derived(new Set(mindParticipants));

let respondingMinds = $derived(typingNames.filter((n) => mindSet.has(n)));
let activeElsewhereMinds = $derived(
  mindParticipants.filter((n) => activeMinds.has(n) && !typingNames.includes(n)),
);
let typingHumans = $derived(typingNames.filter((n) => !mindSet.has(n)));

function handleMindClick(name: string) {
  const mind = minds.find((m) => m.name === name);
  if (mind && onOpenMind) onOpenMind(mind);
}
</script>

{#if respondingMinds.length > 0}
  <div class="indicator responding">
    {#each respondingMinds as name}
      <button class="mind-link" onclick={() => handleMindClick(name)}>
        <span class="dot iridescent"></span>
        {name}
      </button>
    {/each}
    <span>{respondingMinds.length === 1 ? "is" : "are"} responding</span>
  </div>
{/if}

{#if activeElsewhereMinds.length > 0}
  <div class="indicator active-elsewhere">
    {#each activeElsewhereMinds as name}
      <button class="mind-link" onclick={() => handleMindClick(name)}>
        <span class="dot iridescent"></span>
        {name}
      </button>
    {/each}
    <span>{activeElsewhereMinds.length === 1 ? "is" : "are"} active</span>
  </div>
{/if}

{#if typingHumans.length > 0}
  <div class="indicator typing">
    {typingHumans.join(", ")} {typingHumans.length === 1 ? "is" : "are"} typing...
  </div>
{/if}

<style>
  .indicator {
    padding: 4px 16px;
    font-size: 13px;
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .typing {
    color: var(--text-2);
    animation: pulse 1.5s ease infinite;
  }

  .responding {
    color: var(--text-2);
  }

  .active-elsewhere {
    color: var(--text-3);
  }

  .mind-link {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    background: none;
    border: none;
    padding: 0;
    font: inherit;
    color: inherit;
    cursor: pointer;
  }

  .mind-link:hover {
    color: var(--text-0);
  }

  .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    flex-shrink: 0;
    animation: iridescent 3s ease-in-out infinite;
  }
</style>
