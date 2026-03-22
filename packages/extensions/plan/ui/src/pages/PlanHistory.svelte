<script lang="ts">
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

<div class="history-page">
  <div class="page-header">
    <button class="btn btn-back" onclick={onBack}>&larr; Current Plan</button>
    <h2 class="page-title">Plan History</h2>
  </div>

  {#if error}
    <div class="error">{error}</div>
  {/if}

  {#if loading}
    <div class="loading">Loading...</div>
  {:else if plans.length === 0}
    <div class="empty">No plans yet.</div>
  {:else}
    <div class="plans-list">
      {#each plans as plan (plan.id)}
        <div class="plan-row" class:active={plan.status === "active"}>
          <div class="plan-info">
            <span class="plan-title">{plan.title}</span>
            {#if plan.status === "active"}
              <span class="badge active">active</span>
            {:else if plan.status === "completed"}
              <span class="badge completed">completed</span>
            {:else}
              <span class="badge archived">archived</span>
            {/if}
          </div>
          <div class="plan-meta">
            {plan.set_by_display_name || plan.set_by_username} &middot; {formatDate(plan.created_at)}
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .history-page {
    max-width: 700px;
    margin: 0 auto;
  }

  .page-header {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 24px;
  }

  .page-title {
    font-family: var(--display);
    font-size: 22px;
    font-weight: 400;
    color: var(--text-0);
    margin: 0;
  }

  .btn {
    font-size: 13px;
    padding: 6px 14px;
    border-radius: var(--radius);
    cursor: pointer;
    border: 1px solid transparent;
  }

  .btn-back {
    background: var(--bg-3);
    color: var(--text-1);
    border-color: var(--border);
  }

  .btn-back:hover { border-color: var(--text-2); }

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

  .error {
    color: var(--red);
    font-size: 13px;
    margin-bottom: 16px;
  }

  .loading, .empty {
    color: var(--text-2);
    font-size: 13px;
    padding: 40px 0;
    text-align: center;
  }
</style>
