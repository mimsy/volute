/**
 * Formatting and status logic for spend surfaces — pure, so it can be tested without a
 * browser and so every surface words the same situation the same way.
 *
 * The rule the whole file exists to serve: **a figure that is missing turns is a floor,
 * not a total.** Pricing fails open — an un-upgraded mind, a model missing from the
 * pinned catalog, a turn whose model couldn't be resolved all record $0 — so a plain
 * "$3.10" beside such a mind misleads by omission. Everything here that renders money
 * carries whether it is complete.
 */

export type SpendFigure = {
  /** The dollars we can account for. */
  text: string;
  /** True when turns went unpriced, so `text` understates the real spend. */
  floor: boolean;
  /** Why it's a floor, in words a host can act on. Empty when complete. */
  note: string;
};

/**
 * Dollars, with enough decimals to be worth reading.
 *
 * Sub-cent turns are common (a Haiku side-call), and rounding them to "$0.00" would
 * render a real cost as no cost, so small amounts keep four decimals instead.
 */
export function formatUsd(n: number): string {
  if (!Number.isFinite(n)) return "$0.00";
  const abs = Math.abs(n);
  // Below four decimals there is no digit left to show, so say "less than" rather than
  // rounding a real cost down to a zero that reads as free.
  if (abs > 0 && abs < 0.0001) return n > 0 ? "<$0.0001" : ">-$0.0001";
  if (abs > 0 && abs < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Token counts, abbreviated — exact numbers past a few thousand aren't read anyway. */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0";
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

/** A 0..1 ratio as a whole percent. */
export function formatPercent(ratio: number): string {
  if (!Number.isFinite(ratio)) return "0%";
  return `${Math.round(ratio * 100)}%`;
}

/**
 * How a spend figure should read, given how many of its turns went unpriced.
 *
 * `preUpgradeTurns` is split out from the rest because the two have different fixes: a
 * pre-upgrade mind is still emitting the old two-field usage shape and `volute mind
 * upgrade` resolves it; anything else went unpriced because the model has no rates.
 *
 * The word is never directional. Legacy claude turns omit cache tokens and undercount,
 * legacy codex turns re-report a session total every turn and overcount by 10-100x, so
 * "undercounted" would be a confident falsehood for half of any real fleet.
 */
export function spendFigure(usage: {
  costUsd: number;
  unpricedTurns: number;
  preUpgradeTurns: number;
}): SpendFigure {
  const text = formatUsd(usage.costUsd);
  if (usage.unpricedTurns <= 0) return { text, floor: false, note: "" };
  const other = usage.unpricedTurns - usage.preUpgradeTurns;
  const parts: string[] = [];
  if (usage.preUpgradeTurns > 0) {
    parts.push(
      `${usage.preUpgradeTurns} ${plural(usage.preUpgradeTurns, "turn")} unmetered (pre-upgrade — run \`volute mind upgrade\`)`,
    );
  }
  if (other > 0) {
    parts.push(`${other} ${plural(other, "turn")} with pricing unknown`);
  }
  return {
    text,
    floor: true,
    note: `At least ${text}. ${parts.join(", ")}; unpriced turns count nothing here and nothing against a cap.`,
  };
}

function plural(n: number, word: string): string {
  return n === 1 ? word : `${word}s`;
}

/** Short label for the badge that sits beside a floor figure. */
export function unpricedLabel(usage: { unpricedTurns: number; preUpgradeTurns: number }): string {
  if (usage.unpricedTurns <= 0) return "";
  if (usage.preUpgradeTurns >= usage.unpricedTurns) return "pre-upgrade";
  if (usage.preUpgradeTurns === 0) return "pricing unknown";
  return "partly unmetered";
}

/**
 * "in 3h 12m" / "in 4m" / "now" — how long until a moment.
 *
 * A cap always renders one of these: a cap whose end you can't see is a trapdoor rather
 * than a budget.
 */
export function formatUntil(atMs: number, now = Date.now()): string {
  const ms = atMs - now;
  if (!Number.isFinite(ms) || ms <= 0) return "now";
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `in ${Math.max(1, mins)}m`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  if (hours < 24) return rem > 0 ? `in ${hours}h ${rem}m` : `in ${hours}h`;
  const days = Math.floor(hours / 24);
  const hrem = hours % 24;
  return hrem > 0 ? `in ${days}d ${hrem}h` : `in ${days}d`;
}

/** A cap period in words: 1440 → "day", 60 → "hour", 90 → "90 min". */
export function formatPeriod(minutes: number): string {
  if (minutes === 60) return "hour";
  if (minutes === 1440) return "day";
  if (minutes === 10080) return "week";
  if (minutes % 1440 === 0) return `${minutes / 1440} days`;
  if (minutes % 60 === 0) return `${minutes / 60} hours`;
  return `${minutes} min`;
}

/**
 * Read a limit out of a number input's value, or null for "no limit".
 *
 * The value is deliberately typed `unknown`: Svelte's `bind:value` on an
 * `<input type="number">` hands back a **number**, not the string the field looked like,
 * and only an empty field stays a string. Code that assumed a string here (`.trim()`)
 * threw on the first keystroke and silently dropped the save.
 *
 * Zero and negatives are refused rather than passed through: every limit in this app
 * reads a 0 as "no limit", the opposite of what someone typing 0 means.
 */
export function parsePositiveNumber(value: unknown): number | null {
  const text = value == null ? "" : String(value).trim();
  if (!text) return null;
  const n = Number.parseFloat(text);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** The same, for a whole number (minutes, token counts, mind counts). */
export function parsePositiveInt(value: unknown): number | null {
  const text = value == null ? "" : String(value).trim();
  if (!text) return null;
  const n = Number.parseInt(text, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Where a percentage sits against a cap — drives colour and wording alike. */
export type CapLevel = "ok" | "warning" | "over";

export function capLevel(percentUsed: number): CapLevel {
  if (percentUsed >= 100) return "over";
  if (percentUsed >= 80) return "warning";
  return "ok";
}
