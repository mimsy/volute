import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  cacheHitRatio,
  readWindow,
  usageReport,
  windowBounds,
} from "../packages/daemon/src/lib/daemon/usage-report.js";
import { getDb } from "../packages/daemon/src/lib/db.js";
import { mindHistory } from "../packages/daemon/src/lib/schema.js";

/** A fixed "now" so window boundaries are exact rather than whatever the clock says. */
const NOW = Date.parse("2026-08-24T13:30:00Z");

function dbStamp(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace("T", " ");
}

type Row = {
  mind: string;
  at: number;
  metadata: Record<string, unknown> | null;
  type?: string;
};

async function seed(rows: Row[]): Promise<void> {
  const db = await getDb();
  await db.insert(mindHistory).values(
    rows.map((r) => ({
      mind: r.mind,
      type: r.type ?? "usage",
      metadata: r.metadata === null ? null : JSON.stringify(r.metadata),
      created_at: dbStamp(r.at),
    })),
  );
}

/** A fully-priced turn, the shape an upgraded mind emits. */
function priced(costUsd: number, tokens?: Partial<Record<string, number>>) {
  return {
    input_tokens: 100,
    output_tokens: 50,
    cache_read_input_tokens: 800,
    cache_creation_input_tokens: 100,
    model: "anthropic:claude-haiku-4-5",
    cost_usd: costUsd,
    ...tokens,
  };
}

/** A legacy two-field turn: no cache fields, left unpriced and flagged `partial`. */
function preUpgrade() {
  return { input_tokens: 200, output_tokens: 60, cost_usd: null, partial: true };
}

/** An upgraded turn on a model with no rates: full counts, still unpriced. */
function unknownModel() {
  return {
    input_tokens: 10,
    output_tokens: 20,
    cache_read_input_tokens: 30,
    cache_creation_input_tokens: 40,
    model: "custom:homebrew-7b",
    cost_usd: null,
  };
}

describe("readWindow", () => {
  it("defaults to 24h when absent or empty", () => {
    assert.equal(readWindow(undefined), "24h");
    assert.equal(readWindow(""), "24h");
  });

  it("accepts the windows we have", () => {
    assert.equal(readWindow("24h"), "24h");
    assert.equal(readWindow("7d"), "7d");
    assert.equal(readWindow("30d"), "30d");
  });

  it("refuses an unknown window rather than silently substituting one", () => {
    assert.equal(readWindow("90d"), null);
    assert.equal(readWindow("1h"), null);
    assert.equal(readWindow("24H"), null);
  });
});

describe("windowBounds", () => {
  it("gives 24 hourly buckets ending with the hour we are in", () => {
    const b = windowBounds("24h", NOW);
    assert.equal(b.buckets, 24);
    assert.equal(b.bucketMs, 3_600_000);
    assert.equal(new Date(b.endMs).toISOString(), "2026-08-24T14:00:00.000Z");
    assert.equal(new Date(b.startMs).toISOString(), "2026-08-23T14:00:00.000Z");
  });

  it("aligns 7d to UTC day boundaries", () => {
    const b = windowBounds("7d", NOW);
    assert.equal(b.buckets, 7);
    assert.equal(new Date(b.endMs).toISOString(), "2026-08-25T00:00:00.000Z");
    assert.equal(new Date(b.startMs).toISOString(), "2026-08-18T00:00:00.000Z");
  });

  it("covers 30 days", () => {
    const b = windowBounds("30d", NOW);
    assert.equal(b.buckets, 30);
    assert.equal(new Date(b.startMs).toISOString(), "2026-07-26T00:00:00.000Z");
  });
});

describe("cacheHitRatio", () => {
  it("is cache reads over everything that came in", () => {
    assert.equal(
      cacheHitRatio({ inputTokens: 100, cacheReadTokens: 800, cacheCreationTokens: 100 }),
      0.8,
    );
  });

  it("is 0 rather than NaN when nothing came in", () => {
    assert.equal(cacheHitRatio({ inputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }), 0);
  });
});

