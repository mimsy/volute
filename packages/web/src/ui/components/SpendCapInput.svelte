<script lang="ts">
import { Input, Select } from "@volute/ui";
import { formatPeriod, parsePositiveInt, resolveCapEdit } from "../lib/spend-format";

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

// `bind:value` on a number input yields a number once anything is typed, so these hold
// whatever the field currently is and are read through parseCap*.
let amountText: string | number = $state("");
let period = $state(DEFAULT_PERIOD);
let custom = $state(false);
let customText: string | number = $state("");
// Declared above the effect that clears it: `$effect.pre` runs during init, so a `let`
// below would still be in its temporal dead zone and throw.
let error = $state("");

// Seeded from the props and re-synced when the caller reloads its config (autosave
// refetches after each save). `pre` so the first paint already shows the saved cap.
$effect.pre(() => {
  amountText = amount != null ? String(amount) : "";
  const p = periodMinutes ?? DEFAULT_PERIOD;
  period = p;
  custom = periodMinutes != null && !PRESETS.includes(periodMinutes);
  customText = periodMinutes != null ? String(periodMinutes) : "";
  error = "";
});

/**
 * Save what the two fields resolve to — or refuse and say why.
 *
 * Refusing matters more than it looks: "no cap" travels as null, and a 0 would parse to
 * null too, so accepting a 0 would remove the cap of a host who typed it meaning the
 * opposite. Nothing is emitted unless it is a value they actually asked for.
 */
function emit() {
  const result = resolveCapEdit({ amount: amountText, custom, period, customPeriod: customText });
  if (!result.ok) {
    error = result.error;
    return;
  }
  error = "";
  onsave(result.amount, result.periodMinutes);
}

function onPeriodChange(e: Event) {
  const raw = (e.currentTarget as HTMLSelectElement).value;
  if (raw === "custom") {
    custom = true;
    if (parsePositiveInt(customText) == null) customText = String(period);
    return;
  }
  custom = false;
  period = Number(raw);
  emit();
}
</script>

<span class="cap-field">
<span class="cap-input">
  <span class="dollar">$</span>
  <Input
    type="number"
    width="80px"
    min="0.01"
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
{#if error}
  <span class="cap-error">{error}</span>
{/if}
</span>

<style>
  .cap-field {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .cap-error {
    font-size: 11px;
    color: var(--red);
  }

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
