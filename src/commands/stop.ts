import { daemonFetch } from "../lib/daemon-client.js";
import { resolveAgent } from "../lib/registry.js";

export async function run(args: string[]) {
  const name = args[0];
  if (!name) {
    console.error("Usage: volute agent stop <name>");
    process.exit(1);
  }

  resolveAgent(name); // Validate agent exists

  const res = await daemonFetch(`/api/agents/${encodeURIComponent(name)}/stop`, {
    method: "POST",
  });

  const data = (await res.json()) as { ok?: boolean; error?: string };

  if (!res.ok) {
    console.error(data.error || "Failed to stop agent");
    process.exit(1);
  }

  console.log(`${name} stopped.`);
}
