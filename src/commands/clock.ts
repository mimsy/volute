import { CronExpressionParser } from "cron-parser";
import { getClient, urlOf } from "../lib/api-client.js";
import { daemonFetch } from "../lib/daemon-client.js";
import { parseArgs } from "../lib/parse-args.js";
import { resolveMindName } from "../lib/resolve-mind-name.js";
import type { Schedule } from "../lib/volute-config.js";

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
  upcoming: { id: string; at: string; type: "cron" | "timer" }[];
};

export async function run(args: string[]) {
  const subcommand = args[0];

  switch (subcommand) {
    case "status":
      await clockStatus(args.slice(1));
      break;
    case "list":
      await listSchedules(args.slice(1));
      break;
    case "add":
      await addSchedule(args.slice(1));
      break;
    case "remove":
      await removeSchedule(args.slice(1));
      break;
    case "sleep":
      await import("./mind-sleep.js").then((m) => m.run(args.slice(1)));
      break;
    case "wake":
      await import("./mind-wake.js").then((m) => m.run(args.slice(1)));
      break;
    case "--help":
    case "-h":
    case undefined:
      printUsage();
      break;
    default:
      printUsage();
      process.exit(1);
  }
}

function printUsage() {
  console.log(`Usage:
  volute clock status [--mind <name>]
  volute clock list [--mind <name>]
  volute clock add [--mind <name>] --cron "..." --message/--script "..." [--id name] [--channel ch] [--while-sleeping skip|queue|trigger-wake]
  volute clock add [--mind <name>] --in <duration> --message/--script "..." [--id name] [--channel ch] [--while-sleeping skip|queue|trigger-wake]
  volute clock remove [--mind <name>] --id <id>
  volute clock sleep [name] [--wake-at <time>]
  volute clock wake [name]

Duration format for --in: 30s, 10m, 1h, 2h30m`);
}

function parseDuration(input: string): number | null {
  const parts = input.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
  if (!parts || parts[0] !== input) return null;
  const hours = parseInt(parts[1] || "0", 10);
  const minutes = parseInt(parts[2] || "0", 10);
  const seconds = parseInt(parts[3] || "0", 10);
  const total = hours * 3600_000 + minutes * 60_000 + seconds * 1000;
  return total > 0 ? total : null;
}

async function clockStatus(args: string[]) {
  const { flags } = parseArgs(args, {
    mind: { type: "string" },
  });

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

  // Sleep state
  if (status.sleep?.sleeping) {
    const since = status.sleep.sleepingSince
      ? new Date(status.sleep.sleepingSince).toLocaleString()
      : "unknown";
    console.log(`Sleep: sleeping since ${since}`);
    if (status.sleep.scheduledWakeAt) {
      console.log(`  Wake at: ${new Date(status.sleep.scheduledWakeAt).toLocaleString()}`);
    }
    if (status.sleep.voluntaryWakeAt) {
      console.log(
        `  Voluntary wake at: ${new Date(status.sleep.voluntaryWakeAt).toLocaleString()}`,
      );
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
    console.log("\nUpcoming (next 24h):");
    for (const u of status.upcoming) {
      const time = new Date(u.at).toLocaleString();
      const label = u.type === "timer" ? "[timer]" : "[cron]";
      console.log(`  ${u.id.padEnd(20)} ${label}  ${time}`);
    }
  } else {
    console.log("\nNo upcoming events in next 24h.");
  }

  // Schedule count
  console.log(`\n${status.schedules.length} schedule(s) configured.`);
}

async function listSchedules(args: string[]) {
  const { flags } = parseArgs(args, {
    mind: { type: "string" },
  });

  const mind = resolveMindName(flags);
  const client = getClient();

  const res = await daemonFetch(
    urlOf(client.api.minds[":name"].schedules.$url({ param: { name: mind } })),
  );
  if (!res.ok) {
    const data = (await res.json()) as { error?: string };
    console.error(data.error ?? `Failed to list schedules: ${res.status}`);
    process.exit(1);
  }

  const schedules = (await res.json()) as Schedule[];
  if (schedules.length === 0) {
    console.log("No schedules configured.");
    return;
  }

  const idW = Math.max(2, ...schedules.map((s) => s.id.length));
  const schedW = Math.max(8, ...schedules.map((s) => (s.cron ?? s.fireAt ?? "").length));
  const actionLabel = (s: Schedule) => (s.script ? `[script] ${s.script}` : (s.message ?? ""));

  console.log(`${"ID".padEnd(idW)}  ${"SCHEDULE".padEnd(schedW)}  ENABLED  ACTION`);
  for (const s of schedules) {
    const sched = s.cron ?? (s.fireAt ? `at ${s.fireAt}` : "");
    console.log(
      `${s.id.padEnd(idW)}  ${sched.padEnd(schedW)}  ${String(s.enabled).padEnd(7)}  ${actionLabel(s)}`,
    );
  }
}

async function addSchedule(args: string[]) {
  const { flags } = parseArgs(args, {
    mind: { type: "string" },
    cron: { type: "string" },
    in: { type: "string" },
    message: { type: "string" },
    script: { type: "string" },
    id: { type: "string" },
    channel: { type: "string" },
    "while-sleeping": { type: "string" },
  });

  const mind = resolveMindName(flags);

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
  if (flags.channel) body.channel = flags.channel;
  if (flags["while-sleeping"]) {
    const ws = flags["while-sleeping"] as string;
    if (!["skip", "queue", "trigger-wake"].includes(ws)) {
      console.error(`Invalid --while-sleeping value: ${ws} (must be skip, queue, or trigger-wake)`);
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
    console.log(`Timer set: ${data.id} (fires in ${flags.in})`);
  } else {
    console.log(`Schedule added: ${data.id}`);
  }
}

async function removeSchedule(args: string[]) {
  const { flags } = parseArgs(args, {
    mind: { type: "string" },
    id: { type: "string" },
  });

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
}
