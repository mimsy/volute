<script lang="ts">
import type { Mind } from "@volute/api";
import { startMind } from "../../lib/client";
import { chatStatus } from "./chat-status";

let { mind, isAdmin }: { mind: Mind | undefined; isAdmin: boolean } = $props();

let starting = $state(false);
let startError = $state("");

let status = $derived(chatStatus(mind, isAdmin));

async function handleStart() {
  if (!mind || starting) return;
  starting = true;
  startError = "";
  try {
    await startMind(mind.name);
    // Keep the button disabled in its "Starting…" state — the mind_started
    // activity event refreshes data.minds via SSE, which flips this bar to
    // "waking up" and then removes it. Re-enabling immediately would invite a
    // second click and a false "Mind already running" error.
  } catch (e) {
    startError = e instanceof Error ? e.message : "Failed to start";
    starting = false;
  }
}
</script>

{#if status}
  <div class="status-bar {status.kind}" title={status.detail}>
    <span class="text">{status.text}</span>
    {#if status.showStart}
      <button class="start-btn" onclick={handleStart} disabled={starting}>
        {starting ? "Starting…" : "Start"}
      </button>
    {/if}
    {#if startError}
      <span class="start-error">{startError}</span>
    {/if}
  </div>
{/if}

<style>
  .status-bar {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    padding: 6px 12px;
    font-size: 12px;
    flex-shrink: 0;
    border-top: 1px solid var(--border);
    color: var(--text-2);
  }

  .status-bar.sleeping {
    color: var(--blue);
  }

  .status-bar.starting {
    color: var(--yellow);
  }

  .status-bar.error {
    color: var(--red);
  }

  .start-btn {
    padding: 2px 10px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--muted-bg);
    color: var(--text-0);
    font-size: 12px;
    cursor: pointer;
  }

  .start-btn:hover:not(:disabled) {
    background: var(--bg-2);
  }

  .start-btn:disabled {
    opacity: 0.6;
    cursor: default;
  }

  .start-error {
    color: var(--red);
  }
</style>
