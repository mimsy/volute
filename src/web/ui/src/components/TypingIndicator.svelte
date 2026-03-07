<script lang="ts">
let { names }: { names: string[] } = $props();
</script>

{#if names.length > 0}
  <div class="typing">
    {names.length === 1
      ? `${names[0]} is typing...`
      : `${names.join(", ")} are typing...`}
  </div>
{/if}

<style>
  .typing {
    padding: 4px 0;
    font-size: 12px;
    color: var(--text-2);
    animation: pulse 1.5s ease infinite;
  }
</style>
