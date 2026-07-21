import { command } from "../lib/command.js";
import { daemonFetch } from "../lib/daemon-client.js";

/**
 * Compact age since a mind was created, e.g. "3d", "5h", "2w". Lets the spirit
 * spot minds still in their first week at a glance (see the tending skill).
 * Handles DB timestamps stored as "YYYY-MM-DD HH:MM:SS" (UTC, no trailing Z).
 */
export function relativeAge(created: string, now = Date.now()): string {
  const normalized =
    created.endsWith("Z") || created.includes("T") ? created : `${created.replace(" ", "T")}Z`;
  const ms = now - new Date(normalized).getTime();
  if (Number.isNaN(ms) || ms < 0) return "";
  const days = Math.floor(ms / 86_400_000);
  if (days >= 7) return `${Math.floor(days / 7)}w`;
  if (days >= 1) return `${days}d`;
  const hours = Math.floor(ms / 3_600_000);
  if (hours >= 1) return `${hours}h`;
  return `${Math.floor(ms / 60_000)}m`;
}

const cmd = command({
  name: "volute mind list",
  description: "List all minds",
  flags: {},
  async run() {
    const res = await daemonFetch("/api/minds");
    if (!res.ok) {
      const body = (await res.json().catch(() => ({ error: `HTTP ${res.status}` }))) as {
        error: string;
      };
      console.error(`Failed to list minds: ${body.error}`);
      process.exit(1);
    }

    const minds = (await res.json()) as Array<{
      name: string;
      running: boolean;
      status?: string;
      stage?: string;
      created?: string;
      templateStale?: boolean;
      upgradeBlocked?: string;
    }>;

    if (minds.length === 0) {
      console.log("No minds configured.");
      return;
    }

    for (const mind of minds) {
      const status = mind.status ?? (mind.running ? "running" : "stopped");
      const label = mind.stage === "seed" ? " (seed)" : "";
      const age = mind.created ? relativeAge(mind.created) : "";
      const ageLabel = age ? `  ${age} old` : "";
      const template = mind.templateStale ? "  [template: outdated]" : "";
      const upgradeBlocked = mind.upgradeBlocked
        ? `  [upgrade blocked: ${mind.upgradeBlocked}]`
        : "";
      console.log(`  ${mind.name}: ${status}${label}${ageLabel}${template}${upgradeBlocked}`);
    }
  },
});

export const run = cmd.execute;
