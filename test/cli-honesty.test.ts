import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { eq, sql } from "drizzle-orm";
import { assertReadLimit, pagingFooter } from "../packages/cli/src/commands/chat/read.js";
import { assertContactsHours } from "../packages/cli/src/commands/mind-contacts.js";
import {
  applyHistoryQuery,
  assertHistoryLimit,
  buildPeriodQueries,
  formatRowCompact,
  type HistoryRow,
} from "../packages/cli/src/commands/mind-history.js";
import { command } from "../packages/cli/src/lib/command.js";
import { extractMindFlag } from "../packages/cli/src/lib/extension-mind-flag.js";
import type { FlagDef } from "../packages/cli/src/lib/parse-args.js";
import { enforceArity, parseArgs } from "../packages/cli/src/lib/parse-args.js";
import { createUser } from "../packages/daemon/src/lib/auth.js";
import { getDb } from "../packages/daemon/src/lib/db.js";
import { resolveActingMind } from "../packages/daemon/src/lib/extensions.js";
import { mindHistory, summaries, turns, users } from "../packages/daemon/src/lib/schema.js";
import { createSession, deleteSession } from "../packages/daemon/src/web/middleware/auth.js";

/**
 * #907, #876, and the bardo triage rows behind them: four places where the CLI accepted
 * something it could not honour and returned plausible output anyway. Each test below
 * pins the refusal, because the refusal is the only artifact the caller ever gets.
 */

/** Run `fn`, capturing stderr and the process.exit code instead of exiting. */
async function captureRefusal(fn: () => unknown | Promise<unknown>): Promise<{
  exitCode: number | undefined;
  stderr: string;
  stdout: string;
}> {
  const errors: string[] = [];
  const logs: string[] = [];
  const origError = console.error;
  const origLog = console.log;
  let exitCode: number | undefined;
  const exitMock = mock.method(process, "exit", (code?: number) => {
    exitCode = code;
    throw new Error("__exit__");
  });
  console.error = (...a: unknown[]) => errors.push(a.join(" "));
  console.log = (...a: unknown[]) => logs.push(a.join(" "));
  try {
    await fn();
  } catch (err) {
    if ((err as Error).message !== "__exit__") throw err;
  } finally {
    console.error = origError;
    console.log = origLog;
    exitMock.mock.restore();
  }
  return { exitCode, stderr: errors.join("\n"), stdout: logs.join("\n") };
}

// ── A. Unknown flags and unexpected positionals ──────────────────────────────

describe("parseArgs strictness (#907)", () => {
  afterEach(() => mock.restoreAll());

  it("refuses an unknown option instead of dropping it", async () => {
    const r = await captureRefusal(() =>
      parseArgs(["--not-a-real-flag-at-all"], { all: { type: "boolean" } }),
    );
    assert.equal(r.exitCode, 1);
    assert.match(r.stderr, /unknown option: --not-a-real-flag-at-all/);
  });

  it("names the options that do exist, so the caller can find the right one", async () => {
    const r = await captureRefusal(() =>
      parseArgs(["--mind", "pip"], { all: { type: "boolean" }, shared: { type: "boolean" } }),
    );
    assert.equal(r.exitCode, 1);
    assert.match(r.stderr, /known options: --all, --shared/);
  });

  it("refuses a value-taking flag with nothing to consume", async () => {
    const r = await captureRefusal(() => parseArgs(["--name"], { name: { type: "string" } }));
    assert.equal(r.exitCode, 1);
    assert.match(r.stderr, /--name requires a value/);
  });

  it("accepts --flag=value so strictness never mislabels a real flag", () => {
    const r = parseArgs(["--name=bardo", "--json"], {
      name: { type: "string" },
      json: { type: "boolean" },
    });
    assert.equal(r.flags.name, "bardo");
    assert.equal(r.flags.json, true);
  });

  it("refuses a value attached to a boolean flag", async () => {
    const r = await captureRefusal(() => parseArgs(["--json=yes"], { json: { type: "boolean" } }));
    assert.equal(r.exitCode, 1);
    assert.match(r.stderr, /--json is a flag and takes no value/);
  });

  // #868 CLI-side: parseInt salvages a leading numeric prefix, so a timestamp passed
  // where an id belongs became a plausible id and served the wrong page with a 200.
  it("refuses a timestamp where a number is expected, rather than reading 2026 out of it", async () => {
    const r = await captureRefusal(() =>
      parseArgs(["--before", "2026-08-12"], { before: { type: "number" } }),
    );
    assert.equal(r.exitCode, 1);
    assert.match(r.stderr, /--before expects a number, got: 2026-08-12/);
  });

  it("still parses a well-formed number flag", () => {
    const r = parseArgs(["--before", "41207"], { before: { type: "number" } });
    assert.equal(r.flags.before, 41207);
  });
});

describe("enforceArity (#907)", () => {
  afterEach(() => mock.restoreAll());

  it("refuses a positional the command never declared", async () => {
    const r = await captureRefusal(() => enforceArity(["gardener"], []));
    assert.equal(r.exitCode, 1);
    assert.match(r.stderr, /unknown argument: gardener/);
  });

  it("refuses the first extra positional past the declared slots", async () => {
    const r = await captureRefusal(() =>
      enforceArity(
        ["title", "body", "surplus"],
        [{ name: "title", required: true }, { name: "content" }],
      ),
    );
    assert.equal(r.exitCode, 1);
    assert.match(r.stderr, /unknown argument: surplus/);
    assert.match(r.stderr, /<title> \[content\]/);
  });

  it("allows exactly the declared positionals", () => {
    enforceArity(["title", "body"], [{ name: "title", required: true }, { name: "content" }]);
  });
});

