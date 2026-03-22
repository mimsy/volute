<script lang="ts">
import type { Snippet } from "svelte";
import SectionHeader from "./SectionHeader.svelte";

let {
  title,
  subtitle,
  action,
  children,
}: {
  title?: string;
  subtitle?: string;
  action?: Snippet;
  children: Snippet;
} = $props();
</script>

<div class="section">
  {#if title}
    <SectionHeader {title} {subtitle} {action} />
  {/if}
  {@render children()}
</div>

<style>
  .section {
    margin-bottom: 24px;
  }
</style>
