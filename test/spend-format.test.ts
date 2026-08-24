import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { MindBudget, MindUsage, UsageReport } from "../packages/web/src/ui/lib/client.js";
import {
  capLevel,
  formatPercent,
  formatPeriod,
  formatTokens,
  formatUntil,
  formatUsd,
  parsePositiveInt,
  parsePositiveNumber,
  resolveCapEdit,
  spendFigure,
  unpricedLabel,
} from "../packages/web/src/ui/lib/spend-format.js";
import { spendStrip, usageScope } from "../packages/web/src/ui/lib/spend-status.js";

const NOW = Date.parse("2026-08-24T13:30:00Z");

describe("formatUsd", () => {
  it("shows cents", () => {
    assert.equal(formatUsd(0), "$0.00");
    assert.equal(formatUsd(3.1), "$3.10");
    assert.equal(formatUsd(12.345), "$12.35");
  });

  it("keeps sub-cent amounts visible rather than rounding a real cost to nothing", () => {
    assert.equal(formatUsd(0.0042), "$0.0042");
    assert.notEqual(formatUsd(0.004), "$0.00");
  });

  it("says less-than rather than showing a real cost as zero", () => {
    assert.equal(formatUsd(0.00001), "<$0.0001");
    assert.notEqual(formatUsd(0.00001), "$0.0000");
    assert.equal(formatUsd(0), "$0.00", "an actual zero is still a zero");
  });
});

describe("formatTokens", () => {
  it("abbreviates by magnitude", () => {
    assert.equal(formatTokens(812), "812");
    assert.equal(formatTokens(45_300), "45.3k");
    assert.equal(formatTokens(1_250_000), "1.3M");
    assert.equal(formatTokens(2_000_000_000), "2.0B");
  });
});

describe("formatPercent / capLevel", () => {
  it("rounds a ratio to whole percent", () => {
    assert.equal(formatPercent(0.8), "80%");
    assert.equal(formatPercent(0), "0%");
  });

  it("crosses to warning at 80 and over at 100", () => {
    assert.equal(capLevel(0), "ok");
    assert.equal(capLevel(79), "ok");
    assert.equal(capLevel(80), "warning");
    assert.equal(capLevel(99), "warning");
    assert.equal(capLevel(100), "over");
    assert.equal(capLevel(140), "over");
  });
});

describe("formatUntil", () => {
  it("counts down in the largest useful unit", () => {
    assert.equal(formatUntil(NOW + 4 * 60_000, NOW), "in 4m");
    assert.equal(formatUntil(NOW + 3 * 3_600_000 + 12 * 60_000, NOW), "in 3h 12m");
    assert.equal(formatUntil(NOW + 5 * 3_600_000, NOW), "in 5h");
    assert.equal(formatUntil(NOW + 26 * 3_600_000, NOW), "in 1d 2h");
  });

  it("says now once the moment has passed", () => {
    assert.equal(formatUntil(NOW, NOW), "now");
    assert.equal(formatUntil(NOW - 1000, NOW), "now");
  });
});

describe("formatPeriod", () => {
  it("names the common periods", () => {
    assert.equal(formatPeriod(60), "hour");
    assert.equal(formatPeriod(1440), "day");
    assert.equal(formatPeriod(10080), "week");
  });

  it("falls back to units for anything else", () => {
    assert.equal(formatPeriod(2880), "2 days");
    assert.equal(formatPeriod(360), "6 hours");
    assert.equal(formatPeriod(90), "90 min");
  });
});

describe("parsePositiveNumber / parsePositiveInt", () => {
  // Svelte's bind:value on <input type="number"> hands back a number, not a string —
  // assuming a string here threw at runtime and silently dropped the save.
  it("reads a number as readily as a string", () => {
    assert.equal(parsePositiveNumber(3.5), 3.5);
    assert.equal(parsePositiveNumber("3.50"), 3.5);
    assert.equal(parsePositiveInt(720), 720);
    assert.equal(parsePositiveInt("720"), 720);
  });

  it("treats an empty field as no cap", () => {
    assert.equal(parsePositiveNumber(""), null);
    assert.equal(parsePositiveNumber("   "), null);
    assert.equal(parsePositiveNumber(null), null);
    assert.equal(parsePositiveNumber(undefined), null);
    assert.equal(parsePositiveInt(""), null);
  });

  it("refuses zero and negatives rather than inverting what they mean", () => {
    assert.equal(parsePositiveNumber(0), null);
    assert.equal(parsePositiveNumber(-2), null);
    assert.equal(parsePositiveInt(0), null);
    assert.equal(parsePositiveInt(-5), null);
  });

  it("refuses junk", () => {
    assert.equal(parsePositiveNumber("abc"), null);
    assert.equal(parsePositiveInt("abc"), null);
  });
});

