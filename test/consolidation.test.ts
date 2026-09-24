import assert from "node:assert/strict";
import { linkSync, mkdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { and, eq, sql } from "drizzle-orm";
import {
  aiCompleteModelOutcome,
  removeProviderConfig,
  saveProviderConfig,
  setEnabledModels,
  withDeadline,
} from "../packages/daemon/src/lib/ai-service.js";
import { getOrCreateMindUser } from "../packages/daemon/src/lib/auth.js";
import {
  boundEntries,
  type CompleteAsMindDeps,
  type Completion,
  completeAsMind,
  gatherWritings,
  mindHome,
  readHomeFile,
  readMindSoul,
} from "../packages/daemon/src/lib/daemon/consolidation.js";
import { getRecollection } from "../packages/daemon/src/lib/daemon/recollection.js";
import {
  repairProvisionalSummaries,
  Summarizer,
  summarizePeriod,
  TICK_STALE_MS,
} from "../packages/daemon/src/lib/daemon/summarizer.js";
import { mindModelId } from "../packages/daemon/src/lib/daemon/usage-pricing.js";
import { getDb } from "../packages/daemon/src/lib/db.js";
import { addMind, mindDir, removeMind } from "../packages/daemon/src/lib/mind/registry.js";
import { PROMPT_DEFAULTS } from "../packages/daemon/src/lib/prompts.js";
import { mindHistory, summaries, users } from "../packages/daemon/src/lib/schema.js";
import { getPeriodKey, utcDateTimeStr } from "../packages/daemon/src/lib/util/period-keys.js";
import { createSession, deleteSession } from "../packages/daemon/src/web/middleware/auth.js";

const PREFIX = "test-consol-";
const dirs: string[] = [];
const sessions: string[] = [];

afterEach(async () => {
  const db = await getDb();
  await db.delete(summaries).where(sql`mind LIKE ${`${PREFIX}%`}`);
  await db.delete(mindHistory).where(sql`mind LIKE ${`${PREFIX}%`}`);
  await db.delete(users).where(sql`username LIKE ${`${PREFIX}%`}`);
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  while (sessions.length) deleteSession(sessions.pop()!);
  for (const m of [`${PREFIX}api`, `${PREFIX}api-bad`]) await removeMind(m);
});

/** A local wall-clock time, as the DB's UTC created_at text. */
const at = (y: number, mo: number, d: number, h: number, mi = 0) =>
  utcDateTimeStr(new Date(y, mo - 1, d, h, mi));

async function insertSummary(
  mind: string,
  period: string,
  key: string,
  content: string,
  opts: { createdAt?: string; metadata?: Record<string, unknown> } = {},
) {
  const db = await getDb();
  const values: Record<string, unknown> = {
    mind,
    period,
    period_key: key,
    content,
    metadata: JSON.stringify(opts.metadata ?? { deterministic: false }),
  };
  if (opts.createdAt) values.created_at = opts.createdAt;
  await db.insert(summaries).values(values as typeof summaries.$inferInsert);
}

async function insertHistory(mind: string, type: string, content: string, createdAt: string) {
  const db = await getDb();
  await db
    .insert(mindHistory)
    .values({ mind, type, channel: "#garden", content, created_at: createdAt });
}

async function getRow(mind: string, period: string, key: string) {
  const db = await getDb();
  return db
    .select()
    .from(summaries)
    .where(
      and(eq(summaries.mind, mind), eq(summaries.period, period), eq(summaries.period_key, key)),
    )
    .get();
}

function home(mind: string): string {
  const dir = mindDir(mind);
  dirs.push(dir);
  const h = join(dir, "home");
  mkdirSync(join(h, "memory", "journal"), { recursive: true });
  mkdirSync(join(h, "memory", "dreams"), { recursive: true });
  return h;
}

function capture(result: Completion = { status: "ok", text: "MEMORY", model: "anthropic:m" }) {
  const calls: { system: string; user: string }[] = [];
  const complete = async (system: string, user: string) => {
    calls.push({ system, user });
    return result;
  };
  return { calls, complete };
}

describe("first-person consolidation: input", () => {
  it("gives a day's memory the mind's own words, journal, dream and SOUL.md", async () => {
    const mind = `${PREFIX}voice`;
    const h = home(mind);
    writeFileSync(join(h, "SOUL.md"), "I am a tidepool keeper.");
    writeFileSync(join(h, "memory/journal/2026-03-20.md"), "JOURNAL: the anemones opened.");
    writeFileSync(join(h, "memory/dreams/2026-03-20-night.md"), "DREAM: a lighthouse of salt.");
    writeFileSync(join(h, "memory/dreams/2026-03-19.md"), "OTHER DAY DREAM");
    await insertSummary(mind, "hour", "2026-03-20T09", "Morning.");
    await insertSummary(mind, "hour", "2026-03-20T14", "Afternoon.");
    await insertHistory(mind, "outbound", "I think the tide is turning.", at(2026, 3, 20, 10, 15));
    // Recorded as both `text` and `outbound` for an echoed reply — only outbound counts.
    await insertHistory(mind, "text", "TEXT DUPLICATE", at(2026, 3, 20, 10, 15));
    await insertHistory(mind, "inbound", "INBOUND WORDS", at(2026, 3, 20, 10, 10));
    await insertHistory(mind, "outbound", "NEXT DAY WORDS", at(2026, 3, 21, 10, 0));
    await insertHistory(`${PREFIX}other`, "outbound", "OTHER MIND WORDS", at(2026, 3, 20, 11));

    const { calls, complete } = capture();
    assert.equal(await summarizePeriod(mind, "day", "2026-03-20", complete), true);
    const { system, user } = calls[0];
    assert.ok(system.startsWith("I am a tidepool keeper."), "SOUL.md leads the system prompt");
    assert.match(system, /first person/);
    assert.match(system, /no hindsight/);
    assert.ok(user.includes("[09:00] Morning."));
    assert.ok(user.includes("[said 10:15 on #garden] I think the tide is turning."), user);
    assert.ok(user.includes("JOURNAL: the anemones opened."));
    assert.ok(user.includes("[dream 2026-03-20-night.md]"));
    assert.ok(user.includes("DREAM: a lighthouse of salt."));
    for (const absent of [
      "TEXT DUPLICATE",
      "INBOUND WORDS",
      "NEXT DAY WORDS",
      "OTHER MIND WORDS",
      "OTHER DAY DREAM",
    ]) {
      assert.ok(!user.includes(absent), `${absent} must not be in the input`);
    }
  });

  it("gives an hour's memory SOUL.md too", async () => {
    const mind = `${PREFIX}hour-soul`;
    const h = home(mind);
    writeFileSync(join(h, "SOUL.md"), "SOUL MARKER");
    await insertSummary(mind, "turn", "t1", "I did one thing.", {
      createdAt: at(2026, 3, 22, 15, 5),
    });
    await insertSummary(mind, "turn", "t2", "I did another.", {
      createdAt: at(2026, 3, 22, 15, 20),
    });
    const { calls, complete } = capture();
    await summarizePeriod(mind, "hour", "2026-03-22T15", complete);
    assert.ok(calls[0].system.includes("SOUL MARKER"));
  });

  it("never reads a journal or SOUL.md that points outside the mind's home", async () => {
    const mind = `${PREFIX}escape`;
    const h = home(mind);
    const outside = join(tmpdir(), `${PREFIX}secret-${process.pid}.txt`);
    writeFileSync(outside, "HOST SECRET");
    dirs.push(outside);
    symlinkSync(outside, join(h, "memory/journal/2026-03-20.md"));
    symlinkSync(outside, join(h, "SOUL.md"));
    await insertSummary(mind, "hour", "2026-03-20T09", "Morning.");
    await insertSummary(mind, "hour", "2026-03-20T14", "Afternoon.");

    const { calls, complete } = capture();
    await summarizePeriod(mind, "day", "2026-03-20", complete);
    assert.ok(!calls[0].user.includes("HOST SECRET"));
    assert.ok(!calls[0].system.includes("HOST SECRET"));
  });

  it("an hour takes the day's journal when it has been touched since the hour began", async () => {
    const mind = `${PREFIX}mtime`;
    const h = home(mind);
    const journal = join(h, "memory/journal/2026-03-22.md");
    writeFileSync(journal, "WRITTEN AT 15:10");
    // Written just after the 14:00 hour closed — still that hour's to remember.
    const mtime = new Date(2026, 2, 22, 15, 10);
    utimesSync(journal, mtime, mtime);
    for (const hour of ["14", "16"]) {
      await insertSummary(mind, "turn", `a${hour}`, "I did a thing.", {
        createdAt: at(2026, 3, 22, Number(hour), 5),
      });
      await insertSummary(mind, "turn", `b${hour}`, "I did another.", {
        createdAt: at(2026, 3, 22, Number(hour), 25),
      });
    }
    const { calls, complete } = capture();
    await summarizePeriod(mind, "hour", "2026-03-22T14", complete);
    await summarizePeriod(mind, "hour", "2026-03-22T16", complete);
    assert.ok(calls[0].user.includes("WRITTEN AT 15:10"), "14:00 sees an entry written at 15:10");
    assert.ok(!calls[1].user.includes("WRITTEN AT 15:10"), "16:00 began after its last change");
  });

  it("an hour reads the latest of the day's journal; the day reads it from the start", async () => {
    const mind = `${PREFIX}jtail`;
    const h = home(mind);
    const journal = join(h, "memory/journal/2026-03-22.md");
    writeFileSync(journal, `OLD HEAD\n${"filler line\n".repeat(1000)}NEW TAIL`);
    const mtime = new Date(2026, 2, 22, 15, 40);
    utimesSync(journal, mtime, mtime);
    await insertSummary(mind, "turn", "a", "one", { createdAt: at(2026, 3, 22, 15, 5) });
    await insertSummary(mind, "turn", "b", "two", { createdAt: at(2026, 3, 22, 15, 25) });
    await insertSummary(mind, "hour", "2026-03-22T09", "Morning.");
    const { calls, complete } = capture();
    await summarizePeriod(mind, "hour", "2026-03-22T15", complete);
    assert.ok(calls[0].user.includes("NEW TAIL") && !calls[0].user.includes("OLD HEAD"));
    await summarizePeriod(mind, "day", "2026-03-22", complete);
    assert.ok(calls[1].user.includes("OLD HEAD"));
  });

  it("truncates over-budget entries instead of omitting them", () => {
    const one = boundEntries(["a".repeat(5000)], 4000);
    assert.ok(one.length <= 4000, `${one.length}`);
    assert.ok(one.startsWith("aaaa") && one.endsWith("[… truncated …]"));
    assert.doesNotMatch(one, /omitted/);

    const two = boundEntries(["x".repeat(15000), "y".repeat(15000)], 20000);
    assert.ok(two.length <= 20000, `${two.length}`);
    assert.ok(two.split("x").length > 9000 && two.split("y").length > 9000, "each keeps ~half");
    assert.doesNotMatch(two, /omitted/);

    // A short entry keeps everything; the long one takes what's left.
    const mixed = boundEntries(["SHORT", "z".repeat(10000)], 3000);
    assert.ok(mixed.startsWith("SHORT\n\n") && mixed.length <= 3000);

    // Only very many entries fall back to a marked gap.
    const many = boundEntries(
      Array.from({ length: 100 }, (_, i) => `entry ${i} ${"m".repeat(500)}`),
      4000,
    );
    assert.ok(many.length <= 4000 && /omitted/.test(many));
    assert.ok(many.includes("entry 0") && many.includes("entry 99"));
  });

  it("a long journal keeps its header and a truncated body", async () => {
    const mind = `${PREFIX}longjournal`;
    const h = home(mind);
    writeFileSync(join(h, "memory/journal/2026-03-20.md"), `START ${"j".repeat(20000)}`);
    const writings = await gatherWritings(mind, "day", "2026-03-20");
    assert.ok(writings.startsWith("[journal 2026-03-20]\nSTART jjj"), writings.slice(0, 80));
    assert.ok(writings.length <= 6000);
    assert.doesNotMatch(writings, /omitted/);
  });

  it("won't follow a home/ the mind has pointed at another mind's home", async () => {
    const other = `${PREFIX}victim`;
    const otherHome = home(other);
    writeFileSync(join(otherHome, "SOUL.md"), "VICTIM SOUL");
    writeFileSync(join(otherHome, "memory/journal/2026-03-20.md"), "VICTIM JOURNAL");
    const mind = `${PREFIX}thief`;
    const h = home(mind);
    rmSync(h, { recursive: true });
    symlinkSync(otherHome, h);
    assert.equal(await readMindSoul(mind), "");
    assert.equal(await gatherWritings(mind, "day", "2026-03-20"), "");
    // The victim's own reads are untouched.
    assert.equal(await readMindSoul(other), "VICTIM SOUL");
  });

  it("refuses a hard link, even one inside home", async () => {
    const mind = `${PREFIX}hardlink`;
    const h = home(mind);
    const outside = join(mindDir(mind), "host-secret.txt");
    writeFileSync(outside, "HOST SECRET");
    linkSync(outside, join(h, "memory/journal/2026-03-20.md"));
    writeFileSync(join(h, "memory/journal/2026-03-21.md"), "honest");
    const base = await mindHome(mind);
    assert.equal(await readHomeFile(base, "memory/journal/2026-03-20.md", 1000), null);
    assert.equal(await readHomeFile(base, "memory/journal/2026-03-21.md", 1000), "honest");
  });

  it("refuses a file swapped under it between open and verification", async () => {
    const mind = `${PREFIX}swap`;
    const h = home(mind);
    // At open time, memory/journal is a symlink to a directory outside home…
    const outsideDir = join(mindDir(mind), "outside");
    mkdirSync(outsideDir);
    writeFileSync(join(outsideDir, "2026-03-20.md"), "HOST SECRET");
    rmSync(join(h, "memory/journal"), { recursive: true });
    symlinkSync(outsideDir, join(h, "memory/journal"));
    // …and by the time the path is resolved, it's an honest directory inside home again.
    const swapBack = async () => {
      rmSync(join(h, "memory/journal"));
      mkdirSync(join(h, "memory/journal"));
      writeFileSync(join(h, "memory/journal/2026-03-20.md"), "innocent");
    };
    const base = await mindHome(mind);
    const got = await readHomeFile(base, "memory/journal/2026-03-20.md", 1000, {
      afterOpen: swapBack,
    });
    assert.equal(got, null);
    // The honest file itself reads fine.
    assert.equal(await readHomeFile(base, "memory/journal/2026-03-20.md", 1000), "innocent");
  });

  it("bounds the mind's own words", async () => {
    const mind = `${PREFIX}bound`;
    home(mind);
    await insertSummary(mind, "turn", "t1", "I talked.", { createdAt: at(2026, 3, 22, 16, 1) });
    await insertSummary(mind, "turn", "t2", "I talked more.", {
      createdAt: at(2026, 3, 22, 16, 2),
    });
    for (let i = 0; i < 40; i++) {
      await insertHistory(mind, "outbound", "w".repeat(1000), at(2026, 3, 22, 16, i));
    }
    const { calls, complete } = capture();
    await summarizePeriod(mind, "hour", "2026-03-22T16", complete);
    assert.ok(calls[0].user.length < 8000, `input was ${calls[0].user.length} chars`);
    assert.match(calls[0].user, /omitted/);
  });
});

describe("first-person consolidation: authorship", () => {
  it("records the author and the model that wrote it", async () => {
    const mind = `${PREFIX}meta`;
    await insertSummary(mind, "hour", "2026-03-20T09", "Morning.");
    await insertSummary(mind, "hour", "2026-03-20T14", "Afternoon.");
    const { complete } = capture({
      status: "ok",
      text: "I spent the day by the water.",
      model: "anthropic:util",
      fallback: true,
    });
    await summarizePeriod(mind, "day", "2026-03-20", complete);
    const row = await getRow(mind, "day", "2026-03-20");
    const meta = JSON.parse(row!.metadata!);
    assert.equal(row!.content, "I spent the day by the water.");
    assert.equal(meta.author, "consolidation");
    assert.equal(meta.model, "anthropic:util");
    assert.equal(meta.model_fallback, true);
  });

  it("never regenerates over a mind-authored period, even a provisional one", async () => {
    const mind = `${PREFIX}mine`;
    await insertSummary(mind, "day", "2026-03-09", "Monday.");
    await insertSummary(mind, "day", "2026-03-11", "Wednesday.");
    await insertSummary(mind, "week", "2026-W11", "My own account of the week.", {
      metadata: { deterministic: true, author: "mind" },
    });
    const { calls, complete } = capture();
    assert.equal(await summarizePeriod(mind, "week", "2026-W11", complete), false);
    await repairProvisionalSummaries(complete);
    assert.equal(calls.length, 0);
    assert.equal((await getRow(mind, "week", "2026-W11"))!.content, "My own account of the week.");
  });

  it("_system rollups keep their neutral third-person voice", async () => {
    const { summarizeSystem } = await import("../packages/daemon/src/lib/daemon/summarizer.js");
    await insertSummary(`${PREFIX}a`, "day", "2026-03-18", "I did a.");
    const { calls, complete } = capture();
    await summarizeSystem("day", "2026-03-18", complete);
    assert.match(calls[0].system, /third person/);
    assert.doesNotMatch(calls[0].system, /remembering/);
    const db = await getDb();
    await db
      .delete(summaries)
      .where(and(eq(summaries.mind, "_system"), eq(summaries.period_key, "2026-03-18")));
  });
});

describe("first-person consolidation: the writer", () => {
  function deps(over: Partial<CompleteAsMindDeps>): CompleteAsMindDeps & {
    used: string[];
    charged: [string, number | null][];
  } {
    const used: string[] = [];
    const charged: [string, number | null][] = [];
    return {
      used,
      charged,
      modelFor: async () => "anthropic:mind-model",
      withModel: async (_s, _u, m, opts) => {
        used.push(m);
        opts.onCost?.(0.02);
        return { status: "ok", text: "in my voice" };
      },
      utility: async (_s, _u, opts) => {
        used.push("utility");
        opts.onCost?.(0.004);
        return { status: "ok", text: "in the utility's voice" };
      },
      utilityModel: () => "anthropic:util",
      recordCost: (mind, c) => charged.push([mind, c]),
      overCap: () => false,
      deadlineMs: 5000,
      ...over,
    };
  }

  it("reads the mind's model from its config, without the [1m] context suffix", async () => {
    const mind = `${PREFIX}model`;
    const h = home(mind);
    mkdirSync(join(h, ".config"), { recursive: true });
    writeFileSync(
      join(h, ".config/config.json"),
      JSON.stringify({ model: "anthropic:claude-opus-4-6[1m]" }),
    );
    assert.equal(await mindModelId(mind), "anthropic:claude-opus-4-6");
  });

  it("won't call a model the host hasn't configured a provider for, or hasn't enabled", async () => {
    // No providers configured in the test home: even a real catalog model is out of reach.
    assert.deepEqual(await aiCompleteModelOutcome("s", "u", "anthropic:claude-opus-4-6"), {
      status: "unconfigured",
    });
    // A configured provider isn't enough: the model comes from mind-writable config, so it must
    // also be on the host's enabled list.
    saveProviderConfig("anthropic", { apiKey: "sk-test-not-real" });
    setEnabledModels(["anthropic:claude-sonnet-4-6"]);
    try {
      assert.deepEqual(await aiCompleteModelOutcome("s", "u", "anthropic:claude-opus-4-6"), {
        status: "unconfigured",
      });
    } finally {
      setEnabledModels([]);
      removeProviderConfig("anthropic");
    }
  });

  it("uses the mind's own model, and charges the mind for it", async () => {
    const mind = `${PREFIX}w`;
    const d = deps({});
    const out = await completeAsMind(mind, "s", "u", d);
    assert.deepEqual(out, {
      status: "ok",
      text: "in my voice",
      model: "anthropic:mind-model",
      costUsd: 0.02,
    });
    assert.deepEqual(d.used, ["anthropic:mind-model"]);
    assert.deepEqual(d.charged, [[mind, 0.02]]);
  });

  it("falls back to the utility model, and says so, when it can't", async () => {
    const d = deps({ withModel: async () => ({ status: "unconfigured" }) });
    const out = await completeAsMind(`${PREFIX}w`, "s", "u", d);
    assert.deepEqual(out, {
      status: "ok",
      text: "in the utility's voice",
      model: "anthropic:util",
      fallback: true,
      costUsd: 0.004,
    });
  });

  it("falls back when the mind's model is unknown or its call fails", async () => {
    const unknown = await completeAsMind(
      `${PREFIX}w`,
      "s",
      "u",
      deps({ modelFor: async () => null }),
    );
    assert.equal(unknown.status === "ok" && unknown.fallback, true);
    const failed = await completeAsMind(
      `${PREFIX}w`,
      "s",
      "u",
      deps({ withModel: async () => ({ status: "failed" }) }),
    );
    assert.equal(failed.status === "ok" && failed.fallback, true);
  });

  it("basic mode is free: with no utility model, not even the mind's model is called (#381)", async () => {
    const d = deps({ utilityModel: () => undefined });
    assert.deepEqual(await completeAsMind(`${PREFIX}w`, "s", "u", d), { status: "unconfigured" });
    assert.deepEqual(d.used, []);
  });

  it("a hung completion times out and counts as failed, so nothing waits on it forever", async () => {
    const hung = () => new Promise<never>(() => {});
    const started = Date.now();
    const fellBack = await completeAsMind(
      `${PREFIX}w`,
      "s",
      "u",
      deps({ withModel: hung, deadlineMs: 30 }),
    );
    assert.equal(fellBack.status === "ok" && fellBack.fallback, true);
    const both = await completeAsMind(
      `${PREFIX}w`,
      "s",
      "u",
      deps({ withModel: hung, utility: hung, deadlineMs: 30 }),
    );
    assert.deepEqual(both, { status: "failed" });
    assert.ok(Date.now() - started < 2000);
    await assert.rejects(withDeadline(hung(), 20), /timed out/);
  });

  it("over its spend cap, the mind's consolidation is deferred, not billed", async () => {
    const d = deps({ overCap: () => true });
    assert.deepEqual(await completeAsMind(`${PREFIX}w`, "s", "u", d), { status: "deferred" });
    assert.deepEqual(d.used, []);
    assert.deepEqual(d.charged, []);
  });

  it("a deferred period stands as a placeholder and heals after the reset, however old", async () => {
    // Months old: far past the 7-day reconcile window and the provisional retry window.
    const mind = `${PREFIX}deferred`;
    await insertSummary(mind, "hour", "2026-01-20T09", "Morning.");
    await insertSummary(mind, "hour", "2026-01-20T14", "Afternoon.");
    const deferred = async () => ({ status: "deferred" as const });
    assert.equal(await summarizePeriod(mind, "day", "2026-01-20", deferred), true);
    const placeholder = await getRow(mind, "day", "2026-01-20");
    const meta = JSON.parse(placeholder!.metadata!);
    assert.equal(meta.deterministic, true);
    assert.equal(meta.deferred, true);
    assert.equal(meta.attempts, undefined, "nothing was tried, so no attempt is spent");

    // Still over the cap: the sweep leaves it as it is.
    await repairProvisionalSummaries(deferred);
    assert.equal(JSON.parse((await getRow(mind, "day", "2026-01-20"))!.metadata!).deferred, true);
    // After the reset, the sweep writes the real memory.
    await repairProvisionalSummaries(async () => ({ status: "ok", text: "THE REAL DAY" }));
    const healed = await getRow(mind, "day", "2026-01-20");
    assert.equal(healed!.content, "THE REAL DAY");
    assert.equal(JSON.parse(healed!.metadata!).deferred, undefined);
  });

  it("keeps failed vs unconfigured, so a retry budget is spent only on real failures", async () => {
    const none = await completeAsMind(
      `${PREFIX}w`,
      "s",
      "u",
      deps({
        withModel: async () => ({ status: "unconfigured" }),
        utility: async () => ({ status: "unconfigured" }),
      }),
    );
    assert.deepEqual(none, { status: "unconfigured" });
    const failed = await completeAsMind(
      `${PREFIX}w`,
      "s",
      "u",
      deps({
        withModel: async () => ({ status: "failed" }),
        utility: async () => ({ status: "unconfigured" }),
      }),
    );
    assert.deepEqual(failed, { status: "failed" });
  });
});

describe("recollection", () => {
  // Wednesday 25 March 2026, 15:30 local → week 2026-W13 (Mon 23 – Sun 29); last week W12.
  const before = new Date(2026, 2, 25, 15, 30);
  const keys = (entries: { period_key: string }[]) => entries.map((e) => e.period_key);

  async function seed(mind: string) {
    await insertSummary(mind, "week", "2026-W11", "TWO WEEKS AGO");
    await insertSummary(mind, "week", "2026-W12", "LAST WEEK");
    await insertSummary(mind, "day", "2026-03-22", "SUNDAY");
    await insertSummary(mind, "day", "2026-03-23", "MONDAY", { metadata: { author: "mind" } });
    await insertSummary(mind, "day", "2026-03-24", "TUESDAY");
    await insertSummary(mind, "hour", "2026-03-24T22", "TUESDAY 22");
    await insertSummary(mind, "hour", "2026-03-25T13", "ONE PM");
    await insertSummary(mind, "hour", "2026-03-25T09", "NINE AM");
    await insertSummary(mind, "hour", "2026-03-25T15", "IN PROGRESS HOUR");
  }

  it("returns last week, the two days before today, then today's completed hours", async () => {
    const mind = `${PREFIX}recall`;
    await seed(mind);
    const entries = await getRecollection(mind, before);
    assert.deepEqual(
      entries.map((e) => [e.period, e.period_key, e.content, e.author]),
      [
        ["week", "2026-W12", "LAST WEEK", "consolidation"],
        ["day", "2026-03-23", "MONDAY", "mind"],
        ["day", "2026-03-24", "TUESDAY", "consolidation"],
        ["hour", "2026-03-25T09", "NINE AM", "consolidation"],
        ["hour", "2026-03-25T13", "ONE PM", "consolidation"],
      ],
    );
    assert.equal(entries[3].start, new Date(2026, 2, 25, 9).toISOString());
    assert.equal(entries[3].end, new Date(2026, 2, 25, 10).toISOString());
  });

  it("reaches the verbatim tail: a 14:40 tail keeps 13:00 and 14:00–14:40 as the record", async () => {
    const mind = `${PREFIX}tail`;
    await seed(mind);
    await insertSummary(mind, "hour", "2026-03-25T14", "TWO PM, OVERLAPPING THE TAIL");
    await insertSummary(mind, "turn", "t14a", "BEFORE TAIL", {
      createdAt: at(2026, 3, 25, 14, 10),
    });
    await insertSummary(mind, "turn", "t14b", "AT TAIL", { createdAt: at(2026, 3, 25, 14, 40) });
    await insertSummary(mind, "turn", "t14c", "IN TAIL", { createdAt: at(2026, 3, 25, 14, 55) });
    const tailStartedAt = new Date(2026, 2, 25, 14, 40);
    const entries = await getRecollection(mind, before, { tailStartedAt });
    assert.deepEqual(
      entries.map((e) => [e.period_key, e.content, e.author]),
      [
        ["2026-W12", "LAST WEEK", "consolidation"],
        ["2026-03-23", "MONDAY", "mind"],
        ["2026-03-24", "TUESDAY", "consolidation"],
        ["2026-03-25T09", "NINE AM", "consolidation"],
        ["2026-03-25T13", "ONE PM", "consolidation"],
        // The hour's memory would retell the tail; its turns before the tail are served instead.
        ["2026-03-25T14", "BEFORE TAIL", "record"],
      ],
    );
    const partial = entries.at(-1)!;
    assert.equal(partial.start, new Date(2026, 2, 25, 14).toISOString());
    assert.equal(partial.end, tailStartedAt.toISOString(), "ends where the tail begins");
  });

  it("serves the straddling hour's turns when it has no memory at all", async () => {
    const mind = `${PREFIX}tailraw`;
    await insertSummary(mind, "turn", "t1", "EARLY", { createdAt: at(2026, 3, 25, 13, 5) });
    await insertSummary(mind, "turn", "t2", "LATER", { createdAt: at(2026, 3, 25, 13, 20) });
    const entries = await getRecollection(mind, new Date(2026, 2, 25, 14, 3), {
      tailStartedAt: new Date(2026, 2, 25, 13, 28),
    });
    assert.deepEqual(
      entries.map((e) => [e.period_key, e.content, e.author, e.end]),
      [["2026-03-25T13", "EARLY\n\nLATER", "record", new Date(2026, 2, 25, 13, 28).toISOString()]],
    );
  });

  it("places a summary written after the tail by when its turn ended", async () => {
    const mind = `${PREFIX}taillag`;
    const t = (h: number, mi: number, sec: number) =>
      utcDateTimeStr(new Date(2026, 2, 25, h, mi, sec));
    // Ended 14:39:58, summarized 14:40:04 — after the 14:40:01 tail began, yet not in it.
    await insertSummary(mind, "turn", "ended-before", "ENDED BEFORE", {
      createdAt: t(14, 40, 4),
      metadata: { to_time: t(14, 39, 58) },
    });
    // A slow summary written past the tail's hour, for a turn that ended before the tail: served
    // in the tail's hour, the last one recollection tells.
    await insertSummary(mind, "turn", "slow", "SLOW SUMMARY", {
      createdAt: t(15, 0, 2),
      metadata: { to_time: t(14, 35, 0) },
    });
    await insertSummary(mind, "turn", "in-tail", "IN TAIL", {
      createdAt: t(14, 41, 0),
      metadata: { to_time: t(14, 40, 50) },
    });
    await insertSummary(mind, "turn", "mind-authored", "NO TURN TIME", { createdAt: t(14, 45, 0) });
    const entries = await getRecollection(mind, before, {
      tailStartedAt: new Date(2026, 2, 25, 14, 40, 1),
    });
    assert.deepEqual(
      entries.map((e) => [e.period_key, e.content]),
      [["2026-03-25T14", "ENDED BEFORE\n\nSLOW SUMMARY"]],
    );
  });

  it("a tail starting on the hour leaves nothing of that hour to serve", async () => {
    const mind = `${PREFIX}tailtop`;
    await insertSummary(mind, "hour", "2026-03-25T13", "ONE PM");
    await insertSummary(mind, "hour", "2026-03-25T14", "TWO PM");
    await insertSummary(mind, "turn", "t", "AT TAIL", { createdAt: at(2026, 3, 25, 14, 0) });
    const entries = await getRecollection(mind, before, {
      tailStartedAt: new Date(2026, 2, 25, 14, 0),
    });
    assert.deepEqual(keys(entries), ["2026-03-25T13"]);
  });

  it("a restart the next morning serves the tail's day as its hours before the tail", async () => {
    const mind = `${PREFIX}morning`;
    await seed(mind);
    await insertSummary(mind, "day", "2026-03-25", "WEDNESDAY");
    await insertSummary(mind, "turn", "t14", "BEFORE TAIL", { createdAt: at(2026, 3, 25, 14, 10) });
    await insertSummary(mind, "turn", "t15", "IN TAIL", { createdAt: at(2026, 3, 25, 15, 10) });
    await insertSummary(mind, "turn", "t26", "NEXT DAY", { createdAt: at(2026, 3, 26, 8, 10) });
    const entries = await getRecollection(mind, new Date(2026, 2, 26, 9, 0), {
      tailStartedAt: new Date(2026, 2, 25, 14, 40),
    });
    // Wednesday overlaps the tail, so its day memory would retell it — its hours instead, right
    // up to the tail.
    assert.deepEqual(keys(entries), [
      "2026-W12",
      "2026-03-23",
      "2026-03-24",
      "2026-03-25T09",
      "2026-03-25T13",
      "2026-03-25T14",
    ]);
    assert.equal(entries.at(-1)!.content, "BEFORE TAIL");
  });

  it("a tail starting in the day's last hour reaches it across midnight", async () => {
    const mind = `${PREFIX}tailmidnight`;
    await insertSummary(mind, "turn", "late", "LATE", { createdAt: at(2026, 3, 25, 23, 20) });
    await insertSummary(mind, "turn", "tail", "IN TAIL", { createdAt: at(2026, 3, 26, 0, 1) });
    const entries = await getRecollection(mind, new Date(2026, 2, 26, 0, 3), {
      tailStartedAt: new Date(2026, 2, 25, 23, 45),
    });
    assert.deepEqual(
      entries.map((e) => [e.period_key, e.content]),
      [["2026-03-25T23", "LATE"]],
    );
  });

  it("just past midnight, a day not yet rolled up is served as its hours", async () => {
    const mind = `${PREFIX}midnight`;
    await seed(mind);
    await insertSummary(mind, "turn", "late", "I stayed up.", {
      createdAt: at(2026, 3, 25, 23, 20),
    });
    const entries = await getRecollection(mind, new Date(2026, 2, 26, 0, 3));
    assert.deepEqual(
      entries.map((e) => [e.period_key, e.author]),
      [
        ["2026-W12", "consolidation"],
        ["2026-03-23", "mind"],
        ["2026-03-24", "consolidation"],
        ["2026-03-25T09", "consolidation"],
        ["2026-03-25T13", "consolidation"],
        ["2026-03-25T15", "consolidation"],
        ["2026-03-25T23", "record"],
      ],
    );
  });

  it("covers every day since last week, whatever the weekday", async () => {
    const mind = `${PREFIX}weekdays`;
    await insertSummary(mind, "week", "2026-W12", "LAST WEEK");
    for (let d = 23; d <= 29; d++) await insertSummary(mind, "day", `2026-03-${d}`, `DAY ${d}`);
    for (let d = 23; d <= 29; d++) {
      const entries = await getRecollection(mind, new Date(2026, 2, d, 12, 0));
      const expected = ["2026-W12"];
      for (let prev = 23; prev < d; prev++) expected.push(`2026-03-${prev}`);
      assert.deepEqual(keys(entries), expected, `on the ${d}th`);
    }
  });

  it("with last week not rolled up yet, its days stand in for it", async () => {
    const mind = `${PREFIX}noweek`;
    await insertSummary(mind, "day", "2026-03-20", "FRIDAY");
    await insertSummary(mind, "day", "2026-03-22", "SUNDAY");
    const entries = await getRecollection(mind, new Date(2026, 2, 23, 0, 3));
    assert.deepEqual(keys(entries), ["2026-03-20", "2026-03-22"]);
  });

  it("doesn't repeat days already inside the returned week", async () => {
    const mind = `${PREFIX}overlap`;
    await seed(mind);
    // Tuesday: the two days before are Sunday (in last week) and Monday (this week).
    const tuesday = await getRecollection(mind, new Date(2026, 2, 24, 10, 0));
    assert.deepEqual(keys(tuesday), ["2026-W12", "2026-03-23"]);
    // Monday: both prior days sit inside last week.
    const monday = await getRecollection(mind, new Date(2026, 2, 23, 10, 0));
    assert.deepEqual(keys(monday), ["2026-W12"]);
  });

  it("labels a deterministic placeholder as the record, not as the mind's memory", async () => {
    const mind = `${PREFIX}placeholder`;
    await insertSummary(mind, "day", "2026-03-24", "Activity on 2026-03-24: I did things.", {
      metadata: { deterministic: true },
    });
    await insertSummary(mind, "hour", "2026-03-25T09", "Activity during 09:00: I read.", {
      metadata: { deterministic: true, attempts: 1 },
    });
    const entries = await getRecollection(mind, before);
    assert.deepEqual(
      entries.map((e) => [e.period_key, e.author]),
      [
        ["2026-03-24", "record"],
        ["2026-03-25T09", "record"],
      ],
    );
  });

  it("serves a completed hour with no memory yet as its raw turn summaries, read-only", async () => {
    const mind = `${PREFIX}raw`;
    await insertSummary(mind, "turn", "t1", "I read.", { createdAt: at(2026, 3, 25, 11, 5) });
    await insertSummary(mind, "turn", "t2", "I wrote.", { createdAt: at(2026, 3, 25, 11, 40) });
    await insertSummary(mind, "turn", "t3", "Now.", { createdAt: at(2026, 3, 25, 15, 5) });
    const entries = await getRecollection(mind, before);
    assert.deepEqual(
      entries.map((e) => [e.period_key, e.content, e.author]),
      [["2026-03-25T11", "I read.\n\nI wrote.", "record"]],
    );
    assert.equal(await getRow(mind, "hour", "2026-03-25T11"), undefined);
  });

  it("never reaches past now, whatever `before` says", async () => {
    const mind = `${PREFIX}future`;
    const now = new Date();
    await insertSummary(mind, "turn", "t-now", "HAPPENING NOW", {
      createdAt: utcDateTimeStr(new Date(now.getTime() - 60_000)),
    });
    const currentHour = getPeriodKey(now, "hour");
    await insertSummary(mind, "hour", currentHour, "PREMATURE HOUR");
    const entries = await getRecollection(mind, new Date(now.getTime() + 2 * 3600_000));
    assert.ok(!entries.some((e) => e.period_key === currentHour), JSON.stringify(entries));
    assert.ok(!entries.some((e) => e.content.includes("HAPPENING NOW")));
  });

  it("files a turn under the hour its row was written in, in the order the turns began", async () => {
    const mind = `${PREFIX}turntime`;
    const t = (h: number, mi: number) => at(2026, 3, 25, h, mi);
    // Ended 10:59, summarized 11:00 — filed under 11:00, as the hour rollup files it.
    await insertSummary(mind, "turn", "ten", "ENDED AT TEN", {
      createdAt: t(11, 0),
      metadata: { from_time: t(10, 50), to_time: t(10, 59) },
    });
    // Written out of order: the later turn's summary landed first.
    await insertSummary(mind, "turn", "second", "SECOND", {
      createdAt: t(11, 30),
      metadata: { from_time: t(11, 20), to_time: t(11, 25) },
    });
    await insertSummary(mind, "turn", "first", "FIRST", {
      createdAt: t(11, 35),
      metadata: { from_time: t(11, 5), to_time: t(11, 10) },
    });
    const expected = [["2026-03-25T11", "ENDED AT TEN\n\nFIRST\n\nSECOND"]];
    const entries = await getRecollection(mind, before);
    assert.deepEqual(
      entries.map((e) => [e.period_key, e.content]),
      expected,
    );
    // With the tail starting at 11:30 (SECOND written right at it), the same turns are the record up to it.
    const tailed = await getRecollection(mind, before, {
      tailStartedAt: new Date(2026, 2, 25, 11, 30),
    });
    assert.deepEqual(
      tailed.map((e) => [e.period_key, e.content]),
      expected,
    );
  });

  it("bounds every entry, the raw fallback included", async () => {
    const mind = `${PREFIX}big`;
    await insertSummary(mind, "day", "2026-03-24", "d".repeat(50_000));
    for (let i = 0; i < 30; i++) {
      await insertSummary(mind, "turn", `t${i}`, i === 29 ? "LAST TURN" : "t".repeat(1000), {
        createdAt: at(2026, 3, 25, 10, i),
      });
    }
    const entries = await getRecollection(mind, before);
    assert.equal(entries.length, 2);
    assert.ok(entries[0].content.length <= 4100, `day was ${entries[0].content.length}`);
    assert.ok(entries[1].content.length <= 1600, `hour was ${entries[1].content.length}`);
    // Bounded around a marked gap, so the hour's end — where the tail picks up — survives.
    assert.ok(entries[1].content.includes("LAST TURN"));
  });
});

describe("summarizePeriod guards", () => {
  it("never writes a memory for a period still in progress", async () => {
    const mind = `${PREFIX}inprogress`;
    const now = new Date();
    await insertSummary(mind, "turn", "a", "one", {
      createdAt: utcDateTimeStr(new Date(now.getTime() - 1000)),
    });
    const { calls, complete } = capture();
    assert.equal(await summarizePeriod(mind, "hour", getPeriodKey(now, "hour"), complete), false);
    assert.equal(await summarizePeriod(mind, "day", getPeriodKey(now, "day"), complete), false);
    assert.equal(calls.length, 0);
  });

  it("joins a call already in flight for the same period instead of paying twice", async () => {
    const mind = `${PREFIX}inflight`;
    await insertSummary(mind, "hour", "2026-03-20T09", "Morning.");
    await insertSummary(mind, "hour", "2026-03-20T14", "Afternoon.");
    let calls = 0;
    const slow = async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 20));
      return { status: "ok" as const, text: "once" };
    };
    const [a, b] = await Promise.all([
      summarizePeriod(mind, "day", "2026-03-20", slow),
      summarizePeriod(mind, "day", "2026-03-20", slow),
    ]);
    assert.equal(calls, 1);
    assert.deepEqual([a, b], [true, true]);
  });

  it("a failed hour is retried later instead of staying deterministic forever", async () => {
    const mind = `${PREFIX}retry`;
    await insertSummary(mind, "turn", "a", "one", { createdAt: at(2026, 3, 20, 9, 5) });
    await insertSummary(mind, "turn", "b", "two", { createdAt: at(2026, 3, 20, 9, 30) });
    await summarizePeriod(mind, "hour", "2026-03-20T09", async () => ({ status: "failed" }));
    const failed = JSON.parse((await getRow(mind, "hour", "2026-03-20T09"))!.metadata!);
    assert.equal(failed.deterministic, true);
    assert.equal(failed.attempts, 1);
    // Past the backoff, the repair sweep heals it.
    const db = await getDb();
    await db
      .update(summaries)
      .set({ metadata: JSON.stringify({ ...failed, last_attempt_at: "2026-01-01T00:00:00Z" }) })
      .where(and(eq(summaries.mind, mind), eq(summaries.period_key, "2026-03-20T09")));
    await repairProvisionalSummaries(async () => ({ status: "ok", text: "HEALED" }));
    assert.equal((await getRow(mind, "hour", "2026-03-20T09"))!.content, "HEALED");
  });

  it("a healed hour sends its day, built from the placeholder, to be rebuilt", async () => {
    const mind = `${PREFIX}propagate`;
    await insertSummary(mind, "turn", "a", "one", { createdAt: at(2026, 3, 20, 9, 5) });
    await insertSummary(mind, "turn", "b", "two", { createdAt: at(2026, 3, 20, 9, 30) });
    await summarizePeriod(mind, "hour", "2026-03-20T09", async () => ({ status: "failed" }));
    await insertSummary(mind, "hour", "2026-03-20T14", "Afternoon.");
    await summarizePeriod(mind, "day", "2026-03-20", async () => ({
      status: "ok",
      text: "DAY V1",
    }));
    const hour = await getRow(mind, "hour", "2026-03-20T09");
    const db = await getDb();
    await db
      .update(summaries)
      .set({
        metadata: JSON.stringify({
          ...JSON.parse(hour!.metadata!),
          last_attempt_at: "2026-01-01T00:00:00Z",
        }),
      })
      .where(eq(summaries.id, hour!.id));

    const inputs: string[] = [];
    const heal = async (_s: string, user: string) => {
      inputs.push(user);
      return { status: "ok" as const, text: inputs.length === 1 ? "HEALED HOUR" : "DAY V2" };
    };
    await repairProvisionalSummaries(heal); // heals the hour, flags the day
    assert.equal(JSON.parse((await getRow(mind, "day", "2026-03-20"))!.metadata!).rebuild, true);
    await repairProvisionalSummaries(heal); // rebuilds the day from the healed hour
    const day = await getRow(mind, "day", "2026-03-20");
    assert.equal(day!.content, "DAY V2");
    assert.ok(inputs[1].includes("HEALED HOUR"), inputs[1]);
    assert.equal(JSON.parse(day!.metadata!).rebuild, undefined);
  });

  it("a stuck tick stops blocking the next one once it's stale", async () => {
    const s = new Summarizer() as unknown as {
      tickStartedAt: number | null;
      hasBackfilled: boolean;
      tick: () => Promise<void>;
    };
    s.tickStartedAt = Date.now();
    await s.tick();
    assert.equal(s.hasBackfilled, false, "a fresh tick in progress blocks the next");
    s.tickStartedAt = Date.now() - TICK_STALE_MS - 1;
    await s.tick();
    assert.equal(s.hasBackfilled, true, "a stale one doesn't");
    assert.equal(s.tickStartedAt, null);
  });

  it("a basic-mode deterministic hour is the record, not a backlog to bill later", async () => {
    const mind = `${PREFIX}basic`;
    await insertSummary(mind, "turn", "a", "one", { createdAt: at(2026, 3, 20, 9, 5) });
    await insertSummary(mind, "turn", "b", "two", { createdAt: at(2026, 3, 20, 9, 30) });
    await summarizePeriod(mind, "hour", "2026-03-20T09", async () => ({ status: "unconfigured" }));
    let called = false;
    await repairProvisionalSummaries(async () => {
      called = true;
      return { status: "ok", text: "X" };
    });
    assert.equal(called, false);
  });
});

