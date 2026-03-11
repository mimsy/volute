import { daemonFetch } from "../lib/daemon-client.js";

export async function run(_args: string[]) {
  const res = await daemonFetch("/api/minds");
  if (!res.ok) {
    console.error("Failed to list minds");
    process.exit(1);
  }

  const minds = (await res.json()) as Array<{
    name: string;
    running: boolean;
    status?: string;
    stage?: string;
  }>;

  if (minds.length === 0) {
    console.log("No minds configured.");
    return;
  }

  for (const mind of minds) {
    const status = mind.status ?? (mind.running ? "running" : "stopped");
    const label = mind.stage === "seed" ? " (seed)" : "";
    console.log(`  ${mind.name}: ${status}${label}`);
  }
}
