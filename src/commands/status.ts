import { checkForUpdate } from "@volute/shared/update-check";
import { getDaemonUrl, getServiceMode, modeLabel, readDaemonConfig } from "../lib/service-mode.js";

export async function run(_args: string[]) {
  const mode = getServiceMode();
  console.log(`Mode: ${modeLabel(mode)}`);

  const { hostname, port, token } = readDaemonConfig();
  const baseUrl = getDaemonUrl(hostname, port);

  // Check health
  let running = false;
  let version: string | undefined;
  try {
    const res = await fetch(`${baseUrl}/api/health`);
    if (res.ok) {
      const body = (await res.json()) as { ok?: boolean; version?: string };
      if (body.ok) {
        running = true;
        version = body.version;
      }
    }
  } catch {
    // Not running
  }

  if (!running) {
    console.log("Status: not running");
    return;
  }

  console.log(`Status: running on ${hostname}:${port}`);
  if (version) console.log(`Version: ${version}`);

  // Check for updates
  const update = await checkForUpdate();
  if (update.updateAvailable) {
    console.log(`Update available: ${update.current} → ${update.latest}`);
  }

  // List minds
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  headers.Origin = baseUrl;

  try {
    const res = await fetch(`${baseUrl}/api/minds`, { headers });
    if (res.ok) {
      const minds = (await res.json()) as Array<{
        name: string;
        running: boolean;
        stage?: string;
      }>;
      if (minds.length > 0) {
        console.log(`\nMinds (${minds.length}):`);
        for (const mind of minds) {
          const status = mind.running ? "running" : "stopped";
          const label = mind.stage === "seed" ? " (seed)" : "";
          console.log(`  ${mind.name}: ${status}${label}`);
        }
      } else {
        console.log("\nNo minds configured.");
      }
    }
  } catch {
    // Couldn't fetch minds — not critical
  }
}
