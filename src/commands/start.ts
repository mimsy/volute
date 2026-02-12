import { daemonFetch } from "../lib/daemon-client.js";
import { resolveAgent } from "../lib/registry.js";
import { resolveAgentName } from "../lib/resolve-agent-name.js";

export async function run(args: string[]) {
  const name = resolveAgentName({ agent: args[0] });

  const { entry } = resolveAgent(name);

  const res = await daemonFetch(`/api/agents/${encodeURIComponent(name)}/start`, {
    method: "POST",
  });

  const data = (await res.json()) as { ok?: boolean; error?: string };

  if (!res.ok) {
    console.error(data.error || "Failed to start agent");
    process.exit(1);
  }

  console.log(`${name} started on port ${entry.port}`);
}
