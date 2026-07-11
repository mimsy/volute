<script lang="ts">
import type { Variant } from "@volute/api";
import { Button, Input, SectionHeader, StatusBadge } from "@volute/ui";
import { createVariant, deleteVariant, fetchVariants, joinVariant } from "../../lib/client";
import { formatRelativeTime } from "../../lib/format";

let { name }: { name: string } = $props();

let variants = $state<Variant[]>([]);
let loading = $state(true);
let error = $state("");
// Partial-success notice: the merge landed but a follow-up step (restart /
// npm install) didn't. Kept separate from `error` so a degraded-but-merged
// mind doesn't read as a failed operation.
let warning = $state("");

// Create form
let newName = $state("");
let newSoul = $state("");
let creating = $state(false);

// Per-variant action state (holds the variant name being confirmed / acted on)
let confirmingJoin = $state<string | null>(null);
let confirmingDelete = $state<string | null>(null);
let busy = $state<string | null>(null);

async function load() {
  loading = true;
  try {
    variants = await fetchVariants(name);
    error = "";
  } catch (err) {
    console.error("Failed to load variants:", err);
    error = err instanceof Error ? err.message : "Failed to load variants";
  } finally {
    loading = false;
  }
}

$effect(() => {
  // Re-run when the parent mind changes.
  void name;
  load();
});

async function handleCreate(e: SubmitEvent) {
  e.preventDefault();
  const variantName = newName.trim();
  if (!variantName || creating) return;
  creating = true;
  error = "";
  warning = "";
  try {
    await createVariant(name, { name: variantName, soul: newSoul.trim() || undefined });
    newName = "";
    newSoul = "";
    await load();
  } catch (err) {
    console.error("Failed to create variant:", err);
    error = err instanceof Error ? err.message : "Failed to create variant";
  } finally {
    creating = false;
  }
}

async function handleJoin(variant: string) {
  busy = variant;
  error = "";
  warning = "";
  try {
    const res = await joinVariant(name, variant);
    confirmingJoin = null;
    // Reload first (the merged variant is now gone), then show any
    // partial-success notice so it isn't wiped by load().
    await load();
    if (res.warning) warning = res.warning;
  } catch (err) {
    console.error("Failed to join variant:", err);
    error = err instanceof Error ? err.message : "Failed to join variant";
  } finally {
    busy = null;
  }
}

async function handleDelete(variant: string) {
  busy = variant;
  error = "";
  warning = "";
  try {
    await deleteVariant(name, variant);
    confirmingDelete = null;
    await load();
  } catch (err) {
    console.error("Failed to delete variant:", err);
    error = err instanceof Error ? err.message : "Failed to delete variant";
  } finally {
    busy = null;
  }
}
</script>

<div class="variants">
  <SectionHeader
    title="Variants"
    subtitle="Isolated forks of this mind — split off an experiment, then join it back or discard it"
  />

  <form class="create-form" onsubmit={handleCreate}>
    <div class="create-row">
      <Input bind:value={newName} placeholder="variant name" width="180px" disabled={creating} />
      <Button variant="primary" type="submit" disabled={creating || !newName.trim()}>
        {creating ? "Splitting…" : "Split"}
      </Button>
    </div>
    <textarea
      class="soul-input"
      bind:value={newSoul}
      placeholder="Optional SOUL.md override for the variant"
      rows="2"
      disabled={creating}
    ></textarea>
  </form>

  {#if error}
    <div class="error">{error}</div>
  {/if}

  {#if warning}
    <div class="warning">Merge completed, but: {warning}</div>
  {/if}

  {#if loading}
    <div class="muted">Loading…</div>
  {:else if variants.length === 0}
    <div class="muted">No variants.</div>
  {:else}
    <ul class="variant-list">
      {#each variants as v (v.name)}
        <li class="variant-row">
          <div class="variant-main">
            <span class="variant-name">{v.name}</span>
            <StatusBadge status={v.status} />
          </div>
          <div class="variant-meta">
            <span class="branch" title="branch">{v.branch}</span>
            {#if v.port}<span class="port">:{v.port}</span>{/if}
            {#if v.created}<span class="created">{formatRelativeTime(v.created)}</span>{/if}
          </div>
          <div class="variant-actions">
            {#if confirmingJoin === v.name}
              <span class="confirm">
                Join back into {name} and restart?
                <button class="confirm-yes" onclick={() => handleJoin(v.name)} disabled={busy === v.name}>
                  {busy === v.name ? "joining…" : "join"}
                </button>
                <button class="confirm-no" onclick={() => (confirmingJoin = null)} disabled={busy === v.name}>cancel</button>
              </span>
            {:else if confirmingDelete === v.name}
              <span class="confirm">
                Discard this variant?
                <button class="confirm-yes danger" onclick={() => handleDelete(v.name)} disabled={busy === v.name}>
                  {busy === v.name ? "discarding…" : "discard"}
                </button>
                <button class="confirm-no" onclick={() => (confirmingDelete = null)} disabled={busy === v.name}>cancel</button>
              </span>
            {:else}
              <Button variant="secondary" onclick={() => (confirmingJoin = v.name)} disabled={!!busy}>Join</Button>
              <Button variant="text" onclick={() => (confirmingDelete = v.name)} disabled={!!busy}>Discard</Button>
            {/if}
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .variants {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .create-form {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .create-row {
    display: flex;
    gap: 8px;
    align-items: center;
  }

  .soul-input {
    width: 100%;
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    color: var(--text-0);
    font-family: inherit;
    font-size: 13px;
    padding: 8px 10px;
    resize: vertical;
  }

  .soul-input:focus {
    outline: none;
    border-color: var(--border-bright);
  }

  .error {
    color: var(--red);
    font-size: 13px;
    white-space: pre-wrap;
  }

  .warning {
    color: var(--yellow);
    background: var(--yellow-bg);
    border-radius: var(--radius);
    padding: 8px 10px;
    font-size: 13px;
    white-space: pre-wrap;
  }

  .muted {
    color: var(--text-2);
    font-size: 14px;
    padding: 8px 0;
  }

  .variant-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
  }

  .variant-row {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 12px 0;
    border-top: 1px solid var(--border);
  }

  .variant-main {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .variant-name {
    color: var(--text-0);
    font-weight: 500;
  }

  .variant-meta {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    color: var(--text-2);
  }

  .branch {
    font-family: var(--mono, monospace);
  }

  .variant-actions {
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

  .confirm-yes {
    color: var(--accent);
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
