<script lang="ts">
import { Button, EmptyState, ErrorMessage, PageShell, SectionHeader } from "@volute/ui";
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

<PageShell>
  <SectionHeader title="System Plan">
    {#snippet action()}
      <Button onclick={onViewHistory}>History</Button>
    {/snippet}
  </SectionHeader>

  <ErrorMessage message={error} />

  {#if loading}
    <EmptyState message="Loading..." />
  {:else if !plan}
    <div class="empty">
      <EmptyState message="No active plan." />
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
      <SectionHeader title="Progress" />
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
      <EmptyState message="No progress logged yet." />
    {/if}
  {/if}
</PageShell>

<style>
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

  .empty {
    text-align: center;
  }

  .hint {
    color: var(--text-2);
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
