<script lang="ts">
import type { Snippet } from "svelte";

let {
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: string;
  action?: Snippet;
} = $props();
</script>

<div class="section-header">
  <div class="section-titles">
    <span class="section-title">{title}</span>
    {#if subtitle}
      <span class="section-subtitle">{subtitle}</span>
    {/if}
  </div>
  {#if action}
    {@render action()}
  {/if}
</div>

<style>
  .section-header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 8px;
  }

  .section-titles {
    display: flex;
    align-items: baseline;
    gap: 8px;
  }

  .section-title {
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-2);
  }

  .section-subtitle {
    font-size: 12px;
    color: var(--text-2);
  }
</style>
