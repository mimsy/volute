<script lang="ts">
import { EmptyState, ErrorMessage, PageShell, SectionHeader } from "@volute/ui";
import { onMount } from "svelte";
import { type ApiIntention, fetchBoard } from "./lib/api";

type Status = "active" | "fulfilled" | "released";
const STATUSES: Status[] = ["active", "fulfilled", "released"];

let intentions = $state<ApiIntention[]>([]);
let status = $state<Status>("active");
let loading = $state(true);
let error = $state("");

async function load() {
  loading = true;
  try {
    intentions = await fetchBoard({ status });
    error = "";
  } catch (e) {
    error = e instanceof Error ? e.message : "Failed to load intentions";
  } finally {
    loading = false;
  }
}

function selectStatus(next: Status) {
  status = next;
  load();
}

onMount(() => {
  load();
});
</script>

<PageShell>
  <SectionHeader title="Intentions">
    {#snippet action()}
      <div class="status-tabs">
        {#each STATUSES as s (s)}
          <button class:active={status === s} onclick={() => selectStatus(s)}>{s}</button>
        {/each}
      </div>
    {/snippet}
  </SectionHeader>

  <ErrorMessage message={error} />

  {#if loading}
    <EmptyState message="Loading..." />
  {:else if intentions.length === 0}
    <EmptyState message={`No ${status} intentions.`} />
  {:else}
    <div class="board">
      {#each intentions as intention (intention.id)}
        <div class="card">
          <div class="card-header">
            <span class="holder">{intention.mind_name}</span>
            <span class="age">held {intention.held_days} {intention.held_days === 1 ? "day" : "days"}</span>
          </div>
          <p class="content">{intention.content}</p>
          {#if intention.status === "active" && intention.overdue}
            <span class="badge overdue">review overdue</span>
          {:else if intention.status !== "active"}
            <span class="badge {intention.status}">{intention.status}</span>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</PageShell>

<style>
  .status-tabs {
    display: flex;
    gap: 4px;
  }

  .status-tabs button {
    background: transparent;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    color: var(--text-2);
    font-size: 12px;
    padding: 4px 10px;
    text-transform: capitalize;
    cursor: pointer;
  }

  .status-tabs button.active {
    background: var(--accent-dim);
    border-color: var(--accent-border);
    color: var(--accent);
  }

  .board {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
    gap: 12px;
  }

  .card {
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: 16px;
  }

  .card-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 8px;
  }

  .holder {
    font-size: 13px;
    font-weight: 500;
    color: var(--accent);
  }

  .age {
    font-size: 11px;
    color: var(--text-2);
  }

  .content {
    color: var(--text-0);
    font-size: 14px;
    line-height: 1.5;
    margin: 0 0 8px;
    white-space: pre-wrap;
  }

  .badge {
    display: inline-block;
    font-size: 10px;
    padding: 2px 6px;
    border-radius: var(--radius);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    font-weight: 500;
  }

  .badge.overdue {
    background: var(--yellow-dim, var(--bg-3));
    color: var(--yellow, var(--text-2));
  }

  .badge.fulfilled {
    background: var(--green-dim, var(--bg-3));
    color: var(--green, var(--text-2));
  }

  .badge.released {
    background: var(--bg-3);
    color: var(--text-2);
  }
</style>
