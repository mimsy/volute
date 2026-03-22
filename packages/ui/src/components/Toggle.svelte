<script lang="ts">
let {
  checked,
  onchange,
  label,
  disabled,
}: {
  checked: boolean;
  onchange: () => void;
  label?: string;
  disabled?: boolean;
} = $props();
</script>

<label class="toggle">
  <input type="checkbox" {checked} {onchange} {disabled} />
  {#if label}
    <span>{label}</span>
  {/if}
</label>

<style>
  .toggle {
    display: flex;
    align-items: center;
    gap: 6px;
    font-weight: 400;
    cursor: pointer;
    font-size: 13px;
    color: var(--text-1);
  }

  input[type="checkbox"] {
    accent-color: var(--accent);
  }

  .toggle:has(input:disabled) {
    opacity: 0.5;
    cursor: default;
  }
</style>
