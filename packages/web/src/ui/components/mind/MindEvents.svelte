<script lang="ts">
import { SectionHeader } from "@volute/ui";
import { fetchMindEvents, type MindEvent } from "../../lib/client";
import { formatRelativeTime } from "../../lib/format";

let { name }: { name: string } = $props();

let events = $state<MindEvent[]>([]);
let loading = $state(true);
let error = $state("");

async function load() {
  loading = true;
  try {
    const res = await fetchMindEvents(name);
    events = res.events;
    error = "";
  } catch (err) {
    console.error("Failed to load events:", err);
    error = err instanceof Error ? err.message : "Failed to load events";
  } finally {
    loading = false;
  }
}

$effect(() => {
  void name;
  load();
});
</script>

<div class="events">
  <SectionHeader
    title="Events"
    subtitle="System events from this mind's environment — schedule fires, wake summaries, lifecycle notices. Reflections are the mind's private closing thoughts."
  />

  {#if error}
    <div class="error">{error}</div>
  {/if}

  {#if loading}
    <div class="muted">Loading…</div>
  {:else if events.length === 0}
    <div class="muted">No events.</div>
  {:else}
    <ul class="event-list">
      {#each events as e (e.id)}
        <li class="event-row">
          <div class="event-head">
            <span class="event-label">{e.label}</span>
            {#if e.delivery === "next-turn"}<span class="badge">next-turn</span>{/if}
            {#if e.meta?.skipped}<span class="badge skipped">skipped</span>{/if}
            <span class="event-time">{formatRelativeTime(e.created_at)}</span>
          </div>
          <div class="event-body">{e.body}</div>
          {#if e.reflection}
            <div class="reflection">
              <span class="reflection-label">Reflection</span>
              <div class="reflection-body">{e.reflection}</div>
            </div>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .events {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .error {
    color: var(--red);
    font-size: 13px;
    white-space: pre-wrap;
  }

  .muted {
    color: var(--text-2);
    font-size: 14px;
    padding: 8px 0;
  }

  .event-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
  }

  .event-row {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 12px 0;
    border-top: 1px solid var(--border);
  }

  .event-head {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }

  .event-label {
    color: var(--text-0);
    font-weight: 500;
  }

  .badge {
    font-size: 11px;
    color: var(--text-2);
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 1px 6px;
  }

  .badge.skipped {
    color: var(--yellow);
  }

  .event-time {
    margin-left: auto;
    font-size: 12px;
    color: var(--text-2);
  }

  .event-body {
    color: var(--text-1);
    font-size: 13px;
    white-space: pre-wrap;
  }

  .reflection {
    border-left: 2px solid var(--border-bright);
    padding-left: 10px;
    margin-top: 2px;
  }

  .reflection-label {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-2);
  }

  .reflection-body {
    color: var(--text-1);
    font-size: 13px;
    font-style: italic;
    white-space: pre-wrap;
    margin-top: 2px;
  }
</style>
