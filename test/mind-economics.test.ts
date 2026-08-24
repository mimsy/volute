import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import { formatUsage, periodText, untilText, usd } from "../packages/cli/src/commands/usage.js";
import { composeMindEnv, spendCapEnv } from "../packages/daemon/src/lib/daemon/mind-manager.js";

/**
 * A mind's economics, as the mind itself meets them: two env vars, one startup
 * line, and `volute usage`. The property under test throughout is that a mind is
 * never told about a limit that isn't there, and never handed an incomplete
 * figure as if it were exact.
 */

const HOOK_PATH = resolve(process.cwd(), "templates/_base/.init/.local/hooks/startup-context.ts");

/**
 * Async on purpose. `execFileSync` blocks this process's event loop, so an
 * in-process stub daemon could never accept the hook's connection — the two would
 * deadlock until the child timed out.
 */
const execFileAsync = promisify(execFile);

describe("spendCapEnv", () => {
  it("tells a capped mind its cap and the period it covers", () => {
    assert.deepEqual(spendCapEnv({ capUsd: 5, periodMinutes: 1440 }), {
      VOLUTE_SPEND_CAP: "5",
      VOLUTE_SPEND_CAP_PERIOD_MINUTES: "1440",
    });
  });

  it("says nothing to a mind with no cap", () => {
    assert.deepEqual(spendCapEnv(null), {
      VOLUTE_SPEND_CAP: undefined,
      VOLUTE_SPEND_CAP_PERIOD_MINUTES: undefined,
    });
  });

  it("says nothing when the cap is zero or negative", () => {
    // A non-positive cap sets no budget (`SpendBudget.setBudget`), so naming one
    // would announce a limit nothing enforces.
    for (const capUsd of [0, -1]) {
      const env = spendCapEnv({ capUsd, periodMinutes: 1440 });
      assert.equal(env.VOLUTE_SPEND_CAP, undefined);
      assert.equal(env.VOLUTE_SPEND_CAP_PERIOD_MINUTES, undefined);
    }
  });

  it("strips a stale cap left in the mind's env.json", () => {
    // The spread lands after `loadMergedEnv()`, so an uncapped mind must have any
    // inherited VOLUTE_SPEND_CAP overwritten — not merely not-set. A mind can write
    // its own env (`volute env set --mind`), so this is reachable without the host.
    const merged = { VOLUTE_SPEND_CAP: "999", VOLUTE_MIND: "dizzy", ...spendCapEnv(null) };
    assert.equal(merged.VOLUTE_SPEND_CAP, undefined);
    assert.equal(merged.VOLUTE_MIND, "dizzy");
  });

  it("writes the default period explicitly rather than leaving it to be inferred", () => {
    // A mind reading its own env must not have to know Volute's defaults to
    // interpret the number it finds there.
    const env = spendCapEnv({ capUsd: 2.5, periodMinutes: 0 });
    assert.equal(env.VOLUTE_SPEND_CAP, "2.5");
    assert.equal(env.VOLUTE_SPEND_CAP_PERIOD_MINUTES, "1440");
  });
});

