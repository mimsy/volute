<script lang="ts">
let { message }: { message: string } = $props();
</script>

<div class="empty">{message}</div>

<style>
  .empty {
    color: var(--text-2);
    padding: 12px;
    text-align: center;
    font-size: 14px;
  }
</style>
