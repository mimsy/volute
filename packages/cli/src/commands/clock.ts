import type { Schedule } from "@volute/daemon/lib/mind/volute-config.js";
import { CronExpressionParser } from "cron-parser";
import { getClient, urlOf } from "../lib/api-client.js";
import { command, subcommands } from "../lib/command.js";
import { daemonFetch } from "../lib/daemon-client.js";
import { compactDateTime, isCompact } from "../lib/format-cli.js";
import { resolveMindName } from "../lib/resolve-mind-name.js";

type SleepState = {
  sleeping: boolean;
  sleepingSince: string | null;
  scheduledWakeAt: string | null;
  wokenByTrigger: boolean;
  voluntaryWakeAt: string | null;
  queuedMessageCount: number;
};

type ClockStatus = {
  sleep: SleepState | null;
  sleepConfig: {
    enabled?: boolean;
    schedule?: { sleep: string; wake: string };
  } | null;
  schedules: Schedule[];
  upcoming: {
    id: string;
    at: string;
    type: "cron" | "timer";
    willSkip?: boolean;
    willQueue?: boolean;
  }[];
};

export function parseDuration(input: string): number | null {
  const parts = input.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
  if (!parts || parts[0] !== input) return null;
  const hours = parseInt(parts[1] || "0", 10);
  const minutes = parseInt(parts[2] || "0", 10);
  const seconds = parseInt(parts[3] || "0", 10);
  const total = hours * 3600_000 + minutes * 60_000 + seconds * 1000;
  return total > 0 ? total : null;
}

const clockStatusCmd = command({
  name: "volute clock status",
  description: "Show sleep state and upcoming events",
  flags: {
    mind: { type: "string", description: "Mind name" },
  },
  run: async ({ flags }) => {
    const mind = resolveMindName(flags);
    const client = getClient();

    const res = await daemonFetch(
      urlOf(client.api.minds[":name"].clock.status.$url({ param: { name: mind } })),
    );
    if (!res.ok) {
      const data = (await res.json()) as { error?: string };
      console.error(data.error ?? `Failed to get clock status: ${res.status}`);
      process.exit(1);
    }

    const status = (await res.json()) as ClockStatus;
    const compact = isCompact();
    const fmtTime = (s: string) => (compact ? compactDateTime(s) : new Date(s).toLocaleString());

    // Sleep state
    if (status.sleep?.sleeping) {
      if (status.sleep.wokenByTrigger) {
        console.log("Sleep: briefly awake (trigger) — returns to sleep when idle");
      } else {
        const since = status.sleep.sleepingSince ? fmtTime(status.sleep.sleepingSince) : "unknown";
        console.log(`Sleep: sleeping since ${since}`);
      }
      if (status.sleep.scheduledWakeAt) {
        console.log(`  Wake at: ${fmtTime(status.sleep.scheduledWakeAt)}`);
      }
      if (status.sleep.voluntaryWakeAt) {
        console.log(`  Voluntary wake at: ${fmtTime(status.sleep.voluntaryWakeAt)}`);
      }
      if (status.sleep.queuedMessageCount > 0) {
        console.log(`  Queued messages: ${status.sleep.queuedMessageCount}`);
      }
    } else {
      console.log("Sleep: awake");
    }

    // Sleep schedule
    if (status.sleepConfig?.enabled && status.sleepConfig.schedule) {
      console.log(
        `  Schedule: sleep ${status.sleepConfig.schedule.sleep}, wake ${status.sleepConfig.schedule.wake}`,
      );
    }

    // Upcoming
    if (status.upcoming.length > 0) {
      if (!compact) console.log("");
      console.log("Upcoming (next 24h):");
      for (const u of status.upcoming) {
        const time = fmtTime(u.at);
        const label = u.type === "timer" ? "[once]" : "[cron]";
        const suffix = u.willSkip
          ? "  [will skip: sleeping]"
          : u.willQueue
            ? "  [will queue: sleeping]"
            : "";
        console.log(`  ${u.id.padEnd(20)} ${label}  ${time}${suffix}`);
      }
    } else {
      if (!compact) console.log("");
      console.log("No upcoming events in next 24h.");
    }

    // Schedule count
    if (!compact) {
      console.log(`\n${status.schedules.length} schedule(s) configured.`);
    }
  },
});

/** One printable row of the clock, whichever store in volute.json it came from. */
type ClockRow = {
  id: string;
  schedule: string;
  enabled: boolean;
  action: string;
  /** The volute.json key this row lives under — `schedules[]` or `sleep.schedule`. */
  source: string;
};