describe("resolveCapEdit", () => {
  const base = { custom: false, period: 1440, customPeriod: "" };

  it("saves a valid amount with the chosen preset period", () => {
    assert.deepEqual(resolveCapEdit({ ...base, amount: "2.50" }), {
      ok: true,
      amount: 2.5,
      periodMinutes: 1440,
    });
    // A number input hands back a number, not a string.
    assert.deepEqual(resolveCapEdit({ ...base, amount: 6, period: 720 }), {
      ok: true,
      amount: 6,
      periodMinutes: 720,
    });
  });

  it("treats a cleared amount as no cap — that is the deliberate gesture", () => {
    for (const amount of ["", "  ", null, undefined]) {
      assert.deepEqual(
        resolveCapEdit({ ...base, amount }),
        { ok: true, amount: null, periodMinutes: null },
        `cleared via ${JSON.stringify(amount)}`,
      );
    }
  });

  // The blocker: 0 parses to null, null is the wire value for "no cap", so accepting a 0
  // would delete the cap of a host who typed it meaning "spend nothing".
  it("refuses 0 rather than reading it as no cap", () => {
    const r = resolveCapEdit({ ...base, amount: 0 });
    assert.equal(r.ok, false);
    assert.match(r.ok === false ? r.error : "", /above 0/);
    assert.equal(resolveCapEdit({ ...base, amount: "0" }).ok, false);
    assert.equal(resolveCapEdit({ ...base, amount: "0.00" }).ok, false);
  });

  it("refuses negatives and junk", () => {
    assert.equal(resolveCapEdit({ ...base, amount: -2 }).ok, false);
    assert.equal(resolveCapEdit({ ...base, amount: "abc" }).ok, false);
  });

  it("uses a valid custom period", () => {
    assert.deepEqual(
      resolveCapEdit({ amount: "3", custom: true, period: 1440, customPeriod: "90" }),
      { ok: true, amount: 3, periodMinutes: 90 },
    );
  });

  // Used to persist 1440 silently while the custom box still read empty.
  it("refuses a blank or invalid custom period rather than substituting a day", () => {
    const blank = resolveCapEdit({ amount: "3", custom: true, period: 1440, customPeriod: "" });
    assert.equal(blank.ok, false);
    assert.match(blank.ok === false ? blank.error : "", /1 minute or more/);
    assert.equal(
      resolveCapEdit({ amount: "3", custom: true, period: 1440, customPeriod: 0 }).ok,
      false,
    );
    assert.equal(
      resolveCapEdit({ amount: "3", custom: true, period: 1440, customPeriod: "abc" }).ok,
      false,
    );
  });

  it("still clears the cap from a blank amount even on a broken custom period", () => {
    assert.deepEqual(resolveCapEdit({ amount: "", custom: true, period: 1440, customPeriod: "" }), {
      ok: true,
      amount: null,
      periodMinutes: null,
    });
  });
});

