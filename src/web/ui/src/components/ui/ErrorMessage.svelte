<script lang="ts">
let { message }: { message: string } = $props();
</script>

{#if message}
  <div class="error">{message}</div>
{/if}

<style>
  .error {
    color: var(--red);
    font-size: 13px;
    padding: 4px 0;
  }
</style>