describe("recollection endpoint", () => {
  async function cookie(mind: string) {
    const user = await getOrCreateMindUser(mind);
    const sid = await createSession(user.id);
    sessions.push(sid);
    return `volute_session=${sid}`;
  }

  it("serves a mind its own recollection", async () => {
    const { default: app } = await import("../packages/daemon/src/web/app.js");
    const mind = `${PREFIX}api`;
    await addMind(mind, 4990);
    await insertSummary(mind, "day", "2026-03-24", "TUESDAY");
    const res = await app.request(
      `/api/v1/minds/${mind}/history/recollection?before=${new Date(2026, 2, 25, 15, 30).toISOString()}`,
      { headers: { Cookie: await cookie(mind) } },
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as { entries: { content: string }[] };
    assert.deepEqual(
      body.entries.map((e) => e.content),
      ["TUESDAY"],
    );
  });

  it("refuses another mind's recollection", async () => {
    const { default: app } = await import("../packages/daemon/src/web/app.js");
    const res = await app.request(
      `/api/v1/minds/${PREFIX}bob/history/recollection?before=${new Date().toISOString()}`,
      { headers: { Cookie: await cookie(`${PREFIX}alice`) } },
    );
    assert.equal(res.status, 403);
  });

  it("404s an unknown mind", async () => {
    const { default: app } = await import("../packages/daemon/src/web/app.js");
    const mind = `${PREFIX}ghost`;
    const res = await app.request(
      `/api/v1/minds/${mind}/history/recollection?before=${new Date().toISOString()}`,
      { headers: { Cookie: await cookie(mind) } },
    );
    assert.equal(res.status, 404);
  });

  it("rejects a missing or malformed timestamp", async () => {
    const { default: app } = await import("../packages/daemon/src/web/app.js");
    const mind = `${PREFIX}api-bad`;
    await addMind(mind, 4991);
    const headers = { Cookie: await cookie(mind) };
    const base = `/api/v1/minds/${mind}/history/recollection`;
    assert.equal((await app.request(base, { headers })).status, 400);
    assert.equal((await app.request(`${base}?before=nope`, { headers })).status, 400);
    assert.equal(
      (
        await app.request(`${base}?before=${new Date().toISOString()}&tailStartedAt=nope`, {
          headers,
        })
      ).status,
      400,
    );
  });
});

describe("pre_sleep", () => {
  it("no longer asks the mind to rewrite its history before sleeping", () => {
    assert.doesNotMatch(PROMPT_DEFAULTS.pre_sleep.content, /--write|--provisional/);
  });
});