describe("command() refuses what it cannot honour (#907)", () => {
  afterEach(() => mock.restoreAll());

  it("does not run the handler when an unknown flag is passed", async () => {
    let ran = false;
    const cmd = command({
      name: "volute pages list",
      description: "List pages",
      flags: { all: { type: "boolean", description: "All minds' pages" } },
      run: async () => {
        ran = true;
      },
    });
    const r = await captureRefusal(() => cmd.execute(["--not-a-real-flag"]));
    assert.equal(ran, false, "handler must not run on a refused invocation");
    assert.equal(r.exitCode, 1);
    assert.match(r.stderr, /unknown option: --not-a-real-flag/);
  });

  it("does not run the handler when an extra positional is passed", async () => {
    let ran = false;
    const cmd = command({
      name: "volute pages list",
      description: "List pages",
      flags: { all: { type: "boolean", description: "All minds' pages" } },
      run: async () => {
        ran = true;
      },
    });
    const r = await captureRefusal(() => cmd.execute(["gardener"]));
    assert.equal(ran, false);
    assert.equal(r.exitCode, 1);
    assert.match(r.stderr, /unknown argument: gardener/);
  });

  it("still runs on a valid invocation", async () => {
    let seen: string | undefined;
    const cmd = command({
      name: "volute pages read",
      description: "Read a page",
      args: [{ name: "ref", required: true, description: "Page reference" }],
      flags: { mind: { type: "string", description: "Mind name" } },
      run: async ({ args }) => {
        seen = args.ref;
      },
    });
    await cmd.execute(["mimsy/notes/the-tideline.md", "--mind", "mimsy"]);
    assert.equal(seen, "mimsy/notes/the-tideline.md");
  });
});

/**
 * The extension dispatch in `src/cli.ts` validates against the metadata the daemon serves
 * over `/api/v1/extensions/commands`, using these same two helpers. This pins the join:
 * the metadata carries enough to refuse, and the real `pages list` declares no positional
 * and no `--mind`, which is what made `volute pages list gardener` and
 * `volute pages list --not-a-real-flag` both print the caller's own list.
 */
describe("extension command metadata is strict enough to refuse (#907)", () => {
  afterEach(() => mock.restoreAll());

  it("refuses an invented flag against the served metadata for `pages list`", async () => {
    const { toCommandInfo } = await import("../packages/daemon/src/lib/extensions.js");
    const { createCommands } = await import("../packages/extensions/pages/src/commands.js");
    const list = toCommandInfo(createCommands().list);
    const r = await captureRefusal(() =>
      parseArgs(["--not-a-real-flag-at-all"], (list.flags ?? {}) as Record<string, FlagDef>),
    );
    assert.equal(r.exitCode, 1);
    assert.match(r.stderr, /unknown option: --not-a-real-flag-at-all/);
  });

  it("refuses a stray positional against the served metadata for `pages list`", async () => {
    const { toCommandInfo } = await import("../packages/daemon/src/lib/extensions.js");
    const { createCommands } = await import("../packages/extensions/pages/src/commands.js");
    const list = toCommandInfo(createCommands().list);
    const r = await captureRefusal(() => enforceArity(["gardener"], list.args ?? []));
    assert.equal(r.exitCode, 1);
    assert.match(r.stderr, /unknown argument: gardener/);
  });
});

describe("extractMindFlag — the extension layer's global --mind (#907)", () => {
  afterEach(() => {
    mock.restoreAll();
    process.env.VOLUTE_MIND = undefined;
    delete process.env.VOLUTE_MIND;
  });

  it("lifts --mind out of argv so strict validation never calls it unknown", () => {
    assert.deepEqual(
      extractMindFlag(["--mind", "gardener", "--all"], { all: { type: "boolean" } }),
      {
        mind: "gardener",
        rest: ["--all"],
      },
    );
  });

  it("handles the --mind=value spelling", () => {
    assert.deepEqual(extractMindFlag(["--mind=gardener", "--all"], { all: { type: "boolean" } }), {
      mind: "gardener",
      rest: ["--all"],
    });
  });

  it("refuses a trailing --mind rather than reporting a documented flag as unknown", () => {
    const result = extractMindFlag(["--mind"], {});
    assert.ok("error" in result);
    assert.match(result.error, /--mind requires a value/);
  });

  // The intentions extension declares `list --mind <name>` ("show another mind's active
  // intentions"). Hoisting that would make its own declared, --help-advertised flag
  // permanently unreachable — a second way to advertise something that cannot work.
  it("leaves --mind in argv when the subcommand declares a mind flag of its own", () => {
    assert.deepEqual(extractMindFlag(["--mind", "gardener"], { mind: { type: "string" } }), {
      mind: undefined,
      rest: ["--mind", "gardener"],
    });
  });

  it("falls back to VOLUTE_MIND when no --mind is given", () => {
    process.env.VOLUTE_MIND = "mimsy";
    assert.deepEqual(extractMindFlag(["--all"], { all: { type: "boolean" } }), {
      mind: "mimsy",
      rest: ["--all"],
    });
  });
});

// ── B. Identity selection refuses instead of substituting ────────────────────

describe("resolveActingMind (#907)", () => {
  it("refuses when an unprivileged caller asks to act as another mind", () => {
    const result = resolveActingMind({ username: "mimsy", role: "user" }, "gardener");
    assert.ok("error" in result, "must refuse, not substitute the caller");
    assert.match(result.error, /cannot act as 'gardener'/);
    // Both halves of the fact: what was refused, and who you actually are.
    assert.match(result.error, /You are 'mimsy'/);
  });

  it("never silently hands the caller its own identity in place of the requested one", () => {
    const result = resolveActingMind({ username: "mimsy", role: "user" }, "pip");
    assert.equal("mind" in result, false);
  });

  it("allows a mind to name itself", () => {
    const result = resolveActingMind({ username: "mimsy", role: "user" }, "mimsy");
    assert.deepEqual(result, { mind: "mimsy" });
  });

  it("defaults to the caller when no identity is requested", () => {
    assert.deepEqual(resolveActingMind({ username: "mimsy", role: "user" }, undefined), {
      mind: "mimsy",
    });
  });

  it("lets admins and the spirit act as another mind", () => {
    assert.deepEqual(resolveActingMind({ username: "james", role: "admin" }, "gardener"), {
      mind: "gardener",
    });
    assert.deepEqual(resolveActingMind({ username: "volute", role: "spirit" }, "gardener"), {
      mind: "gardener",
    });
  });
});

// ── C. mind history --from/--to are honoured server-side ─────────────────────

const HISTORY_MIND = "test-honesty-mind";
const HISTORY_ADMIN = "test-honesty-admin";
let historySession: string | undefined;

async function historyCleanup() {
  const db = await getDb();
  await db.delete(users).where(eq(users.username, HISTORY_ADMIN));
  await db.delete(summaries).where(sql`mind LIKE 'test-honesty-%'`);
  await db.delete(turns).where(sql`mind LIKE 'test-honesty-%'`);
  await db.delete(mindHistory).where(sql`mind LIKE 'test-honesty-%'`);
}

