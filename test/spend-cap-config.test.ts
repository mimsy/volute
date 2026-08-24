import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { restoreMindRuntimeState } from "../packages/daemon/src/lib/daemon/mind-service.js";
import { getSpendBudget, initSpendBudget } from "../packages/daemon/src/lib/daemon/spend-budget.js";
import { usd } from "../packages/daemon/src/lib/daemon/turn-lifecycle.js";
import { addMind, mindDir, removeMind } from "../packages/daemon/src/lib/mind/registry.js";
import log from "../packages/daemon/src/lib/util/logger.js";

/** Run `fn` with the structured logger captured, returning every line it wrote. */
async function captureLog(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  log.setOutput((line) => lines.push(line));
  log.setLevel("debug");
  try {
    await fn();
  } finally {
    log.setOutput((line) => process.stderr.write(`${line}\n`));
    log.setLevel("info");
  }
  return lines;
}

function writeConfig(name: string, config: Record<string, unknown>): void {
  const dir = mindDir(name);
  mkdirSync(resolve(dir, "home/.config"), { recursive: true });
  writeFileSync(resolve(dir, "home/.config/volute.json"), JSON.stringify(config));
}

describe("spend cap loading from volute.json", () => {
  const mindName = `spend-cap-${process.pid}`;

  beforeEach(async () => {
    try {
      initSpendBudget();
    } catch {
      // already initialized by another test in this process
    }
    await removeMind(mindName);
    await addMind(mindName, 4998, "sprouted", "claude");
  });

  afterEach(async () => {
    await getSpendBudget().removeBudget(mindName);
    await removeMind(mindName);
  });

  it("loads spendCap with its configured period", async () => {
    writeConfig(mindName, { spendCap: 7.5, spendCapPeriodMinutes: 120 });
    await restoreMindRuntimeState(mindName);

    const usage = getSpendBudget().getUsage(mindName);
    assert.ok(usage, "a configured spendCap sets a live budget");
    assert.equal(usage.capUsd, 7.5);
    assert.equal(usage.periodMinutes, 120);
  });

  it("defaults the period to a day when only spendCap is set", async () => {
    writeConfig(mindName, { spendCap: 3 });
    await restoreMindRuntimeState(mindName);

    assert.equal(getSpendBudget().getUsage(mindName)!.periodMinutes, 1440);
  });

  it("a config carrying only the old tokenBudget yields no cap, and says so", async () => {
    // Budgets are dollars now and there is no honest conversion from a token count,
    // so the mind runs uncapped rather than being silently held to a number that
    // means something else — and the host is told exactly which key to replace.
    writeConfig(mindName, { tokenBudget: 50_000, tokenBudgetPeriodMinutes: 60 });
    const lines = await captureLog(() => restoreMindRuntimeState(mindName));

    assert.equal(getSpendBudget().getUsage(mindName), null, "no cap is enforced");

    const warning = lines
      .map((l) => JSON.parse(l))
      .find((e) => e.level === "warn" && e.msg.includes("tokenBudget"));
    assert.ok(warning, `expected a warning naming tokenBudget, got: ${lines.join("\n")}`);
    assert.match(warning.msg, new RegExp(mindName), "the warning names the mind");
    assert.match(warning.msg, /spendCap/, "the warning names the replacement key");
  });

  it("spendCap wins when a config carries both keys", async () => {
    writeConfig(mindName, { spendCap: 2, tokenBudget: 50_000 });
    const lines = await captureLog(() => restoreMindRuntimeState(mindName));

    assert.equal(getSpendBudget().getUsage(mindName)!.capUsd, 2);
    const warned = lines.map((l) => JSON.parse(l)).some((e) => e.msg?.includes("tokenBudget"));
    assert.equal(warned, false, "nothing to warn about — the mind has a real cap");
  });
});

describe("spend notice formatting", () => {
  it("renders dollars to the cent", () => {
    assert.equal(usd(0), "$0.00");
    assert.equal(usd(1), "$1.00");
    assert.equal(usd(0.856), "$0.86");
    assert.equal(usd(12.5), "$12.50");
  });

  it("keeps a sub-cent amount legible instead of rounding it to nothing", () => {
    // "$0.00 of your $0.00 budget" would be a nonsense sentence to hand a mind.
    assert.equal(usd(0.005), "$0.0050");
    assert.equal(usd(0.004), "$0.0040");
  });
});
