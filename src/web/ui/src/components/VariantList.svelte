<script lang="ts">
import { fetchVariants, type Variant } from "../lib/api";
import StatusBadge from "./StatusBadge.svelte";

let { name }: { name: string } = $props();

let variants = $state<Variant[]>([]);
let error = $state("");

$effect(() => {
  fetchVariants(name)
    .then((v) => {
      variants = v;
    })
    .catch(() => {
      error = "Failed to load variants";
    });
});
</script>

{#if error}
  <div class="error">{error}</div>
{:else if variants.length === 0}
  <div class="empty">No variants.</div>
{:else}
  <div class="table-wrap">
    <table class="variant-table">
      <thead>
        <tr>
          <th>Name</th>
          <th>Branch</th>
          <th>Port</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        {#each variants as v}
          <tr class="variant-row">
            <td class="name-cell">{v.name}</td>
            <td class="branch-cell">{v.branch}</td>
            <td class="port-cell">{v.port || "-"}</td>
            <td><StatusBadge status={v.status} /></td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{/if}

<style>
  .error {
    color: var(--red);
    padding: 16px;
  }

  .empty {
    color: var(--text-2);
    padding: 24px;
    text-align: center;
  }

  .table-wrap {
    overflow: auto;
  }

  .variant-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
  }

  .variant-table th {
    text-align: left;
    color: var(--text-2);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    padding: 8px 12px;
    border-bottom: 1px solid var(--border);
    font-weight: 500;
  }

  .variant-row {
    animation: fadeIn 0.2s ease both;
  }

  .variant-row td {
    padding: 10px 12px;
    border-bottom: 1px solid var(--border);
  }

  .name-cell {
    color: var(--text-0);
    font-weight: 500;
  }

  .branch-cell {
    color: var(--text-1);
  }

  .port-cell {
    color: var(--text-2);
  }
</style>
