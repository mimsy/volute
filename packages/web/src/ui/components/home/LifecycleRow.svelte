<script lang="ts">
import type { FeedLifecycleEvent } from "@volute/api";
import { formatRelativeTime } from "../../lib/format";
import { navigate } from "../../lib/navigate";
import { data as storeData } from "../../lib/stores.svelte";

let {
  event,
}: {
  event: FeedLifecycleEvent;
} = $props();

let label = $derived(storeData.minds.find((m) => m.name === event.mind)?.displayName ?? event.mind);

type Kind = "started" | "stopped" | "asleep" | "awake" | "error" | "backup";

let kind = $derived.by<Kind>(() => {
  switch (event.type) {
    case "mind_started":
      return "started";
    case "mind_stopped":
      return "stopped";
    case "mind_sleeping":
      return "asleep";
    case "mind_waking":
      return "awake";
    case "backup_failed":
      return "backup";
    default:
      return "error";
  }
});

let text = $derived.by(() => {
  switch (kind) {
    case "started":
      return `${label} started`;
    case "stopped":
      return `${label} stopped`;
    case "asleep":
      return `${label} went to sleep`;
    case "awake":
      return `${label} woke up`;
    case "backup":
      return "A scheduled backup failed";
    default:
      return `${label} hit an error`;
  }
});

let clickable = $derived(kind !== "backup");
</script>

<button
  class="lifecycle-row kind-{kind}"
  class:static={!clickable}
  disabled={!clickable}
  title={event.summary}
  onclick={() => clickable && navigate(`/minds/${event.mind}`)}
>
  <span class="dot" aria-hidden="true"></span>
  <span class="text">{text}</span>
  <span class="time">{formatRelativeTime(event.createdAt)}</span>
</button>

<style>
  .lifecycle-row {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 5px 10px;
    background: none;
    border: 1px solid transparent;
    border-radius: var(--radius);
    color: var(--text-2);
    font-size: 12px;
    cursor: pointer;
    text-align: left;
  }

  .lifecycle-row:not(.static):hover {
    background: var(--bg-1);
    color: var(--text-1);
  }

  .lifecycle-row.static {
    cursor: default;
  }

  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    flex-shrink: 0;
    background: var(--text-2);
  }

  .kind-started .dot {
    background: var(--green, var(--accent));
  }

  .kind-awake .dot {
    background: var(--accent);
  }

  .kind-asleep .dot {
    background: var(--blue);
  }

  .kind-error .dot,
  .kind-backup .dot {
    background: var(--red, #e5484d);
  }

  .text {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .time {
    flex-shrink: 0;
    font-size: 11px;
    color: var(--text-2);
  }
</style>