describe("GET /api/v1/minds/:name/history — from/to (bardo triage P2 row 8)", () => {
  beforeEach(historyCleanup);
  afterEach(async () => {
    if (historySession) deleteSession(historySession);
    historySession = undefined;
    await historyCleanup();
  });

  async function seed() {
    const db = await getDb();
    for (const [day, content] of [
      ["2026-08-14 09:00:00", "older"],
      ["2026-08-20 09:00:00", "wanted-morning"],
      ["2026-08-20 22:30:00", "wanted-evening"],
      ["2026-08-25 09:00:00", "newer"],
    ] as const) {
      await db.insert(mindHistory).values({
        mind: HISTORY_MIND,
        type: "inbound",
        channel: "#bardo",
        sender: "someone",
        content,
        created_at: day,
      });
    }
    const user = await createUser(HISTORY_ADMIN, "pass");
    historySession = await createSession(user.id);
    return historySession;
  }

  it("returns only rows inside the window, including the whole of the --to day", async () => {
    const cookie = await seed();
    const { default: app } = await import("../packages/daemon/src/web/app.js");
    const res = await app.request(
      `/api/v1/minds/${HISTORY_MIND}/history?full=true&from=2026-08-20&to=2026-08-20`,
      { headers: { Cookie: `volute_session=${cookie}` } },
    );
    assert.equal(res.status, 200);
    const rows = (await res.json()) as { content: string }[];
    const contents = rows.map((r) => r.content).sort();
    // A bare --to date must include that day's last message, not stop at 00:00:00.
    assert.deepEqual(contents, ["wanted-evening", "wanted-morning"]);
  });

  it("honours an open-ended --from", async () => {
    const cookie = await seed();
    const { default: app } = await import("../packages/daemon/src/web/app.js");
    const res = await app.request(
      `/api/v1/minds/${HISTORY_MIND}/history?full=true&from=2026-08-21`,
      { headers: { Cookie: `volute_session=${cookie}` } },
    );
    const rows = (await res.json()) as { content: string }[];
    assert.deepEqual(
      rows.map((r) => r.content),
      ["newer"],
    );
  });

  it("accepts a full timestamp bound", async () => {
    const cookie = await seed();
    const { default: app } = await import("../packages/daemon/src/web/app.js");
    const res = await app.request(
      `/api/v1/minds/${HISTORY_MIND}/history?full=true&from=2026-08-20 12:00:00&to=2026-08-24`,
      { headers: { Cookie: `volute_session=${cookie}` } },
    );
    const rows = (await res.json()) as { content: string }[];
    assert.deepEqual(
      rows.map((r) => r.content),
      ["wanted-evening"],
    );
  });

  // A bound the server cannot parse must not be dropped — that is the original bug in a
  // new costume: a bounded request answered as an unbounded one.
  it("refuses an unparseable bound rather than ignoring it", async () => {
    const cookie = await seed();
    const { default: app } = await import("../packages/daemon/src/web/app.js");
    const res = await app.request(
      `/api/v1/minds/${HISTORY_MIND}/history?full=true&from=last%20tuesday`,
      { headers: { Cookie: `volute_session=${cookie}` } },
    );
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /Invalid from date/);
  });

  it("filters turn summaries by the same window", async () => {
    const db = await getDb();
    await db.insert(summaries).values([
      {
        mind: HISTORY_MIND,
        period: "turn",
        period_key: "turn-old",
        content: "old summary",
        created_at: "2026-08-14 09:00:00",
      },
      {
        mind: HISTORY_MIND,
        period: "turn",
        period_key: "turn-new",
        content: "new summary",
        created_at: "2026-08-20 09:00:00",
      },
    ]);
    const user = await createUser(HISTORY_ADMIN, "pass");
    historySession = await createSession(user.id);
    const { default: app } = await import("../packages/daemon/src/web/app.js");
    const res = await app.request(
      `/api/v1/minds/${HISTORY_MIND}/history?from=2026-08-20&to=2026-08-20`,
      { headers: { Cookie: `volute_session=${historySession}` } },
    );
    assert.equal(res.status, 200);
    const rows = (await res.json()) as { content: string }[];
    assert.deepEqual(
      rows.map((r) => r.content),
      ["new summary"],
    );
  });
});

// ── C2. mind history compact rows carry their date (#876) ───────────────────

