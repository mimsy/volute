<script lang="ts">
import type { Snippet } from "svelte";

let {
  label,
  children,
}: {
  label: string;
  children: Snippet;
} = $props();
</script>

<div class="setting-row">
  <span class="setting-label">{label}</span>
  <div class="setting-control">
    {@render children()}
  </div>
</div>

<style>
  .setting-row {
    display: flex;
    align-items: center;
    padding: 4px 0;
  }

  .setting-label {
    width: 100px;
    flex-shrink: 0;
    font-size: 14px;
    color: var(--text-1);
  }

  .setting-control {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 6px;
  }
</style>
