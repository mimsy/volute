import { daemonFetch } from "../lib/daemon-client.js";

type Schedule = {
  id: string;
  cron: string;
  message: string;
  enabled: boolean;
};

export async function run(args: string[]) {
  const subcommand = args[0];
  const agentName = args[1];

  if (!subcommand || !agentName) {
    printUsage();
    process.exit(1);
  }

  switch (subcommand) {
    case "list":
      await listSchedules(agentName);
      break;
    case "add":
      await addSchedule(agentName, args.slice(2));
      break;
    case "remove":
      await removeSchedule(agentName, args.slice(2));
      break;
    default:
      printUsage();
      process.exit(1);
  }
}

function printUsage() {
  console.error(`Usage:
  volute schedule list <agent>
  volute schedule add <agent> --cron "..." --message "..." [--id name]
  volute schedule remove <agent> --id <id>`);
}

async function listSchedules(agent: string) {
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

async function addSchedule(agent: string, args: string[]) {
  let cron = "";
  let message = "";
  let id = "";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--cron" && args[i + 1]) {
      cron = args[++i];
    } else if (args[i] === "--message" && args[i + 1]) {
      message = args[++i];
    } else if (args[i] === "--id" && args[i + 1]) {
      id = args[++i];
    }
  }

  if (!cron || !message) {
    console.error("--cron and --message are required");
    process.exit(1);
  }

  const body: Record<string, string> = { cron, message };
  if (id) body.id = id;

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

async function removeSchedule(agent: string, args: string[]) {
  let id = "";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--id" && args[i + 1]) {
      id = args[++i];
    }
  }

  if (!id) {
    console.error("--id is required");
    process.exit(1);
  }

  const res = await daemonFetch(
    `/api/agents/${encodeURIComponent(agent)}/schedules/${encodeURIComponent(id)}`,
    { method: "DELETE" },
  );

  if (!res.ok) {
    const data = (await res.json()) as { error?: string };
    console.error(data.error ?? `Failed to remove schedule: ${res.status}`);
    process.exit(1);
  }

  console.log(`Schedule removed: ${id}`);
}
