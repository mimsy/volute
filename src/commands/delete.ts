import { existsSync, rmSync } from "node:fs";
import { deleteAgentUser as deleteAgentDbUser } from "../lib/auth.js";
import { deleteAgentUser } from "../lib/isolation.js";
import { parseArgs } from "../lib/parse-args.js";
import { agentDir, findAgent, removeAgent } from "../lib/registry.js";
import { resolveAgentName } from "../lib/resolve-agent-name.js";
import { removeAllVariants } from "../lib/variants.js";

export async function run(args: string[]) {
  const { positional, flags } = parseArgs(args, {
    force: { type: "boolean" },
  });

  const name = resolveAgentName({ agent: positional[0] });

  const entry = findAgent(name);
  if (!entry) {
    console.error(`Unknown agent: ${name}`);
    process.exit(1);
  }

  // Stop via daemon if running
  try {
    const { daemonFetch } = await import("../lib/daemon-client.js");
    const res = await daemonFetch(`/api/agents/${encodeURIComponent(name)}/stop`, {
      method: "POST",
    });
    if (res.ok) {
      console.log(`Stopped ${name}.`);
    }
  } catch {
    // Daemon not running, that's fine
  }

  const dir = agentDir(name);

  // Remove from registry, clean up variant tracking and DB user
  removeAllVariants(name);
  removeAgent(name);
  await deleteAgentDbUser(name);
  console.log(`Removed ${name} from registry.`);

  // Delete directory
  if (existsSync(dir)) {
    if (!flags.force) {
      console.log(`Directory: ${dir}`);
      console.log("Use --force to also delete the agent directory.");
    } else {
      rmSync(dir, { recursive: true, force: true });
      deleteAgentUser(name);
      console.log(`Deleted ${dir}`);
    }
  }
}
