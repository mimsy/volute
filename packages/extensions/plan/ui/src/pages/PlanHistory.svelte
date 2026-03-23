<script lang="ts">
import { Button, EmptyState, ErrorMessage, PageShell, SectionHeader } from "@volute/ui";
import { onMount } from "svelte";
import { type ApiPlan, fetchPlans } from "../lib/api";

let { onBack }: { onBack: () => void } = $props();

let plans = $state<ApiPlan[]>([]);
let loading = $state(true);
let error = $state("");

async function load() {
  try {
    plans = await fetchPlans({ limit: 50 });
    error = "";
  } catch (e) {
    error = e instanceof Error ? e.message : "Failed to load plans";
  } finally {
    loading = false;
  }
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString();
}

onMount(() => {
  load();
});
</script>

<PageShell>
  <SectionHeader title="Plan History">
    {#snippet action()}
      <Button onclick={onBack}>&larr; Current</Button>
    {/snippet}
  </SectionHeader>

  <ErrorMessage message={error} />

  {#if loading}
    <EmptyState message="Loading..." />
  {:else if plans.length === 0}
    <EmptyState message="No plans yet." />
  {:else}
    <div class="plans-list">
      {#each plans as plan (plan.id)}
        <div class="plan-row" class:active={plan.status === "active"}>
          <div class="plan-info">
            <span class="plan-title">{plan.title}</span>
            <span class="badge {plan.status}">{plan.status}</span>
          </div>
          <div class="plan-meta">
            {plan.set_by_display_name || plan.set_by_username} &middot; {formatDate(plan.created_at)}
          </div>
        </div>
      {/each}
    </div>
  {/if}
</PageShell>

<style>
  .plans-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .plan-row {
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 12px 16px;
  }

  .plan-row.active {
    border-color: var(--accent-border);
  }

  .plan-info {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 4px;
  }

  .plan-title {
    font-size: 14px;
    font-weight: 500;
    color: var(--text-0);
  }

  .badge {
    font-size: 10px;
    padding: 2px 6px;
    border-radius: var(--radius);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    font-weight: 500;
  }

  .badge.active {
    background: var(--accent-dim);
    color: var(--accent);
  }

  .badge.completed {
    background: var(--green-dim, var(--bg-3));
    color: var(--green, var(--text-2));
  }

  .badge.archived {
    background: var(--bg-3);
    color: var(--text-2);
  }

  .plan-meta {
    font-size: 12px;
    color: var(--text-2);
  }
</style>
