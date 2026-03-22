<script lang="ts">
import type { Snippet } from "svelte";

let {
  padding = "24px",
  children,
}: {
  padding?: string;
  children: Snippet;
} = $props();
</script>

<div class="page-shell" style:padding={padding}>
  {@render children()}
</div>

<style>
  .page-shell {
    max-width: 100%;
    min-height: 100%;
    animation: fadeIn 0.2s ease both;
  }
</style>