describe("spendFigure", () => {
  it("is a plain total when every turn was priced", () => {
    const f = spendFigure({ costUsd: 3.1, unpricedTurns: 0, preUpgradeTurns: 0 });
    assert.equal(f.text, "$3.10");
    assert.equal(f.floor, false);
    assert.equal(f.note, "");
  });

  it("is a floor when turns went unpriced, and says so", () => {
    const f = spendFigure({ costUsd: 3.1, unpricedTurns: 4, preUpgradeTurns: 4 });
    assert.equal(f.floor, true);
    assert.match(f.note, /At least \$3\.10/);
    assert.match(f.note, /4 turns unmetered \(pre-upgrade/);
    assert.match(f.note, /nothing against a cap/);
  });

  it("names pre-upgrade turns and unknown-pricing turns separately", () => {
    const f = spendFigure({ costUsd: 1, unpricedTurns: 5, preUpgradeTurns: 2 });
    assert.match(f.note, /2 turns unmetered \(pre-upgrade/);
    assert.match(f.note, /3 turns with pricing unknown/);
  });

  it("never uses a directional word — legacy rows are wrong in both directions", () => {
    const f = spendFigure({ costUsd: 1, unpricedTurns: 3, preUpgradeTurns: 1 });
    assert.doesNotMatch(f.note, /undercount|overcount|understate|overstate/i);
  });

  it("singularizes a lone turn", () => {
    const f = spendFigure({ costUsd: 1, unpricedTurns: 1, preUpgradeTurns: 1 });
    assert.match(f.note, /1 turn unmetered/);
  });
});

describe("unpricedLabel", () => {
  it("is empty when nothing is unpriced", () => {
    assert.equal(unpricedLabel({ unpricedTurns: 0, preUpgradeTurns: 0 }), "");
  });

  it("names the cause when there is only one", () => {
    assert.equal(unpricedLabel({ unpricedTurns: 3, preUpgradeTurns: 3 }), "pre-upgrade");
    assert.equal(unpricedLabel({ unpricedTurns: 3, preUpgradeTurns: 0 }), "pricing unknown");
  });

  it("stays neutral when both apply", () => {
    assert.equal(unpricedLabel({ unpricedTurns: 3, preUpgradeTurns: 1 }), "partly unmetered");
  });
});

// --- spendStrip ---

function usage(over: Partial<UsageReport["total"]> = {}, window: UsageReport["window"] = "24h") {
  return {
    window,
    since: "",
    until: "",
    bucketMinutes: 60,
    total: {
      costUsd: 0,
      turns: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      cacheHitRatio: 0,
      unpricedTurns: 0,
      preUpgradeTurns: 0,
      ...over,
    },
    minds: [],
    series: [],
  } satisfies UsageReport;
}

function budget(over: Partial<MindBudget> = {}): MindBudget {
  return {
    system: null,
    held: { count: 0, scope: null, releasesAt: null },
    ...over,
  };
}

function mindRow(name: string, over: Partial<MindUsage> = {}): MindUsage {
  return {
    mind: name,
    costUsd: 0,
    turns: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    cacheHitRatio: 0,
    unpricedTurns: 0,
    preUpgradeTurns: 0,
    series: [{ start: "2026-08-24T13:00:00.000Z", costUsd: 0, turns: 0, unpricedTurns: 0 }],
    ...over,
  };
}

describe("usageScope", () => {
  const atlas = mindRow("atlas", { costUsd: 8, turns: 60 });
  const bardo = mindRow("bardo", { costUsd: 2, turns: 40 });
  const report = {
    ...usage({ costUsd: 10, turns: 100 }),
    minds: [atlas, bardo],
    series: [{ start: "2026-08-24T13:00:00.000Z", costUsd: 10, turns: 100, unpricedTurns: 0 }],
  };

  it("shows install-wide totals and every mind when nothing is focused", () => {
    const s = usageScope(report, null);
    assert.equal(s.totals.costUsd, 10);
    assert.deepEqual(
      s.rows.map((r) => r.mind),
      ["atlas", "bardo"],
    );
    assert.equal(s.series[0].costUsd, 10);
  });

  it("narrows to one mind's own totals and series when focused", () => {
    const s = usageScope(report, "bardo");
    assert.equal(s.totals.costUsd, 2);
    assert.deepEqual(
      s.rows.map((r) => r.mind),
      ["bardo"],
    );
    assert.equal(s.series, bardo.series);
  });

  // The bug this pins: falling back to report.total here would print the whole
  // install's spend under one mind's name.
  it("reads as a real zero when the focused mind recorded nothing", () => {
    const s = usageScope(report, "cinder");
    assert.equal(s.totals.costUsd, 0);
    assert.equal(s.totals.turns, 0);
    assert.deepEqual(s.rows, []);
    assert.deepEqual(s.series, []);
    assert.notEqual(s.totals.costUsd, report.total.costUsd);
  });

  it("is empty before the report loads", () => {
    const s = usageScope(null, "atlas");
    assert.equal(s.totals.turns, 0);
    assert.deepEqual(s.rows, []);
  });
});

describe("spendStrip", () => {
  it("is null when there is no cap, nothing held, and no turns", () => {
    assert.equal(spendStrip(null, usage(), NOW), null);
    assert.equal(spendStrip(budget(), usage(), NOW), null);
  });

  it("shows window spend for an uncapped mind that has been spending", () => {
    const s = spendStrip(null, usage({ costUsd: 0.42, turns: 9 }), NOW);
    assert.ok(s);
    assert.equal(s.figure.text, "$0.42");
    assert.equal(s.scope, "last 24h");
    assert.equal(s.cap, null);
    assert.equal(s.held, null);
  });

  it("leads with the cap period when a cap is set, and always shows the reset", () => {
    const s = spendStrip(
      budget({
        spentUsd: 1.6,
        capUsd: 2,
        periodMinutes: 1440,
        percentUsed: 80,
        resetAt: NOW + 5 * 3_600_000,
      }),
      usage({ costUsd: 1.9, turns: 20 }),
      NOW,
    );
    assert.ok(s);
    assert.equal(s.figure.text, "$1.60");
    assert.equal(s.scope, "this day");
    assert.equal(s.cap?.capUsd, 2);
    assert.equal(s.cap?.percentUsed, 80);
    assert.equal(s.cap?.level, "warning");
    assert.equal(s.cap?.resetsIn, "in 5h");
  });

  it("marks the cap-period figure as a floor when the period had unpriced turns", () => {
    const s = spendStrip(
      budget({
        spentUsd: 1.6,
        capUsd: 2,
        percentUsed: 80,
        resetAt: NOW + 3_600_000,
        hasUnpricedTurns: true,
      }),
      usage({ turns: 3 }),
      NOW,
    );
    assert.equal(s?.figure.floor, true);
    assert.match(s?.figure.note ?? "", /At least \$1\.60/);
  });

  it("hides the wall-clock row when it covers the same span as the cap period", () => {
    const same = spendStrip(
      budget({ spentUsd: 1, capUsd: 2, periodMinutes: 1440, percentUsed: 50, resetAt: NOW }),
      usage({ costUsd: 1, turns: 4 }, "24h"),
      NOW,
    );
    assert.equal(same?.window, null);

    const different = spendStrip(
      budget({ spentUsd: 1, capUsd: 2, periodMinutes: 60, percentUsed: 50, resetAt: NOW }),
      usage({ costUsd: 4, turns: 40 }, "24h"),
      NOW,
    );
    assert.equal(different?.window?.label, "last 24h");
    assert.equal(different?.window?.figure.text, "$4.00");
  });

  it("reports a hold with when it releases", () => {
    const s = spendStrip(
      budget({
        spentUsd: 2,
        capUsd: 2,
        percentUsed: 100,
        resetAt: NOW + 2 * 3_600_000,
        held: { count: 3, scope: "mind", releasesAt: NOW + 2 * 3_600_000 },
      }),
      usage({ turns: 5 }),
      NOW,
    );
    assert.equal(s?.held?.scope, "mind");
    assert.equal(s?.held?.count, 3);
    assert.equal(s?.held?.releasesIn, "in 2h");
    assert.equal(s?.cap?.level, "over");
  });

  it("shows a hold even for a mind with no cap of its own — the system cap holds it", () => {
    const s = spendStrip(
      budget({
        held: { count: 2, scope: "system", releasesAt: NOW + 60 * 60_000 },
        system: {
          spentUsd: 10,
          capUsd: 10,
          periodStart: NOW,
          resetAt: NOW + 60 * 60_000,
          hasUnpricedTurns: false,
          percentUsed: 100,
        },
      }),
      usage(),
      NOW,
    );
    assert.equal(s?.held?.scope, "system");
    assert.equal(s?.cap, null);
    assert.equal(s?.systemCap?.level, "over");
    assert.equal(s?.systemCap?.resetsIn, "in 1h");
  });

  it("stays quiet about a system cap that is nowhere near its limit", () => {
    const s = spendStrip(
      budget({
        spentUsd: 0.1,
        capUsd: 1,
        percentUsed: 10,
        resetAt: NOW,
        system: {
          spentUsd: 1,
          capUsd: 10,
          periodStart: NOW,
          resetAt: NOW,
          hasUnpricedTurns: false,
          percentUsed: 10,
        },
      }),
      usage({ turns: 1 }),
      NOW,
    );
    assert.equal(s?.systemCap, null);
  });
});
