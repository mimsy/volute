<script lang="ts">
import { Button, SectionHeader } from "@volute/ui";
import {
  acceptPendingFile,
  fetchPendingFiles,
  type PendingFile,
  rejectPendingFile,
} from "../../lib/client";
import { formatRelativeTime } from "../../lib/format";

let { name }: { name: string } = $props();

let files = $state<PendingFile[]>([]);
let loading = $state(true);
let error = $state("");
// Per-file action state (holds the id being confirmed / acted on)
let confirmingReject = $state<string | null>(null);
let busy = $state<string | null>(null);

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

async function handleAccept(id: string) {
  busy = id;
  error = "";
  try {
    await acceptPendingFile(name, id);
    await load();
  } catch (err) {
    console.error("Failed to accept file:", err);
    error = err instanceof Error ? err.message : "Failed to accept file";
  } finally {
    busy = null;
  }
}

async function handleReject(id: string) {
  busy = id;
  error = "";
  try {
    await rejectPendingFile(name, id);
    confirmingReject = null;
    await load();
  } catch (err) {
    console.error("Failed to reject file:", err);
    error = err instanceof Error ? err.message : "Failed to reject file";
  } finally {
    busy = null;
  }
}
</script>

<div class="pending">
  <SectionHeader
    title="Incoming files"
    subtitle="Files sent to this mind awaiting review — accept to save into its home directory, or reject to discard"
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
          <div class="file-actions">
            {#if confirmingReject === f.id}
              <span class="confirm">
                Discard this file?
                <button class="confirm-yes danger" onclick={() => handleReject(f.id)} disabled={busy === f.id}>
                  {busy === f.id ? "rejecting…" : "reject"}
                </button>
                <button class="confirm-no" onclick={() => (confirmingReject = null)} disabled={busy === f.id}>cancel</button>
              </span>
            {:else}
              <Button variant="primary" onclick={() => handleAccept(f.id)} disabled={!!busy}>
                {busy === f.id ? "Accepting…" : "Accept"}
              </Button>
              <Button variant="text" onclick={() => (confirmingReject = f.id)} disabled={!!busy}>Reject</Button>
            {/if}
          </div>
        </li>
      {/each}
    </ul>
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

  .file-actions {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }

  .confirm {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
    color: var(--text-1);
  }

  .confirm-yes,
  .confirm-no {
    background: none;
    border: none;
    cursor: pointer;
    font-size: 13px;
    font-weight: 500;
    padding: 2px 4px;
  }

  .confirm-yes.danger {
    color: var(--red);
  }

  .confirm-no {
    color: var(--text-2);
  }

  .confirm-yes:disabled,
  .confirm-no:disabled {
    opacity: 0.5;
    cursor: default;
  }
</style>
