<script lang="ts">
let {
  tabs,
  active,
  onchange,
}: {
  tabs: string[];
  active: string;
  onchange: (tab: string) => void;
} = $props();
</script>

<div class="tab-bar">
  {#each tabs as t}
    <button class="tab" class:active={t === active} onclick={() => onchange(t)}>{t}</button>
  {/each}
</div>

<style>
  .tab-bar {
    display: flex;
  }

  .tab {
    padding: 10px 16px;
    background: transparent;
    color: var(--text-2);
    font-size: 12px;
    font-weight: 500;
    border-bottom: 2px solid transparent;
    transition: all 0.15s;
    margin-bottom: -1px;
  }

  .tab.active {
    color: var(--accent);
    border-bottom-color: var(--accent);
  }
</style>
