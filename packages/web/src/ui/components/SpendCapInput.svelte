<script lang="ts">
import { Input, Select } from "@volute/ui";
import { formatPeriod } from "../lib/spend-format";

/**
 * A spend cap as the sentence it is — `$ 2.00 per day` — rather than two bare numbers.
 *
 * The period is a dollar figure's other half: "$2.00" alone means nothing, and a raw
 * minutes box makes a host do arithmetic to find out what they just agreed to.
 */
let {
  amount,
  periodMinutes,
  onsave,
  disabled = false,
}: {
  amount: number | null;
  periodMinutes: number | null;
  /** Called when either half changes. A null amount means no cap. */
  onsave: (amount: number | null, periodMinutes: number | null) => void;
  disabled?: boolean;
} = $props();

const PRESETS = [60, 360, 720, 1440, 10080];
const DEFAULT_PERIOD = 1440;

let amountText = $state("");
let period = $state(DEFAULT_PERIOD);
let custom = $state(false);
let customText = $state("");

// Seeded from the props and re-synced when the caller reloads its config (autosave
// refetches after each save). `pre` so the first paint already shows the saved cap.
$effect.pre(() => {
  amountText = amount != null ? String(amount) : "";
  const p = periodMinutes ?? DEFAULT_PERIOD;
  period = p;
  custom = periodMinutes != null && !PRESETS.includes(periodMinutes);
  customText = periodMinutes != null ? String(periodMinutes) : "";
});

function parseAmount(): number | null {
  const t = amountText.trim();
  if (!t) return null;
  const n = Number.parseFloat(t);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function currentPeriod(): number | null {
  if (!custom) return period;
  const n = Number.parseInt(customText.trim(), 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function emit() {
  const value = parseAmount();
  // A cap with no amount has no period to speak of; clearing both is how "no cap" reads.
  onsave(value, value == null ? null : (currentPeriod() ?? DEFAULT_PERIOD));
}

function onPeriodChange(e: Event) {
  const raw = (e.currentTarget as HTMLSelectElement).value;
  if (raw === "custom") {
    custom = true;
    if (!customText) customText = String(period);
    return;
  }
  custom = false;
  period = Number(raw);
  emit();
}
</script>

<span class="cap-input">
  <span class="dollar">$</span>
  <Input
    type="number"
    width="80px"
    min="0"
    step="0.01"
    bind:value={amountText}
    onblur={emit}
    placeholder="no cap"
    {disabled}
  />
  <span class="per">per</span>
  <Select value={custom ? "custom" : String(period)} onchange={onPeriodChange} {disabled}>
    {#each PRESETS as p (p)}
      <option value={String(p)}>{formatPeriod(p)}</option>
    {/each}
    <option value="custom">custom…</option>
  </Select>
  {#if custom}
    <Input
      type="number"
      width="70px"
      min="1"
      step="1"
      bind:value={customText}
      onblur={emit}
      placeholder="min"
      {disabled}
    />
    <span class="per">min</span>
  {/if}
</span>

<style>
  .cap-input {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }

  .dollar,
  .per {
    font-size: 13px;
    color: var(--text-2);
  }
</style>