describe("mind history compact rows carry a date (#876)", () => {
  const row = (over: Partial<HistoryRow> = {}): HistoryRow => ({
    type: "inbound",
    channel: "#bardo",
    thread: null,
    sender: "gardener",
    sender_display_name: null,
    content: "morning",
    metadata: null,
    turn_id: null,
    created_at: "2026-08-20 09:05:00",
    ...over,
  });

  // Compact mode is always on for a mind, so a multi-day window rendered as bare
  // [HH:MM] read as one afternoon — and a line quoted out of it into memory or a page
  // silently lost its day.
  it("renders the date alongside the time on a message row", () => {
    const line = formatRowCompact(row());
    // Format, not literal values: compactDateTime renders in the reader's local zone.
    assert.match(line, /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\] \[#bardo\] gardener: morning$/);
  });

  it("dates both ends of a summary's range, so a range crossing midnight reads true", () => {
    const line = formatRowCompact(
      row({
        type: "summary",
        content: "traced the bug",
        metadata: JSON.stringify({
          from_time: "2026-08-20 23:40:00",
          to_time: "2026-08-21 00:15:00",
        }),
      }),
    );
    assert.match(
      line,
      /\[summary \(\d{4}-\d{2}-\d{2} \d{2}:\d{2}\u2013\d{4}-\d{2}-\d{2} \d{2}:\d{2}\)\]/,
      `expected both ends of the range dated in: ${line}`,
    );
  });
});

describe("GET /api/v1/history/summaries — a bare --to covers the whole day in every tier", () => {
  beforeEach(historyCleanup);
  afterEach(async () => {
    if (historySession) deleteSession(historySession);
    historySession = undefined;
    await historyCleanup();
  });

  // Period keys are not timestamps, so the shared normalizer is the wrong tool here:
  // hour keys are "YYYY-MM-DDTHH", and "T" sorts after a space, so `--to 2026-08-20`
  // compared raw dropped that entire day's hours — a bounded request answered as if the
  // day had nothing in it. Day/month keys are prefix-compatible and were already fine.
  it("includes the hour keys of the --to day (hour tier)", async () => {
    const db = await getDb();
    await db.insert(summaries).values([
      { mind: HISTORY_MIND, period: "hour", period_key: "2026-08-20T09", content: "morning" },
      { mind: HISTORY_MIND, period: "hour", period_key: "2026-08-20T22", content: "late" },
      { mind: HISTORY_MIND, period: "hour", period_key: "2026-08-21T09", content: "next day" },
    ]);
    const user = await createUser(HISTORY_ADMIN, "pass");
    historySession = await createSession(user.id);
    const { default: app } = await import("../packages/daemon/src/web/app.js");
    const res = await app.request(
      `/api/v1/history/summaries?mind=${HISTORY_MIND}&period=hour&from=2026-08-20&to=2026-08-20`,
      { headers: { Cookie: `volute_session=${historySession}` } },
    );
    assert.equal(res.status, 200);
    const rows = (await res.json()) as { content: string }[];
    assert.deepEqual(rows.map((r) => r.content).sort(), ["late", "morning"]);
  });

  it("still bounds the day tier inclusively", async () => {
    const db = await getDb();
    await db.insert(summaries).values([
      { mind: HISTORY_MIND, period: "day", period_key: "2026-08-20", content: "wanted" },
      { mind: HISTORY_MIND, period: "day", period_key: "2026-08-21", content: "next day" },
    ]);
    const user = await createUser(HISTORY_ADMIN, "pass");
    historySession = await createSession(user.id);
    const { default: app } = await import("../packages/daemon/src/web/app.js");
    const res = await app.request(
      `/api/v1/history/summaries?mind=${HISTORY_MIND}&period=day&to=2026-08-20`,
      { headers: { Cookie: `volute_session=${historySession}` } },
    );
    const rows = (await res.json()) as { content: string }[];
    assert.deepEqual(
      rows.map((r) => r.content),
      ["wanted"],
    );
  });
});

// ── D. chat read paging footer ───────────────────────────────────────────────

describe("chat read paging footer (bardo triage P2 row 27)", () => {
  // The channel is quoted: the line is offered as copyable, and an unquoted `#system`
  // is a shell comment that strips the rest of the command before the CLI sees it —
  // the trap VOLUTE.md already warns minds about.
  it("names the oldest id and spells out the next page, shell-safe", () => {
    const footer = pagingFooter("#system", [{ id: 41207 }, { id: 41208 }], true, 100);
    assert.equal(
      footer,
      "-- older messages exist. Next page: volute chat read '#system' --limit 100 --before 41207",
    );
  });

  it("leaves an already-safe target unquoted", () => {
    const footer = pagingFooter("@gardener", [{ id: 41207 }], true, 100);
    assert.ok(footer.includes("volute chat read @gardener "), footer);
  });

  it("omits --limit when the caller did not ask for one", () => {
    const footer = pagingFooter("@gardener", [{ id: 9 }], true);
    assert.equal(
      footer,
      "-- older messages exist. Next page: volute chat read @gardener --before 9",
    );
  });

  // Claiming more history exists when the page reached the start would be its own
  // false reading — silence here is the true answer.
  it("says nothing when the page reaches the start of the conversation", () => {
    assert.equal(pagingFooter("#system", [{ id: 1 }], false), "");
  });

  it("says nothing for an empty conversation", () => {
    assert.equal(pagingFooter("#system", [], true), "");
  });
});

describe("chat read --limit refuses what the server would clamp", () => {
  afterEach(() => mock.restoreAll());

  it("accepts a limit inside the server's range", () => {
    assertReadLimit(100);
    assertReadLimit(1);
    assertReadLimit(undefined);
  });

  it("refuses a limit the server would silently reduce to 100", async () => {
    const r = await captureRefusal(() => assertReadLimit(500));
    assert.equal(r.exitCode, 1);
    assert.match(r.stderr, /--limit must be between 1 and 100 \(got 500\)/);
  });
});

describe("mind history forwards --from/--to in default mode (bardo triage P2 row 8)", () => {
  it("puts from and to on the query it actually sends", () => {
    const params = new URLSearchParams();
    applyHistoryQuery(params, { from: "2026-08-20", to: "2026-08-21", full: true });
    assert.equal(params.get("from"), "2026-08-20");
    assert.equal(params.get("to"), "2026-08-21");
    assert.equal(params.get("full"), "true");
  });

  it("omits bounds that were not asked for", () => {
    const params = new URLSearchParams();
    applyHistoryQuery(params, { limit: 10 });
    assert.equal(params.get("from"), null);
    assert.equal(params.get("to"), null);
    assert.equal(params.get("limit"), "10");
  });
});

describe("parseCommandArgs understands --flag=value (#907)", () => {
  // The CLI accepts the `=` spelling and forwards raw argv, so a daemon-side parser that
  // only understood `--flag value` would drop the value into a log line the caller never
  // sees — the same silence, one hop further in.
  it("reads a value attached with =", async () => {
    const { parseCommandArgs } = await import("../packages/daemon/src/lib/extensions.js");
    const parsed = parseCommandArgs(["--limit=5"], [], { limit: { type: "number" } });
    assert.equal(parsed.flags.limit, 5);
  });

  it("reads a string value attached with =, including one containing '='", async () => {
    const { parseCommandArgs } = await import("../packages/daemon/src/lib/extensions.js");
    const parsed = parseCommandArgs(["--page=a=b.html"], [], { page: { type: "string" } });
    assert.equal(parsed.flags.page, "a=b.html");
  });

  it("still reads the spaced spelling", async () => {
    const { parseCommandArgs } = await import("../packages/daemon/src/lib/extensions.js");
    const parsed = parseCommandArgs(["--limit", "5"], [], { limit: { type: "number" } });
    assert.equal(parsed.flags.limit, 5);
  });
});

describe("normalizeDbBound (shared by both history routes)", () => {
  it("expands a bare end date to cover the whole day", async () => {
    const { normalizeDbBound } = await import("../packages/daemon/src/lib/util/time.js");
    assert.equal(normalizeDbBound("2026-08-20", "end"), "2026-08-20 23:59:59");
    assert.equal(normalizeDbBound("2026-08-20", "start"), "2026-08-20 00:00:00");
  });

  it("accepts ISO and space-separated timestamps, with or without Z", async () => {
    const { normalizeDbBound } = await import("../packages/daemon/src/lib/util/time.js");
    assert.equal(normalizeDbBound("2026-08-20T12:30:00Z", "start"), "2026-08-20 12:30:00");
    assert.equal(normalizeDbBound("2026-08-20 12:30", "start"), "2026-08-20 12:30:00");
  });

  it("throws on anything it cannot parse, rather than returning an empty (unbounded) filter", async () => {
    const { normalizeDbBound } = await import("../packages/daemon/src/lib/util/time.js");
    assert.throws(() => normalizeDbBound("last tuesday", "start"), /Invalid from date/);
    assert.throws(() => normalizeDbBound("2026-8-2", "end"), /Invalid to date/);
  });

  it("treats an absent bound as no bound", async () => {
    const { normalizeDbBound } = await import("../packages/daemon/src/lib/util/time.js");
    assert.equal(normalizeDbBound(undefined, "start"), "");
  });
});

// ── E. Numeric flags the CLI accepted but could not honour ───────────────────
//
// Measured live against 0.59.1 with 50 rows of real history behind it:
//
//   volute mind history lyra --limit 5           -> 5 rows   (correct)
//   volute mind history lyra --limit 1e9         -> 1 row,   exit 0
//   volute mind history lyra --limit -5          -> 1 row,   exit 0
//   volute mind history lyra --limit notanumber  -> 50 rows, exit 0  (silently the default)
//
// #970 built the number validation these needed, but `--limit` was declared `type:
// "string"`, so none of it applied and the raw text went to the server, where
// `parseInt` finished the job: "1e9" is 1, "notanumber" is NaN and `|| 50` restores the
// default. Every one of those lines is real history, correctly rendered, answering a
// question nobody asked — and there is nothing in the output, the exit code, or the logs
// to catch it with.

describe("mind history --limit is a bounded number (0.59.1 integration finding)", () => {
  afterEach(() => mock.restoreAll());

  async function runHistory(argv: string[]) {
    const { run } = await import("../packages/cli/src/commands/mind-history.js");
    return captureRefusal(() => run(argv));
  }

  it("refuses --limit 1e9 instead of quietly serving one row", async () => {
    const r = await runHistory(["--mind", "lyra", "--limit", "1e9"]);
    assert.equal(r.exitCode, 1);
    assert.match(r.stderr, /--limit expects a number, got: 1e9/);
  });

  it("refuses --limit notanumber instead of quietly serving the default page", async () => {
    const r = await runHistory(["--mind", "lyra", "--limit", "notanumber"]);
    assert.equal(r.exitCode, 1);
    assert.match(r.stderr, /--limit expects a number, got: notanumber/);
  });

  it("refuses a negative --limit the server would clamp to 1", async () => {
    const r = await runHistory(["--mind", "lyra", "--limit", "-5"]);
    assert.equal(r.exitCode, 1);
    assert.match(r.stderr, /--limit must be between 1 and 200 \(got -5\)/);
  });

  it("refuses a --limit past the server's cap rather than serving 200 in silence", async () => {
    const r = await runHistory(["--mind", "lyra", "--limit", "500"]);
    assert.equal(r.exitCode, 1);
    assert.match(r.stderr, /--limit must be between 1 and 200 \(got 500\)/);
  });

  // --period reads a different route (GET /api/v1/history/summaries), which caps at the
  // same 200. The bound has to hold in both modes or the refusal is only half true.
  it("bounds --limit in --period mode too", async () => {
    const r = await runHistory(["--mind", "lyra", "--period", "day", "--limit", "500"]);
    assert.equal(r.exitCode, 1);
    assert.match(r.stderr, /--limit must be between 1 and 200 \(got 500\)/);
  });

  it("accepts a limit inside the range both routes honour", () => {
    assertHistoryLimit(1);
    assertHistoryLimit(200);
    assertHistoryLimit(undefined);
  });

  it("refuses zero, which the server would silently raise to 1", async () => {
    const r = await captureRefusal(() => assertHistoryLimit(0));
    assert.equal(r.exitCode, 1);
    assert.match(r.stderr, /--limit must be between 1 and 200 \(got 0\)/);
  });

  it("forwards the number it accepted onto the query it sends", () => {
    const params = new URLSearchParams();
    applyHistoryQuery(params, { limit: 10 });
    assert.equal(params.get("limit"), "10");
  });
});

describe("mind contacts --hours is a bounded number", () => {
  afterEach(() => mock.restoreAll());

  async function runContacts(argv: string[]) {
    const { run } = await import("../packages/cli/src/commands/mind-contacts.js");
    return captureRefusal(() => run(argv));
  }

  it("refuses --hours 1e9 instead of reporting a one-hour window", async () => {
    const r = await runContacts(["--mind", "lyra", "--hours", "1e9"]);
    assert.equal(r.exitCode, 1);
    assert.match(r.stderr, /--hours expects a number, got: 1e9/);
  });

  it("refuses --hours notanumber instead of reporting the default 48", async () => {
    const r = await runContacts(["--mind", "lyra", "--hours", "notanumber"]);
    assert.equal(r.exitCode, 1);
    assert.match(r.stderr, /--hours expects a number, got: notanumber/);
  });

  it("refuses an --hours past the server's 168-hour cap", async () => {
    const r = await runContacts(["--mind", "lyra", "--hours", "200"]);
    assert.equal(r.exitCode, 1);
    assert.match(r.stderr, /--hours must be between 1 and 168 \(got 200\)/);
  });

  it("accepts a window the server honours", () => {
    assertContactsHours(1);
    assertContactsHours(168);
    assertContactsHours(undefined);
  });
});

// ── F. The same silence one hop in: the routes themselves ────────────────────
//
// The CLI refusals above are the caller's signal, but a mind can reach these routes
// directly, and the web UI does. A malformed `limit` must not resolve to a default page:
// that is the whole defect, just without a CLI in front of it.

const LIMIT_MIND = "test-honesty-limit-mind";
const LIMIT_ADMIN = "test-honesty-limit-admin";
let limitSession: string | undefined;

async function limitCleanup() {
  const db = await getDb();
  await db.delete(users).where(eq(users.username, LIMIT_ADMIN));
  await db.delete(summaries).where(sql`mind LIKE 'test-honesty-%'`);
  await db.delete(mindHistory).where(sql`mind LIKE 'test-honesty-%'`);
}

describe("history routes refuse a malformed limit rather than defaulting", () => {
  beforeEach(limitCleanup);
  afterEach(async () => {
    if (limitSession) deleteSession(limitSession);
    limitSession = undefined;
    await limitCleanup();
  });

  async function seedRows(n: number) {
    const db = await getDb();
    for (let i = 0; i < n; i++) {
      await db.insert(mindHistory).values({
        mind: LIMIT_MIND,
        type: "inbound",
        channel: "#bardo",
        sender: "someone",
        content: `row-${i}`,
        created_at: `2026-08-20 09:${String(i).padStart(2, "0")}:00`,
      });
    }
    // createUser only grants admin to the *first* human in the table (auth.ts), so this
    // block would otherwise pass or 403 depending on whether an earlier describe cleaned
    // up its own user. Promote explicitly: these assertions are about status codes, and a
    // 403 from a "pending" role would look like a failure of the thing under test.
    const user = await createUser(LIMIT_ADMIN, "pass");
    await db.update(users).set({ role: "admin" }).where(eq(users.id, user.id));
    limitSession = await createSession(user.id);
    return limitSession;
  }

  async function historyRequest(cookie: string, query: string) {
    const { default: app } = await import("../packages/daemon/src/web/app.js");
    return app.request(`/api/v1/minds/${LIMIT_MIND}/history?full=true&${query}`, {
      headers: { Cookie: `volute_session=${cookie}` },
    });
  }

  it("400s on ?limit=1e9 instead of parsing it as 1", async () => {
    const cookie = await seedRows(6);
    const res = await historyRequest(cookie, "limit=1e9");
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /limit must be an integer between 1 and 200/);
  });

  it("400s on ?limit=notanumber instead of serving the default page", async () => {
    const cookie = await seedRows(6);
    const res = await historyRequest(cookie, "limit=notanumber");
    assert.equal(res.status, 400);
  });

  it("400s on a negative ?limit instead of clamping it to one row", async () => {
    const cookie = await seedRows(6);
    const res = await historyRequest(cookie, "limit=-5");
    assert.equal(res.status, 400);
  });

  it("400s on ?limit=0 instead of answering a request for nothing with one row", async () => {
    const cookie = await seedRows(6);
    const res = await historyRequest(cookie, "limit=0");
    assert.equal(res.status, 400);
  });

  it("400s on a malformed ?offset", async () => {
    const cookie = await seedRows(6);
    const res = await historyRequest(cookie, "offset=2026-08-12");
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /offset must be a non-negative integer/);
  });

  it("still honours a well-formed limit, and still clamps past the documented cap", async () => {
    const cookie = await seedRows(6);
    const honoured = await historyRequest(cookie, "limit=2");
    assert.equal(honoured.status, 200);
    assert.equal(((await honoured.json()) as unknown[]).length, 2);
    // Over the cap is the route's documented behaviour, not silence: the CLI refuses it
    // before a request is ever sent, so no caller reaches this by accident.
    const clamped = await historyRequest(cookie, "limit=1000");
    assert.equal(clamped.status, 200);
    assert.equal(((await clamped.json()) as unknown[]).length, 6);
  });

  it("400s on a malformed ?hours for contacts instead of reporting 48h", async () => {
    const cookie = await seedRows(2);
    const { default: app } = await import("../packages/daemon/src/web/app.js");
    const res = await app.request(`/api/v1/minds/${LIMIT_MIND}/history/contacts?hours=1e9`, {
      headers: { Cookie: `volute_session=${cookie}` },
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /hours must be an integer between 1 and 168/);
  });

  // Absent `wait` means "don't long-poll"; malformed must not resolve to the same thing.
  // `?wait=30s` used to return instantly reporting "running" (a 404 here, since the job
  // doesn't exist) with nothing to say the wait had been dropped.
  it("400s on a malformed ?wait rather than silently dropping the long-poll", async () => {
    const cookie = await seedRows(1);
    const { default: app } = await import("../packages/daemon/src/web/app.js");
    const res = await app.request(`/api/v1/minds/${LIMIT_MIND}/imagegen/jobs/nojob?wait=30s`, {
      headers: { Cookie: `volute_session=${cookie}` },
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /wait must be a non-negative integer/);
  });

  it("400s on a malformed ?limit for the summaries route", async () => {
    const cookie = await seedRows(1);
    const { default: app } = await import("../packages/daemon/src/web/app.js");
    const res = await app.request(
      `/api/v1/history/summaries?mind=${LIMIT_MIND}&period=day&limit=1e9`,
      { headers: { Cookie: `volute_session=${cookie}` } },
    );
    assert.equal(res.status, 400);
  });
});

// The shared helper behind every site above, including the ones no CLI flag reaches
// (`/history/turns`, `/history/activity`, `/:name/system-events`, `/:name/logs/tail`).
describe("boundedIntParam — the one place the salvage was happening", () => {
  it("takes the fallback when the param is absent or empty", async () => {
    const { boundedIntParam } = await import("../packages/daemon/src/lib/util/query-params.js");
    const opts = { fallback: 50, min: 1, max: 200 };
    assert.equal(boundedIntParam(undefined, opts), 50);
    assert.equal(boundedIntParam("", opts), 50);
  });

  it("refuses what parseInt would have salvaged a leading number out of", async () => {
    const { boundedIntParam } = await import("../packages/daemon/src/lib/util/query-params.js");
    const opts = { fallback: 50, min: 1, max: 200 };
    // parseInt gives 1, 2026, and 5 respectively — three plausible-looking page sizes.
    assert.equal(boundedIntParam("1e9", opts), null);
    assert.equal(boundedIntParam("2026-08-12", opts), null);
    assert.equal(boundedIntParam("5x", opts), null);
    // parseInt gives NaN here, which `|| fallback` turned back into the default.
    assert.equal(boundedIntParam("notanumber", opts), null);
    assert.equal(boundedIntParam("-5", opts), null);
  });

  it("clamps a well-formed value into the route's documented range", async () => {
    const { boundedIntParam } = await import("../packages/daemon/src/lib/util/query-params.js");
    const opts = { fallback: 50, min: 1, max: 200 };
    assert.equal(boundedIntParam("10", opts), 10);
    assert.equal(boundedIntParam("1000", opts), 200);
  });

  // A cap is published behaviour; a floor is not. Lifting `?limit=0` to 1 answers a
  // request for nothing with one plausible row — the substitution this exists to stop.
  it("refuses a value under the floor rather than quietly lifting it", async () => {
    const { boundedIntParam } = await import("../packages/daemon/src/lib/util/query-params.js");
    assert.equal(boundedIntParam("0", { fallback: 50, min: 1, max: 200 }), null);
    // offset's floor is 0, so 0 is a real answer there and stays one.
    assert.equal(boundedIntParam("0", { fallback: 0, min: 0, max: 100 }), 0);
  });
});

// ── G. The rest of the class, outside packages/daemon ────────────────────────

describe("mind history --period sends --limit to both of its routes", () => {
  it("puts the limit on the activity query as well as the summaries query", () => {
    const { summary, activity } = buildPeriodQueries("lyra", { period: "day", limit: 200 });
    assert.equal(summary.get("limit"), "200");
    // Without this, activity stopped at its own default of 100 while the flag said 200.
    assert.equal(activity.get("limit"), "200");
  });

  it("gives both queries the same window", () => {
    const { summary, activity } = buildPeriodQueries("lyra", {
      period: "day",
      from: "2026-08-20",
      to: "2026-08-21",
    });
    assert.equal(summary.get("from"), "2026-08-20");
    assert.equal(activity.get("from"), "2026-08-20");
    assert.equal(summary.get("to"), "2026-08-21");
    assert.equal(activity.get("to"), "2026-08-21");
  });

  it("sends no limit when none was asked for, leaving each route its own default", () => {
    const { summary, activity } = buildPeriodQueries("lyra", { period: "day" });
    assert.equal(summary.get("limit"), null);
    assert.equal(activity.get("limit"), null);
  });

  // Only summaries bucket by period; sending `period` to activity would filter nothing.
  it("sends period only to the route that buckets by it", () => {
    const { summary, activity } = buildPeriodQueries("lyra", { period: "week" });
    assert.equal(summary.get("period"), "week");
    assert.equal(activity.get("period"), null);
  });
});

describe("resonance search/random --limit refuses a bad bound", () => {
  afterEach(() => mock.restoreAll());

  it("refuses a non-numeric limit rather than binding NaN into LIMIT", async () => {
    const { readLimitFlag } = await import("../skills/resonance/scripts/resonance.js");
    // NaN binds as NULL, and `LIMIT NULL` is unlimited in SQLite — a typo used to return
    // the mind's entire memory store and look like a search result.
    const r = await captureRefusal(() =>
      readLimitFlag(["search", "q", "--limit", "notanumber"], 5),
    );
    assert.equal(r.exitCode, 1);
    assert.match(r.stderr, /--limit expects a positive whole number, got: notanumber/);
  });

  it("refuses 1e9 rather than silently returning one memory", async () => {
    const { readLimitFlag } = await import("../skills/resonance/scripts/resonance.js");
    const r = await captureRefusal(() => readLimitFlag(["search", "q", "--limit", "1e9"], 5));
    assert.equal(r.exitCode, 1);
    assert.match(r.stderr, /--limit expects a positive whole number, got: 1e9/);
  });

  it("refuses zero, which would return nothing and look like no matches", async () => {
    const { readLimitFlag } = await import("../skills/resonance/scripts/resonance.js");
    const r = await captureRefusal(() => readLimitFlag(["search", "q", "--limit", "0"], 5));
    assert.equal(r.exitCode, 1);
  });

  // `recall` boosts the strength of the rows it names, so a salvaged id is a write to the
  // wrong memory reported as success — the worst version of this defect in the repo.
  it("recall refuses an id it would otherwise salvage into a different memory", async () => {
    const { parseRecallIds } = await import("../skills/resonance/scripts/resonance.js");
    const r = await captureRefusal(() => parseRecallIds(["1e9"]));
    assert.equal(r.exitCode, 1);
    assert.match(r.stderr, /recall expects memory ids \(whole numbers\), got: 1e9/);
  });

  it("recall refuses a non-numeric id rather than dropping it from the list in silence", async () => {
    const { parseRecallIds } = await import("../skills/resonance/scripts/resonance.js");
    const r = await captureRefusal(() => parseRecallIds(["12", "notanumber"]));
    assert.equal(r.exitCode, 1);
  });

  it("recall reads well-formed ids", async () => {
    const { parseRecallIds } = await import("../skills/resonance/scripts/resonance.js");
    assert.deepEqual(parseRecallIds(["12", "34"]), [12, 34]);
  });

  it("reads a well-formed limit, and falls back when the flag is absent", async () => {
    const { readLimitFlag } = await import("../skills/resonance/scripts/resonance.js");
    assert.equal(readLimitFlag(["search", "q", "--limit", "20"], 5), 20);
    assert.equal(readLimitFlag(["search", "q"], 5), 5);
  });
});

describe("extension feed routes refuse a malformed limit", () => {
  async function pagesFeed(query: string) {
    const { Hono } = await import("hono");
    const { createRoutes } = await import("../packages/extensions/pages/src/routes.js");
    const { default: Database } = await import("libsql");
    const { initDb } = await import("../packages/extensions/pages/src/db.js");
    const db = new Database(":memory:");
    initDb(db as never);
    // The real guard factory: /feed sits above the requireSelf-guarded routes, so this
    // is faithful rather than a bypass. The assertions here are about coercion only.
    const { requireSelf } = await import("../packages/daemon/src/web/middleware/auth.js");
    const app = new Hono().route("/", createRoutes({ db, requireSelf } as never));
    const res = await app.request(`http://localhost/feed?${query}`);
    db.close();
    return res;
  }

  it("pages: 400s on ?limit=1e9 instead of serving one page", async () => {
    const res = await pagesFeed("limit=1e9");
    assert.equal(res.status, 400);
  });

  it("pages: 400s on ?limit=notanumber instead of serving the default 8", async () => {
    const res = await pagesFeed("limit=notanumber");
    assert.equal(res.status, 400);
  });

  it("pages: still serves a well-formed limit", async () => {
    const res = await pagesFeed("limit=3");
    assert.equal(res.status, 200);
  });

  // The intentions guard caught NaN but not the salvage: 1e9 parsed to 1 and passed.
  it("intentions: 400s on ?limit=1e9, which the old NaN guard let through as 1", async () => {
    const { Hono } = await import("hono");
    const { createRoutes } = await import("../packages/extensions/intentions/src/routes.js");
    const { default: Database } = await import("libsql");
    const { initDb } = await import("../packages/extensions/intentions/src/db.js");
    const db = new Database(":memory:");
    initDb(db as never);
    const app = new Hono().route("/", createRoutes({ db, publishActivity: () => {} } as never));
    const res = await app.request("http://localhost/feed?limit=1e9");
    assert.equal(res.status, 400);
    db.close();
  });
});

// ── H. The refusal has to say what would be accepted ─────────────────────────

describe("intParamError names the range instead of mis-describing it", () => {
  it("names both bounds for a capped param", async () => {
    const { intParamError } = await import("../packages/daemon/src/lib/util/query-params.js");
    // "must be a non-negative integer" was false for the case that most often triggers
    // it: 0 IS a non-negative integer and is refused anyway.
    assert.equal(
      intParamError("limit", { min: 1, max: 200 }),
      "limit must be an integer between 1 and 200",
    );
    assert.equal(
      intParamError("hours", { min: 1, max: 168 }),
      "hours must be an integer between 1 and 168",
    );
  });

  it("keeps the non-negative wording where it is actually accurate", async () => {
    const { intParamError } = await import("../packages/daemon/src/lib/util/query-params.js");
    assert.equal(
      intParamError("offset", { min: 0, max: Number.MAX_SAFE_INTEGER }),
      "offset must be a non-negative integer",
    );
  });
});

describe("history routes tell the caller what range would be accepted", () => {
  beforeEach(limitCleanup);
  afterEach(async () => {
    if (limitSession) deleteSession(limitSession);
    limitSession = undefined;
    await limitCleanup();
  });

  async function seedOne() {
    const db = await getDb();
    await db.insert(mindHistory).values({
      mind: LIMIT_MIND,
      type: "inbound",
      channel: "#bardo",
      sender: "someone",
      content: "row",
      created_at: "2026-08-20 09:00:00",
    });
    const user = await createUser(LIMIT_ADMIN, "pass");
    await db.update(users).set({ role: "admin" }).where(eq(users.id, user.id));
    limitSession = await createSession(user.id);
    return limitSession;
  }

  it("names 1..200 when refusing ?limit=0, not 'non-negative integer'", async () => {
    const cookie = await seedOne();
    const { default: app } = await import("../packages/daemon/src/web/app.js");
    const res = await app.request(`/api/v1/minds/${LIMIT_MIND}/history?full=true&limit=0`, {
      headers: { Cookie: `volute_session=${cookie}` },
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /limit must be an integer between 1 and 200/);
  });

  it("names 1..168 when refusing ?hours=0", async () => {
    const cookie = await seedOne();
    const { default: app } = await import("../packages/daemon/src/web/app.js");
    const res = await app.request(`/api/v1/minds/${LIMIT_MIND}/history/contacts?hours=0`, {
      headers: { Cookie: `volute_session=${cookie}` },
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /hours must be an integer between 1 and 168/);
  });

  // Above the cap is the documented clamp, not a refusal — the CLI refuses it before a
  // request is sent, and the route reports the window it actually used.
  it("clamps ?hours=200 to the cap and says which window it used", async () => {
    const cookie = await seedOne();
    const { default: app } = await import("../packages/daemon/src/web/app.js");
    const res = await app.request(`/api/v1/minds/${LIMIT_MIND}/history/contacts?hours=200`, {
      headers: { Cookie: `volute_session=${cookie}` },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { hours: number };
    assert.equal(body.hours, 168);
  });
});

describe("resonance flags refuse a missing or unusable value", () => {
  afterEach(() => mock.restoreAll());

  it("refuses a trailing --limit rather than searching at the default", async () => {
    const { readLimitFlag } = await import("../skills/resonance/scripts/resonance.js");
    // A shell that ate the value used to yield five real memories and no sign of it.
    const r = await captureRefusal(() => readLimitFlag(["search", "q", "--limit"], 5));
    assert.equal(r.exitCode, 1);
    assert.match(r.stderr, /--limit requires a value/);
  });

  it("refuses a non-numeric --min-strength rather than matching no rows", async () => {
    const { readStrengthFlag } = await import("../skills/resonance/scripts/resonance.js");
    // NaN binds as NULL; `strength >= NULL` is NULL, so the command printed
    // "no memories in the specified strength range" — a false negative that reads as a
    // real finding about the mind's own memory store.
    const r = await captureRefusal(() =>
      readStrengthFlag(["random", "--min-strength", "abc"], "--min-strength", 0),
    );
    assert.equal(r.exitCode, 1);
    assert.match(r.stderr, /--min-strength expects a number between 0.0 and 1.0, got: abc/);
  });

  it("refuses a strength outside 0..1, which could only ever match nothing", async () => {
    const { readStrengthFlag } = await import("../skills/resonance/scripts/resonance.js");
    const r = await captureRefusal(() =>
      readStrengthFlag(["random", "--max-strength", "5"], "--max-strength", 1),
    );
    assert.equal(r.exitCode, 1);
  });

  it("refuses a trailing --min-strength", async () => {
    const { readStrengthFlag } = await import("../skills/resonance/scripts/resonance.js");
    const r = await captureRefusal(() =>
      readStrengthFlag(["random", "--min-strength"], "--min-strength", 0),
    );
    assert.equal(r.exitCode, 1);
    assert.match(r.stderr, /--min-strength requires a value/);
  });

  it("reads well-formed strengths, including the fractional ones this is for", async () => {
    const { readStrengthFlag } = await import("../skills/resonance/scripts/resonance.js");
    assert.equal(readStrengthFlag(["random", "--min-strength", "0.25"], "--min-strength", 0), 0.25);
    assert.equal(readStrengthFlag(["random"], "--min-strength", 0), 0);
    assert.equal(readStrengthFlag(["random", "--max-strength", "1"], "--max-strength", 1), 1);
  });
});