/**
 * Build the rows `clock list` prints. The clock has two stores in volute.json —
 * `schedules[]` and `sleep.schedule` — and both are managed by `volute clock`,
 * so both belong in the command whose name promises the whole clock (#870).
 *
 * They carry their source rather than being merged, and the renderer prints them
 * as separate sections: the ids `sleep` and `wake` are not reserved, so a mind
 * can and does name its own schedules that (`sleep-prep-v2` today), and two rows
 * sharing an id where only one answers to `clock remove --id` would be its own
 * small lie.
 */
export function buildClockRows(
  schedules: Schedule[],
  sleepConfig: { enabled?: boolean; schedule?: { sleep: string; wake: string } } | null,
  fmtTime: (iso: string) => string,
): ClockRow[] {
  const rows: ClockRow[] = schedules.map((s) => ({
    id: s.id,
    schedule: s.cron ?? (s.fireAt ? `at ${fmtTime(s.fireAt)}` : ""),
    enabled: s.enabled,
    action: s.script
      ? `[script] ${s.script}`
      : s.messages?.length
        ? `[rotating x${s.messages.length}] ${s.messages[0]}`
        : (s.message ?? ""),
    source: "schedules[]",
  }));

  // Sleep crons are listed whether or not sleep is enabled — "sleep is off" is an
  // answer to "what wakes me?", and a missing row is not.
  if (sleepConfig?.schedule) {
    // Truthy, matching the authoritative gate in sleep-manager's evaluateMind
    // (`if (!config?.enabled ...) return`) and `clock status` above. `enabled`
    // is reachable as undefined — PUT /sleep/config only writes the field when
    // the body carries it, and minds hand-edit volute.json — and reading that as
    // on would print crons as armed that can never fire. #870 was a partial
    // instrument producing a confident false negative; this is the same class of
    // error pointing the other way.
    const enabled = sleepConfig.enabled === true;
    rows.push({
      id: "sleep",
      schedule: sleepConfig.schedule.sleep,
      enabled,
      action: "go to sleep",
      source: "sleep.schedule",
    });
    rows.push({
      id: "wake",
      schedule: sleepConfig.schedule.wake,
      enabled,
      action: "wake up",
      source: "sleep.schedule",
    });
  }
  return rows;
}

/** Render one aligned table of rows, with a header. Assumes rows.length > 0. */
function printClockTable(rows: ClockRow[]): void {
  const idW = Math.max(2, ...rows.map((r) => r.id.length));
  const schedW = Math.max(8, ...rows.map((r) => r.schedule.length));
  console.log(`${"ID".padEnd(idW)}  ${"SCHEDULE".padEnd(schedW)}  ENABLED  ACTION`);
  for (const r of rows) {
    console.log(
      `${r.id.padEnd(idW)}  ${r.schedule.padEnd(schedW)}  ${String(r.enabled).padEnd(7)}  ${r.action}`,
    );
  }
}

const listSchedulesCmd = command({
  name: "volute clock list",
  description: "List schedules, including the sleep/wake crons",
  flags: {
    mind: { type: "string", description: "Mind name" },
  },
  run: async ({ flags }) => {
    const mind = resolveMindName(flags);
    const client = getClient();

    // clock/status carries both stores (schedules[] and sleep.schedule) in one call.
    const res = await daemonFetch(
      urlOf(client.api.minds[":name"].clock.status.$url({ param: { name: mind } })),
    );
    if (!res.ok) {
      const data = (await res.json()) as { error?: string };
      console.error(data.error ?? `Failed to list schedules: ${res.status}`);
      process.exit(1);
    }

    const status = (await res.json()) as ClockStatus;
    const compact = isCompact();
    const fmtTime = (s: string) => (compact ? compactDateTime(s) : new Date(s).toLocaleString());
    const rows = buildClockRows(status.schedules, status.sleepConfig, fmtTime);
    const scheduleRows = rows.filter((r) => r.source === "schedules[]");
    const sleepRows = rows.filter((r) => r.source === "sleep.schedule");

    if (compact) {
      for (const r of rows) {
        console.log(`${r.id}  ${r.schedule}  ${r.enabled}  ${r.action}  (${r.source})`);
      }
      if (sleepRows.length === 0) console.log("(no sleep/wake schedule set)");
      return;
    }

    if (scheduleRows.length === 0) {
      console.log("No schedules configured.");
    } else {
      printClockTable(scheduleRows);
    }

    // Always say something about the sleep store. #870's incident was a mind
    // reading an incomplete `clock list`, concluding nothing woke it, and writing
    // that to its permanent record — so silence here is not an acceptable answer
    // to "what wakes me?".
    console.log("");
    if (sleepRows.length === 0) {
      console.log("No sleep/wake schedule set (sleep.schedule in .config/volute.json).");
      return;
    }
    console.log(
      "From sleep.schedule — managed by `volute clock sleep`/`wake`, not `clock remove`:",
    );
    printClockTable(sleepRows);
  },
});

