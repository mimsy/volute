<script lang="ts">
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
  <select class="input time-select" value={hour} onchange={handleHourChange}>
    {#each HOURS as h}<option value={h}>{fmtHour(h)}</option>{/each}
  </select>
  <span class="time-sep">:</span>
  <select class="input time-select narrow" value={minute} onchange={handleMinuteChange}>
    {#each MINUTES as m}<option value={m}>{String(m).padStart(2, "0")}</option>{/each}
  </select>
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

  .input {
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 4px 8px;
    font-size: 13px;
    font-family: inherit;
    color: var(--text-0);
  }

  .input:focus {
    border-color: var(--accent);
    outline: none;
  }

  .time-select {
    width: auto;
  }

  .time-select.narrow {
    width: 55px;
  }
</style>
