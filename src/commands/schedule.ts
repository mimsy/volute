import { daemonFetch } from "../lib/daemon-client.js";
import { parseArgs } from "../lib/parse-args.js";
import { resolveAgentName } from "../lib/resolve-agent-name.js";

type Schedule = {
  id: string;
  cron: string;
  message: string;
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
    default:
      printUsage();
      process.exit(subcommand ? 1 : 0);
  }
}

function printUsage() {
  console.error(`Usage:
  volute schedule list [--agent <name>]
  volute schedule add [--agent <name>] --cron "..." --message "..." [--id name]
  volute schedule remove [--agent <name>] --id <id>`);
}

async function listSchedules(args: string[]) {
  const { flags } = parseArgs(args, {
    agent: { type: "string" },
  });

  const agent = resolveAgentName(flags);

  const res = await daemonFetch(`/api/agents/${encodeURIComponent(agent)}/schedules`);
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

  console.log(`${"ID".padEnd(idW)}  ${"CRON".padEnd(cronW)}  ENABLED  MESSAGE`);
  for (const s of schedules) {
    console.log(
      `${s.id.padEnd(idW)}  ${s.cron.padEnd(cronW)}  ${String(s.enabled).padEnd(7)}  ${s.message}`,
    );
  }
}

async function addSchedule(args: string[]) {
  const { flags } = parseArgs(args, {
    agent: { type: "string" },
    cron: { type: "string" },
    message: { type: "string" },
    id: { type: "string" },
  });

  const agent = resolveAgentName(flags);

  if (!flags.cron || !flags.message) {
    console.error("--cron and --message are required");
    process.exit(1);
  }

  const body: Record<string, string> = { cron: flags.cron, message: flags.message };
  if (flags.id) body.id = flags.id;

  const res = await daemonFetch(`/api/agents/${encodeURIComponent(agent)}/schedules`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

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
    agent: { type: "string" },
    id: { type: "string" },
  });

  const agent = resolveAgentName(flags);

  if (!flags.id) {
    console.error("--id is required");
    process.exit(1);
  }

  const res = await daemonFetch(
    `/api/agents/${encodeURIComponent(agent)}/schedules/${encodeURIComponent(flags.id)}`,
    { method: "DELETE" },
  );

  if (!res.ok) {
    const data = (await res.json()) as { error?: string };
    console.error(data.error ?? `Failed to remove schedule: ${res.status}`);
    process.exit(1);
  }

  console.log(`Schedule removed: ${flags.id}`);
}
