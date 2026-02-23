import { getClient, urlOf } from "../lib/api-client.js";
import { daemonFetch } from "../lib/daemon-client.js";
import { parseArgs } from "../lib/parse-args.js";
import { resolveMindName } from "../lib/resolve-mind-name.js";

type Schedule = {
  id: string;
  cron: string;
  message?: string;
  script?: string;
  enabled: boolean;
};

export async function run(args: string[]) {
  const subcommand = args[0];

  switch (subcommand) {
    case "list":
      await listSchedules(args.slice(1));
      break;
    case "add":
      await addSchedule(args.slice(1));
      break;
    case "remove":
      await removeSchedule(args.slice(1));
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
  volute schedule list [--mind <name>]
  volute schedule add [--mind <name>] --cron "..." --message "..." [--id name]
  volute schedule add [--mind <name>] --cron "..." --script "..." [--id name]
  volute schedule remove [--mind <name>] --id <id>`);
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
  const cronW = Math.max(4, ...schedules.map((s) => s.cron.length));
  const actionLabel = (s: Schedule) => (s.script ? `[script] ${s.script}` : (s.message ?? ""));

  console.log(`${"ID".padEnd(idW)}  ${"CRON".padEnd(cronW)}  ENABLED  ACTION`);
  for (const s of schedules) {
    console.log(
      `${s.id.padEnd(idW)}  ${s.cron.padEnd(cronW)}  ${String(s.enabled).padEnd(7)}  ${actionLabel(s)}`,
    );
  }
}

async function addSchedule(args: string[]) {
  const { flags } = parseArgs(args, {
    mind: { type: "string" },
    cron: { type: "string" },
    message: { type: "string" },
    script: { type: "string" },
    id: { type: "string" },
  });

  const mind = resolveMindName(flags);

  if (!flags.cron) {
    console.error("--cron is required");
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

  const body: Record<string, string> = { cron: flags.cron };
  if (flags.message) body.message = flags.message;
  if (flags.script) body.script = flags.script;
  if (flags.id) body.id = flags.id;

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
  console.log(`Schedule added: ${data.id}`);
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
