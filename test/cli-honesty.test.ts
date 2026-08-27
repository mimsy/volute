import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { eq, sql } from "drizzle-orm";
import { assertReadLimit, pagingFooter } from "../packages/cli/src/commands/chat/read.js";
import {
  applyHistoryQuery,
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
    applyHistoryQuery(params, { limit: "10" });
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