describe("startup-context spend line", () => {
  /** Run the hook, feeding it the SessionStart payload on stdin. */
  function runScript(env: Record<string, string>) {
    const child = execFileAsync("node", ["--import", "tsx", HOOK_PATH], {
      encoding: "utf-8",
      env,
    });
    child.child.stdin?.end(JSON.stringify({ source: "startup" }));
    return child;
  }

  /**
   * Stand a stub daemon in front of the hook and run it for real. The line is
   * fetched live rather than read from VOLUTE_SPEND_CAP precisely because the env
   * snapshot goes stale when a host changes or clears a cap mid-run, so the test
   * has to exercise the fetch to be testing the thing that matters.
   */
  async function runHook(budget: unknown | null): Promise<string> {
    const server = createServer((req, res) => {
      if (req.url?.includes("/budget")) {
        if (budget === null) {
          res.writeHead(404, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "No budget configured" }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(budget));
        return;
      }
      // The hook's other fetch (extensions/mind-docs) — answer it emptily so the
      // output is just the session line plus whatever spend lines apply.
      res.writeHead(200, { "content-type": "application/json" });
      res.end("[]");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    try {
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
      delete env.VOLUTE_MIND_DIR;
      delete env.VOLUTE_SYSTEM_NAME;
      env.VOLUTE_DAEMON_PORT = String(port);
      env.VOLUTE_MIND_TOKEN = "test-token";
      env.VOLUTE_MIND = "dizzy";
      // Deliberately present and wrong: the hook must ignore the env snapshot.
      env.VOLUTE_SPEND_CAP = "999";
      env.VOLUTE_SPEND_CAP_PERIOD_MINUTES = "1440";
      const { stdout } = await runScript(env);
      return JSON.parse(stdout).hookSpecificOutput.additionalContext as string;
    } finally {
      // closeAllConnections first: node's fetch keeps the socket alive, and
      // server.close() alone waits on it forever.
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  }

  const hour = 3_600_000;

  it("states the live cap, the spend so far, and when it resets", async () => {
    const ctx = await runHook({
      capUsd: 5,
      spentUsd: 1.42,
      periodMinutes: 1440,
      resetAt: Date.now() + 7 * hour,
      hasUnpricedTurns: false,
      system: null,
      held: { count: 0, scope: null, releasesAt: null },
    });
    assert.match(ctx, /spend cap is \$5\.00 per day/);
    assert.match(ctx, /\$1\.42 spent so far/);
    assert.match(ctx, /resetting in about 7 hours/);
    // The stale env snapshot must not leak into the line.
    assert.doesNotMatch(ctx, /999/);
  });

  it("says nothing at all when no cap exists anywhere", async () => {
    // Even though VOLUTE_SPEND_CAP is set in the environment — a mind whose cap was
    // cleared mid-run keeps that var, and must not be told it still has a limit.
    const ctx = await runHook(null);
    assert.doesNotMatch(ctx, /spend cap/i);
    assert.doesNotMatch(ctx, /999/);
  });

  it("names an install-wide budget as shared, not as the mind's own", async () => {
    const ctx = await runHook({
      system: { spentUsd: 12.4, capUsd: 50, resetAt: Date.now() + 2 * hour },
      held: { count: 0, scope: null, releasesAt: null },
    });
    assert.match(ctx, /shared budget of \$50\.00 per day across every mind here/);
    assert.match(ctx, /\$12\.40 spent/);
    assert.doesNotMatch(ctx, /Your spend cap/);
  });

  it("marks an unpriced period as a floor, without naming a direction", async () => {
    const ctx = await runHook({
      capUsd: 5,
      spentUsd: 1.42,
      periodMinutes: 60,
      resetAt: Date.now() + 30 * 60_000,
      hasUnpricedTurns: true,
      system: null,
      held: { count: 0, scope: null, releasesAt: null },
    });
    assert.match(ctx, /a floor — some turns this period couldn't be priced/);
    assert.match(ctx, /per hour/);
    assert.doesNotMatch(ctx, /undercount|underreport|too low/i);
  });

  it("stays silent when the daemon can't be reached", async () => {
    // A closed port: the fetch throws and the hook must fall through rather than
    // crash the session-start context or assert a number it never received.
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
    delete env.VOLUTE_MIND_DIR;
    delete env.VOLUTE_SYSTEM_NAME;
    env.VOLUTE_DAEMON_PORT = "1";
    env.VOLUTE_MIND_TOKEN = "test-token";
    env.VOLUTE_MIND = "dizzy";
    env.VOLUTE_SPEND_CAP = "999";
    const { stdout } = await runScript(env);
    const ctx = JSON.parse(stdout).hookSpecificOutput.additionalContext as string;
    assert.match(ctx, /Session startup/);
    assert.doesNotMatch(ctx, /spend cap/i);
  });
});

describe("volute usage formatting", () => {
  const now = Date.UTC(2026, 7, 24, 12, 0, 0);
  const hour = 3_600_000;

  function base(over: Record<string, unknown> = {}) {
    return {
      spentUsd: 1.42,
      capUsd: 5,
      periodMinutes: 1440,
      periodStart: now - 4 * hour,
      resetAt: now + 20 * hour,
      hasUnpricedTurns: false,
      percentUsed: 28,
      system: null,
      held: { count: 0, scope: null, releasesAt: null },
      ...over,
    } as Parameters<typeof formatUsage>[1];
  }

  it("reports spend, what's left, and when it resets", () => {
    const out = formatUsage("dizzy", base(), now).join("\n");
    assert.match(out, /\$1\.42 of \$5\.00 \(28%\)/);
    assert.match(out, /Left\s+\$3\.58/);
    assert.match(out, /Resets\s+in about 20 hours/);
  });

  it("presents an unpriced period as a floor, without a direction", () => {
    const out = formatUsage("dizzy", base({ hasUnpricedTurns: true }), now).join("\n");
    assert.match(out, /floor, not a total/);
    // Legacy claude rows undercount and legacy codex rows overcount, so any
    // directional word here is a confident falsehood for half the fleet.
    assert.doesNotMatch(out, /undercount|underreport|too low|at least/i);
  });

  it("says nothing about pricing when every turn priced", () => {
    assert.doesNotMatch(formatUsage("dizzy", base(), now).join("\n"), /floor|couldn't be priced/);
  });

  it("surfaces the install-wide budget as shared, not the mind's own", () => {
    const out = formatUsage(
      "dizzy",
      base({
        system: {
          spentUsd: 12.4,
          capUsd: 50,
          resetAt: now + 2 * hour,
          hasUnpricedTurns: false,
          percentUsed: 25,
        },
      }),
      now,
    ).join("\n");
    assert.match(out, /Install-wide/);
    assert.match(out, /not yours in particular/);
    assert.match(out, /\$12\.40 of \$50\.00 \(25%\)/);
  });

  it("carries the floor caveat when only the install-wide bucket is unpriced", () => {
    const out = formatUsage(
      "dizzy",
      base({
        system: {
          spentUsd: 12.4,
          capUsd: 50,
          resetAt: now + 2 * hour,
          hasUnpricedTurns: true,
          percentUsed: 25,
        },
      }),
      now,
    ).join("\n");
    assert.match(out, /floor, not a total/);
  });

  it("reports a mind with no cap of its own without inventing one", () => {
    const out = formatUsage(
      "dizzy",
      base({ spentUsd: undefined, capUsd: undefined, percentUsed: undefined, resetAt: undefined }),
      now,
    ).join("\n");
    assert.match(out, /no spend cap of its own/);
    assert.doesNotMatch(out, /Left/);
  });

  it("says held messages are waiting, not lost, and when they arrive", () => {
    const out = formatUsage(
      "dizzy",
      base({ held: { count: 3, scope: "mind", releasesAt: now + 20 * hour } }),
      now,
    ).join("\n");
    assert.match(out, /Held\s+3 messages waiting/);
    assert.match(out, /nothing is deleted/);
    assert.match(out, /in about 20 hours/);
  });

  it("invents neither a budget nor a reset time for a hold that has lifted", () => {
    // scope null means nothing holds them any more and the release sweep hasn't run.
    const out = formatUsage(
      "dizzy",
      base({ held: { count: 2, scope: null, releasesAt: null } }),
      now,
    ).join("\n");
    assert.match(out, /Held\s+2 messages waiting/);
    assert.match(out, /whatever was holding them has lifted/);
    assert.doesNotMatch(out, /when the period rolls over/);
  });

  it("attributes a hold to the install-wide budget when that is what tripped", () => {
    const out = formatUsage(
      "dizzy",
      base({ held: { count: 1, scope: "system", releasesAt: now + hour } }),
      now,
    ).join("\n");
    assert.match(out, /Held\s+1 message waiting/);
    assert.match(out, /the install-wide budget resets/);
  });

  it("keeps a sub-cent figure legible instead of rounding it to $0.00", () => {
    assert.equal(usd(0.0004), "$0.0004");
    assert.equal(usd(0), "$0.00");
    assert.equal(usd(1.4), "$1.40");
  });

  it("phrases a reset a mind can act on", () => {
    assert.equal(untilText(now + 20_000, now), "in under a minute");
    assert.equal(untilText(now + 5 * 60_000, now), "in 5 minutes");
    assert.equal(untilText(now + 60_000, now), "in 1 minute");
    assert.equal(untilText(now + 3 * hour, now), "in about 3 hours");
    assert.equal(untilText(now + 72 * hour, now), "in about 3 days");
    assert.equal(untilText(null, now), "when the period rolls over");
  });

  it("names periods the way a host set them", () => {
    assert.equal(periodText(1440), "day");
    assert.equal(periodText(60), "hour");
    assert.equal(periodText(90), "90 minutes");
    assert.equal(periodText(undefined), "period");
  });
});

describe("GET /:name/budget under an install-wide cap only", () => {
  it("reports the shared budget rather than answering 'no budget configured'", async () => {
    // A mind with no cap of its own is still told about the install's budget at 80%
    // (`system_spend_warning_notice`). If this route 404'd, `volute usage` would
    // contradict a notice the mind has already read.
    const { addMind, removeMind } = await import("../packages/daemon/src/lib/mind/registry.js");
    const { getSpendBudget, initSpendBudget } = await import(
      "../packages/daemon/src/lib/daemon/spend-budget.js"
    );
    const { createUser } = await import("../packages/daemon/src/lib/auth.js");
    const { createSession } = await import("../packages/daemon/src/web/middleware/auth.js");
    try {
      initSpendBudget();
    } catch {
      // already initialized by another test in this process
    }
    const sb = getSpendBudget();
    const name = `econ-syscap-${process.pid}`;
    await removeMind(name);
    await addMind(name, 4197, "sprouted", "claude");
    const user = await createUser(`econ-admin-${process.pid}`, "pass");
    const cookie = await createSession(user.id);
    const { default: app } = await import("../packages/daemon/src/web/app.js");

    try {
      // No cap anywhere: nothing to report, and the route says so.
      sb.setSystemCap(null);
      const bare = await app.request(`/api/v1/minds/${name}/budget`, {
        headers: { Cookie: `volute_session=${cookie}` },
      });
      assert.equal(bare.status, 404);

      // A name nobody holds is "not found", never "nothing is limiting you" — the
      // CLI turns the latter into a reassuring sentence about a mind that doesn't exist.
      sb.setSystemCap(50);
      const typo = await app.request(`/api/v1/minds/${name}-typo/budget`, {
        headers: { Cookie: `volute_session=${cookie}` },
      });
      assert.equal(typo.status, 404);
      assert.equal(((await typo.json()) as { error: string }).error, "Mind not found");

      const res = await app.request(`/api/v1/minds/${name}/budget`, {
        headers: { Cookie: `volute_session=${cookie}` },
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { capUsd?: number; system: { capUsd: number } | null };
      assert.ok(body.system, "the install-wide bucket is reported");
      assert.equal(body.system.capUsd, 50);
      // And no per-mind cap is invented for a mind that has none.
      assert.equal(body.capUsd, undefined);
    } finally {
      sb.setSystemCap(null);
      await removeMind(name);
    }
  });
});

describe("remote CLI command parity", () => {
  /** The `case "x":` labels a dispatcher switch handles. */
  function cases(source: string): Set<string> {
    return new Set([...source.matchAll(/^\s*case "([a-z-]+)":/gm)].map((m) => m[1]));
  }

  it("registers every mind-usable noun in both dispatchers", async () => {
    // `volute usage` shipped in src/cli.ts but not cli-remote.ts, so `volute-cli
    // usage` exited 1 "Unknown command" while SKILL.md and VOLUTE.md both told minds
    // to run it. Teaching a mind a command that errors spends its turns debugging
    // our documentation (cf. #445), so this pins the whole class rather than the
    // one instance.
    const { readFileSync } = await import("node:fs");
    const local = cases(readFileSync(resolve(process.cwd(), "src/cli.ts"), "utf-8"));
    const remote = cases(
      readFileSync(resolve(process.cwd(), "packages/cli/src/cli-remote.ts"), "utf-8"),
    );

    // Daemon-lifecycle and host-machine commands are local-only by nature: they act
    // on an install that a remote CLI, by definition, is not sitting on.
    const localOnly = new Set([
      "setup",
      "up",
      "down",
      "restart",
      "status",
      "update",
      "doctor",
      "service",
      "backup",
    ]);

    const missing = [...local].filter((c) => !localOnly.has(c) && !remote.has(c));
    assert.deepEqual(missing, [], `commands missing from the remote CLI: ${missing.join(", ")}`);
  });

  it("lists usage in the remote CLI help", async () => {
    // The switch and the help text drift apart independently — a registered command
    // nobody can discover is only half-shipped.
    const { readFileSync } = await import("node:fs");
    const remote = readFileSync(resolve(process.cwd(), "packages/cli/src/cli-remote.ts"), "utf-8");
    const help = remote.slice(remote.indexOf("Commands:"));
    assert.match(help, /^\s*usage\s+\S/m);
  });
});

describe("composeMindEnv wiring", () => {
  /**
   * The pieces were covered and the assembly was not: deleting the spend-cap
   * spread from `_startMind`'s env literal broke no test. That is the #808 shape —
   * the daemon-side half of a capability goes missing while everything still looks
   * healthy — so the composition itself is pinned here.
   */
  const mindName = `econ-env-${process.pid}`;

  async function withMind<T>(fn: () => Promise<T>): Promise<T> {
    const { addMind, removeMind } = await import("../packages/daemon/src/lib/mind/registry.js");
    await removeMind(mindName);
    await addMind(mindName, 4196, "sprouted", "claude");
    try {
      return await fn();
    } finally {
      await removeMind(mindName);
    }
  }

  async function budget() {
    const { getSpendBudget, initSpendBudget } = await import(
      "../packages/daemon/src/lib/daemon/spend-budget.js"
    );
    try {
      initSpendBudget();
    } catch {
      // already initialized by another test in this process
    }
    return getSpendBudget();
  }

  function compose() {
    return composeMindEnv({
      name: mindName,
      baseName: mindName,
      dir: `/tmp/${mindName}`,
      port: 4196,
      mindToken: "tok",
    });
  }

  it("hands a capped mind its cap alongside its identity", async () => {
    await withMind(async () => {
      const sb = await budget();
      sb.setBudget(mindName, 5, 1440);
      try {
        const env = compose();
        assert.equal(env.VOLUTE_SPEND_CAP, "5");
        assert.equal(env.VOLUTE_SPEND_CAP_PERIOD_MINUTES, "1440");
        // Sanity: the rest of the env is still assembled.
        assert.equal(env.VOLUTE_MIND, mindName);
        assert.equal(env.VOLUTE_MIND_TOKEN, "tok");
      } finally {
        await sb.removeBudget(mindName);
      }
    });
  });

  it("hands an uncapped mind no cap", async () => {
    await withMind(async () => {
      const sb = await budget();
      await sb.removeBudget(mindName);
      const env = compose();
      assert.equal(env.VOLUTE_SPEND_CAP, undefined);
      assert.equal(env.VOLUTE_SPEND_CAP_PERIOD_MINUTES, undefined);
    });
  });

  it("lets the live cap outrank one the mind wrote into its own env", async () => {
    // A mind can write its own env (`volute env set --mind`). Order is what stops
    // a planted VOLUTE_SPEND_CAP from either outranking the real cap or surviving
    // when there is none — so both directions are pinned.
    const { writeEnv, mindEnvPath } = await import("../packages/daemon/src/lib/config/env.js");
    await withMind(async () => {
      const sb = await budget();
      writeEnv(mindEnvPath(mindName), { VOLUTE_SPEND_CAP: "999" });
      try {
        sb.setBudget(mindName, 5, 1440);
        assert.equal(compose().VOLUTE_SPEND_CAP, "5", "the live cap wins");

        await sb.removeBudget(mindName);
        assert.equal(compose().VOLUTE_SPEND_CAP, undefined, "a stale planted cap is cleared");
      } finally {
        await sb.removeBudget(mindName);
        writeEnv(mindEnvPath(mindName), {});
      }
    });
  });
});
