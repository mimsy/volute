<script lang="ts">
import Select from "./Select.svelte";

let {
  hour = $bindable(),
  minute = $bindable(),
  onchange,
  label,
}: {
  hour: number;
  minute: number;
  onchange?: () => void;
  label?: string;
} = $props();

const HOURS = Array.from({ length: 24 }, (_, i) => i);
const MINUTES = [0, 15, 30, 45];

function fmtHour(h: number): string {
  const suffix = h >= 12 ? "pm" : "am";
  const h12 = h % 12 || 12;
  return `${h12}${suffix}`;
}

function handleHourChange(e: Event) {
  hour = +(e.target as HTMLSelectElement).value;
  onchange?.();
}

function handleMinuteChange(e: Event) {
  minute = +(e.target as HTMLSelectElement).value;
  onchange?.();
}
</script>

<div class="time-picker">
  {#if label}
    <span class="time-label">{label}</span>
  {/if}
  <Select class="time-select" value={hour} onchange={handleHourChange}>
    {#each HOURS as h}<option value={h}>{fmtHour(h)}</option>{/each}
  </Select>
  <span class="time-sep">:</span>
  <Select class="time-select narrow" value={minute} onchange={handleMinuteChange}>
    {#each MINUTES as m}<option value={m}>{String(m).padStart(2, "0")}</option>{/each}
  </Select>
</div>

<style>
  .time-picker {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 0;
  }

  .time-label {
    font-size: 13px;
    color: var(--text-2);
    width: 60px;
    flex-shrink: 0;
  }

  .time-sep {
    font-size: 13px;
    color: var(--text-2);
  }

  :global(.time-select) {
    width: auto;
  }

  :global(.time-select.narrow) {
    width: 55px;
  }
</style>
