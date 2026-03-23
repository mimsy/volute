<script lang="ts">
import { onMount } from "svelte";
import { type ApiPlan, fetchCurrentPlan } from "../lib/api";

let { onViewHistory }: { onViewHistory: () => void } = $props();

let plan = $state<ApiPlan | null>(null);
let loading = $state(true);
let error = $state("");

async function load() {
  try {
    plan = await fetchCurrentPlan();
    error = "";
  } catch (e) {
    error = e instanceof Error ? e.message : "Failed to load plan";
  } finally {
    loading = false;
  }
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString();
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

onMount(() => {
  load();
});
</script>

<div class="plan-page">
  <div class="page-header">
    <h2 class="page-title">System Plan</h2>
    <button class="btn btn-secondary" onclick={onViewHistory}>History</button>
  </div>

  {#if error}
    <div class="error">{error}</div>
  {/if}

  {#if loading}
    <div class="loading">Loading...</div>
  {:else if !plan}
    <div class="empty">
      <p>No active plan.</p>
      <p class="hint">The spirit can start a plan with <code>volute plan start "title" "description"</code></p>
    </div>
  {:else}
    <div class="plan-card">
      <h3 class="plan-title">{plan.title}</h3>
      {#if plan.description}
        <p class="plan-description">{plan.description}</p>
      {/if}
      <div class="plan-meta">
        Set by {plan.set_by_display_name || plan.set_by_username} &middot; {formatDate(plan.created_at)}
      </div>
    </div>

    {#if plan.logs && plan.logs.length > 0}
      <h3 class="section-title">Progress</h3>
      <div class="log-list">
        {#each plan.logs as log (log.id)}
          <div class="log-entry">
            <div class="log-header">
              <span class="log-mind">{log.mind_name}</span>
              <span class="log-time">{relativeTime(log.created_at)}</span>
            </div>
            <div class="log-content">{log.content}</div>
          </div>
        {/each}
      </div>
    {:else}
      <div class="empty-logs">No progress logged yet.</div>
    {/if}
  {/if}
</div>

<style>
  .plan-page {
    max-width: 700px;
    margin: 0 auto;
  }

  .page-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
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
    transition: opacity 0.15s;
  }

  .btn-secondary {
    background: var(--bg-3);
    color: var(--text-1);
    border-color: var(--border);
  }

  .btn-secondary:hover { border-color: var(--text-2); }

  .plan-card {
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: 20px;
    margin-bottom: 24px;
  }

  .plan-title {
    font-family: var(--display);
    font-size: 18px;
    font-weight: 500;
    color: var(--text-0);
    margin: 0 0 8px;
  }

  .plan-description {
    color: var(--text-1);
    font-size: 14px;
    line-height: 1.5;
    margin: 0 0 12px;
    white-space: pre-wrap;
  }

  .plan-meta {
    color: var(--text-2);
    font-size: 12px;
  }

  .section-title {
    font-family: var(--display);
    font-size: 15px;
    font-weight: 400;
    color: var(--text-1);
    margin: 0 0 12px;
  }

  .log-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .log-entry {
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 12px;
  }

  .log-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 4px;
  }

  .log-mind {
    font-size: 13px;
    font-weight: 500;
    color: var(--accent);
  }

  .log-time {
    font-size: 11px;
    color: var(--text-2);
  }

  .log-content {
    font-size: 13px;
    color: var(--text-1);
    line-height: 1.4;
  }

  .error {
    color: var(--red);
    font-size: 13px;
    margin-bottom: 16px;
  }

  .loading, .empty, .empty-logs {
    color: var(--text-2);
    font-size: 13px;
    padding: 40px 0;
    text-align: center;
  }

  .hint {
    font-size: 12px;
    margin-top: 8px;
  }

  .hint code {
    background: var(--bg-3);
    padding: 2px 6px;
    border-radius: var(--radius);
    font-size: 11px;
  }
</style>
