<script lang="ts">
import { SectionHeader } from "@volute/ui";
import { fetchPendingFiles, type PendingFile } from "../../lib/client";
import { formatRelativeTime } from "../../lib/format";

// Read-only by design: accepting or rejecting a file is the mind's decision
// (a consent gate) — this panel only provides visibility into the queue.

let { name }: { name: string } = $props();

let files = $state<PendingFile[]>([]);
let loading = $state(true);
let error = $state("");

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

async function load() {
  loading = true;
  try {
    files = await fetchPendingFiles(name);
    error = "";
  } catch (err) {
    console.error("Failed to load pending files:", err);
    error = err instanceof Error ? err.message : "Failed to load pending files";
  } finally {
    loading = false;
  }
}

$effect(() => {
  // Re-run when the mind changes.
  void name;
  load();
});
</script>

<div class="pending">
  <SectionHeader
    title="Incoming files"
    subtitle="Files sent to this mind, awaiting its review"
  />

  {#if error}
    <div class="error">{error}</div>
  {/if}

  {#if loading}
    <div class="muted">Loading…</div>
  {:else if files.length === 0}
    <div class="muted">No pending files.</div>
  {:else}
    <ul class="file-list">
      {#each files as f (f.id)}
        <li class="file-row">
          <div class="file-main">
            <span class="file-name">{f.filename}</span>
            <span class="file-size">{formatSize(f.size)}</span>
          </div>
          <div class="file-meta">
            <span class="sender">from {f.sender}</span>
            <span class="created">{formatRelativeTime(f.createdAt)}</span>
          </div>
        </li>
      {/each}
    </ul>
    <div class="hint">
      Accepting or rejecting a file is the mind's decision — it runs
      <code>volute chat accept/reject &lt;id&gt;</code> when it's ready.
    </div>
  {/if}
</div>

<style>
  .pending {
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

  .file-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
  }

  .file-row {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 12px 0;
    border-top: 1px solid var(--border);
  }

  .file-main {
    display: flex;
    align-items: baseline;
    gap: 8px;
  }

  .file-name {
    color: var(--text-0);
    font-weight: 500;
    font-family: var(--mono, monospace);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .file-size {
    font-size: 12px;
    color: var(--text-2);
    flex-shrink: 0;
  }

  .file-meta {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    color: var(--text-2);
  }

  .hint {
    color: var(--text-2);
    font-size: 12px;
  }

  .hint code {
    font-family: var(--mono, monospace);
    font-size: 11px;
  }
</style>