describe("usageReport", () => {
  it("sums cost and tokens per mind and ranks by spend", async () => {
    const a = `usage-rank-a-${Date.now()}`;
    const b = `usage-rank-b-${Date.now()}`;
    await seed([
      { mind: a, at: NOW - 3_600_000, metadata: priced(0.01) },
      { mind: a, at: NOW - 7_200_000, metadata: priced(0.02) },
      { mind: b, at: NOW - 3_600_000, metadata: priced(0.5) },
    ]);

    const report = await usageReport({ window: "24h", now: NOW });
    const rows = report.minds.filter((m) => m.mind === a || m.mind === b);
    assert.deepEqual(
      rows.map((m) => m.mind),
      [b, a],
      "ranked by spend, biggest first",
    );

    const rowA = rows.find((m) => m.mind === a)!;
    assert.equal(Math.round(rowA.costUsd * 1000) / 1000, 0.03);
    assert.equal(rowA.turns, 2);
    assert.equal(rowA.inputTokens, 200);
    assert.equal(rowA.outputTokens, 100);
    assert.equal(rowA.cacheReadTokens, 1600);
    assert.equal(rowA.cacheCreationTokens, 200);
    assert.equal(rowA.cacheHitRatio, 0.8);
    assert.equal(rowA.unpricedTurns, 0);
  });

  it("counts only usage rows", async () => {
    const mind = `usage-types-${Date.now()}`;
    await seed([
      { mind, at: NOW - 60_000, metadata: priced(0.05) },
      { mind, at: NOW - 60_000, metadata: { cost_usd: 99 }, type: "text" },
      { mind, at: NOW - 60_000, metadata: { cost_usd: 99 }, type: "tool_use" },
    ]);

    const report = await usageReport({ window: "24h", mind, now: NOW });
    assert.equal(report.minds[0].turns, 1);
    assert.equal(report.minds[0].costUsd, 0.05);
  });

  it("excludes rows outside the window on both edges", async () => {
    const mind = `usage-bounds-${Date.now()}`;
    const { startMs, endMs } = windowBounds("24h", NOW);
    await seed([
      { mind, at: startMs - 1000, metadata: priced(1) }, // just before → out
      { mind, at: startMs, metadata: priced(0.25) }, // exactly at start → in
      { mind, at: endMs - 1000, metadata: priced(0.25) }, // last second → in
      { mind, at: endMs, metadata: priced(1) }, // at the exclusive end → out
    ]);

    const report = await usageReport({ window: "24h", mind, now: NOW });
    assert.equal(report.minds[0].turns, 2, "only the two rows inside the window");
    assert.equal(report.minds[0].costUsd, 0.5);
  });

  it("counts unpriced turns and never invents a cost for them", async () => {
    const mind = `usage-unpriced-${Date.now()}`;
    await seed([
      { mind, at: NOW - 60_000, metadata: priced(0.1) },
      { mind, at: NOW - 120_000, metadata: preUpgrade() },
      { mind, at: NOW - 180_000, metadata: unknownModel() },
      { mind, at: NOW - 240_000, metadata: null }, // a row with no metadata at all
    ]);

    const row = (await usageReport({ window: "24h", mind, now: NOW })).minds[0];
    assert.equal(row.turns, 4);
    assert.equal(row.costUsd, 0.1, "the sum is a floor — unpriced turns add nothing");
    assert.equal(row.unpricedTurns, 3, "pre-upgrade, unknown-model, and metadata-less rows");
    assert.equal(row.preUpgradeTurns, 1, "only the template-partial row is a pre-upgrade turn");
  });

  // preUpgradeTurns must be a subset of unpricedTurns, and structurally so — every
  // consumer computes `unpricedTurns - preUpgradeTurns` and would go negative otherwise.
  it("never counts a priced turn as pre-upgrade, even if one were flagged partial", async () => {
    const mind = `usage-subset-${Date.now()}`;
    await seed([
      { mind, at: NOW - 60_000, metadata: { ...preUpgrade(), cost_usd: 0.5 } },
      { mind, at: NOW - 120_000, metadata: preUpgrade() },
    ]);

    const row = (await usageReport({ window: "24h", mind, now: NOW })).minds[0];
    assert.equal(row.turns, 2);
    assert.equal(row.unpricedTurns, 1, "only the genuinely unpriced turn");
    assert.equal(row.preUpgradeTurns, 1, "the priced-but-partial turn is not pre-upgrade");
    assert.ok(
      row.preUpgradeTurns <= row.unpricedTurns,
      "pre-upgrade turns are a subset of unpriced turns",
    );
  });

  it("scopes to one mind when asked", async () => {
    const mine = `usage-scope-mine-${Date.now()}`;
    const other = `usage-scope-other-${Date.now()}`;
    await seed([
      { mind: mine, at: NOW - 60_000, metadata: priced(0.3) },
      { mind: other, at: NOW - 60_000, metadata: priced(9) },
    ]);

    const report = await usageReport({ window: "24h", mind: mine, now: NOW });
    assert.deepEqual(
      report.minds.map((m) => m.mind),
      [mine],
    );
    assert.equal(report.total.costUsd, 0.3);
  });

  it("buckets hourly for 24h, zero-filling quiet hours", async () => {
    const mind = `usage-series-h-${Date.now()}`;
    const { startMs } = windowBounds("24h", NOW);
    await seed([
      { mind, at: startMs + 30_000, metadata: priced(0.2) }, // first bucket
      { mind, at: startMs + 2 * 3_600_000 + 60_000, metadata: priced(0.4) }, // third bucket
      { mind, at: startMs + 2 * 3_600_000 + 90_000, metadata: preUpgrade() },
    ]);

    const report = await usageReport({ window: "24h", mind, now: NOW });
    assert.equal(report.series.length, 24);
    assert.equal(report.bucketMinutes, 60);
    assert.equal(report.series[0].start, new Date(startMs).toISOString());
    assert.equal(report.series[0].costUsd, 0.2);
    assert.equal(report.series[1].costUsd, 0, "a quiet hour is a zero, not a gap");
    assert.equal(report.series[1].turns, 0);
    assert.equal(report.series[2].costUsd, 0.4);
    assert.equal(report.series[2].turns, 2);
    assert.equal(report.series[2].unpricedTurns, 1);
    assert.equal(
      report.series.reduce((n, b) => n + b.turns, 0),
      3,
      "the series accounts for every turn in the totals",
    );
  });

  it("buckets daily for 7d", async () => {
    const mind = `usage-series-d-${Date.now()}`;
    const { startMs } = windowBounds("7d", NOW);
    await seed([
      { mind, at: startMs + 3_600_000, metadata: priced(0.1) },
      { mind, at: startMs + 20 * 3_600_000, metadata: priced(0.1) }, // same UTC day
      { mind, at: startMs + 3 * 86_400_000, metadata: priced(0.7) },
    ]);

    const report = await usageReport({ window: "7d", mind, now: NOW });
    assert.equal(report.series.length, 7);
    assert.equal(report.bucketMinutes, 1440);
    assert.equal(Math.round(report.series[0].costUsd * 100) / 100, 0.2, "both fall in day 0");
    assert.equal(report.series[0].turns, 2);
    assert.equal(report.series[3].costUsd, 0.7);
  });

  it("gives each mind its own series, and the global series is their sum", async () => {
    const a = `usage-permind-a-${Date.now()}`;
    const b = `usage-permind-b-${Date.now()}`;
    const { startMs } = windowBounds("24h", NOW);
    await seed([
      { mind: a, at: startMs + 60_000, metadata: priced(0.1) }, // bucket 0
      { mind: b, at: startMs + 2 * 3_600_000, metadata: priced(0.3) }, // bucket 2
      { mind: b, at: startMs + 60_000, metadata: priced(0.2) }, // bucket 0
    ]);

    const report = await usageReport({ window: "24h", now: NOW });
    const rowA = report.minds.find((m) => m.mind === a)!;
    const rowB = report.minds.find((m) => m.mind === b)!;
    assert.equal(rowA.series.length, 24);
    assert.equal(rowA.series[0].costUsd, 0.1);
    assert.equal(rowA.series[2].costUsd, 0, "a's series holds only a's spend");
    assert.equal(rowB.series[0].costUsd, 0.2);
    assert.equal(rowB.series[2].costUsd, 0.3);
    // Other tests share this DB, so the global bucket contains these two and possibly more.
    assert.ok(
      report.series[0].costUsd >= rowA.series[0].costUsd + rowB.series[0].costUsd - 1e-9,
      "the global bucket contains both minds' spend for that bucket",
    );
    assert.equal(report.series[0].turns >= rowA.series[0].turns + rowB.series[0].turns, true);
  });

  it("reports an empty window as zeros, not as absent fields", async () => {
    const mind = `usage-empty-${Date.now()}`;
    const report = await usageReport({ window: "24h", mind, now: NOW });
    assert.deepEqual(report.minds, []);
    assert.equal(report.total.costUsd, 0);
    assert.equal(report.total.turns, 0);
    assert.equal(report.total.cacheHitRatio, 0);
    assert.equal(report.total.unpricedTurns, 0);
    assert.equal(report.series.length, 24);
    assert.ok(report.series.every((b) => b.costUsd === 0 && b.turns === 0));
  });

  it("totals across minds, with the total's own cache ratio", async () => {
    const a = `usage-total-a-${Date.now()}`;
    const b = `usage-total-b-${Date.now()}`;
    await seed([
      { mind: a, at: NOW - 60_000, metadata: priced(0.1) },
      { mind: b, at: NOW - 60_000, metadata: preUpgrade() },
    ]);

    const report = await usageReport({ window: "24h", now: NOW });
    const mine = report.minds.filter((m) => m.mind === a || m.mind === b);
    const cost = mine.reduce((n, m) => n + m.costUsd, 0);
    const unpriced = mine.reduce((n, m) => n + m.unpricedTurns, 0);
    assert.ok(report.total.costUsd >= cost);
    assert.ok(report.total.unpricedTurns >= unpriced);
    assert.ok(report.total.cacheHitRatio >= 0 && report.total.cacheHitRatio <= 1);
  });
});