const addScheduleCmd = command({
  name: "volute clock add",
  description: "Add a schedule (recurring --cron or one-time --in)",
  flags: {
    mind: { type: "string", description: "Mind name" },
    cron: { type: "string", description: "Cron expression" },
    in: { type: "string", description: "Duration (e.g. 30s, 10m, 1h)" },
    message: { type: "string", description: "Message to send" },
    script: { type: "string", description: "Script to run" },
    id: { type: "string", description: "Unique name for this schedule (required)" },
    thread: { type: "string", description: "Thread name" },
    "while-sleeping": {
      type: "string",
      description: "Behavior during sleep (skip, queue, trigger-wake)",
    },
  },
  run: async ({ flags }) => {
    const mind = resolveMindName(flags);

    if (!flags.id) {
      console.error("--id is required (a descriptive name for this schedule)");
      process.exit(1);
    }

    if (!flags.cron && !flags.in) {
      console.error("--cron or --in is required");
      process.exit(1);
    }
    if (flags.cron && flags.in) {
      console.error("--cron and --in are mutually exclusive");
      process.exit(1);
    }
    if (!flags.message && !flags.script) {
      console.error("--message or --script is required");
      process.exit(1);
    }
    if (flags.message && flags.script) {
      console.error("--message and --script are mutually exclusive");
      process.exit(1);
    }

    const body: Record<string, string> = {};

    if (flags.cron) {
      try {
        CronExpressionParser.parse(flags.cron);
      } catch {
        console.error(`Invalid cron expression: ${flags.cron}`);
        process.exit(1);
      }
      body.cron = flags.cron;
    }

    if (flags.in) {
      const durationMs = parseDuration(flags.in);
      if (!durationMs) {
        console.error(`Invalid duration: ${flags.in} (expected format: 30s, 10m, 1h, 2h30m)`);
        process.exit(1);
      }
      body.fireAt = new Date(Date.now() + durationMs).toISOString();
    }

    if (flags.message) body.message = flags.message;
    if (flags.script) body.script = flags.script;
    if (flags.id) body.id = flags.id;
    if (flags.thread) body.thread = flags.thread;
    if (flags["while-sleeping"]) {
      const ws = flags["while-sleeping"] as string;
      if (!["skip", "queue", "trigger-wake"].includes(ws)) {
        console.error(
          `Invalid --while-sleeping value: ${ws} (must be skip, queue, or trigger-wake)`,
        );
        process.exit(1);
      }
      body.whileSleeping = ws;
    }

    const client = getClient();
    const res = await daemonFetch(
      urlOf(client.api.minds[":name"].schedules.$url({ param: { name: mind } })),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );

    if (!res.ok) {
      const data = (await res.json()) as { error?: string };
      console.error(data.error ?? `Failed to add schedule: ${res.status}`);
      process.exit(1);
    }

    const data = (await res.json()) as { id: string };
    if (flags.in) {
      console.log(`Schedule added: ${data.id} (fires once in ${flags.in})`);
    } else {
      console.log(`Schedule added: ${data.id}`);
    }
  },
});

const removeScheduleCmd = command({
  name: "volute clock remove",
  description: "Remove a schedule",
  flags: {
    mind: { type: "string", description: "Mind name" },
    id: { type: "string", description: "Schedule ID (required)" },
  },
  run: async ({ flags }) => {
    const mind = resolveMindName(flags);

    if (!flags.id) {
      console.error("--id is required");
      process.exit(1);
    }

    const client = getClient();
    const res = await daemonFetch(
      urlOf(
        client.api.minds[":name"].schedules[":id"].$url({
          param: { name: mind, id: flags.id },
        }),
      ),
      { method: "DELETE" },
    );

    if (!res.ok) {
      const data = (await res.json()) as { error?: string };
      console.error(data.error ?? `Failed to remove schedule: ${res.status}`);
      process.exit(1);
    }

    console.log(`Schedule removed: ${flags.id}`);
  },
});

const cmd = subcommands({
  name: "volute clock",
  description: "Manage schedules and sleep/wake cycles",
  commands: {
    status: {
      description: "Show sleep state and upcoming schedule fires",
      run: clockStatusCmd.execute,
    },
    list: {
      description: "List schedules",
      run: listSchedulesCmd.execute,
    },
    add: {
      description: "Add a schedule (recurring --cron or one-time --in)",
      run: addScheduleCmd.execute,
    },
    remove: {
      description: "Remove a schedule",
      run: removeScheduleCmd.execute,
    },
    sleep: {
      description: "Put a mind to sleep",
      run: (args) => import("./mind-sleep.js").then((m) => m.run(args)),
    },
    wake: {
      description: "Wake a sleeping mind",
      run: (args) => import("./mind-wake.js").then((m) => m.run(args)),
    },
  },
  footer: "Use --mind <name> or VOLUTE_MIND to identify the mind.",
});

export const run = cmd.execute;
