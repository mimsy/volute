import { parseArgs } from "../lib/parse-args.js";
import { resolveAgentName } from "../lib/resolve-agent-name.js";

export async function run(args: string[]) {
  const { positional, flags } = parseArgs(args, {
    template: { type: "string" },
    continue: { type: "boolean" },
  });

  const agentName = resolveAgentName({ agent: positional[0] });

  const { daemonFetch } = await import("../lib/daemon-client.js");
  const { getClient, urlOf } = await import("../lib/api-client.js");
  const client = getClient();

  const res = await daemonFetch(
    urlOf(client.api.agents[":name"].upgrade.$url({ param: { name: agentName } })),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        template: flags.template,
        continue: flags.continue,
      }),
    },
  );

  const data = (await res.json()) as {
    ok?: boolean;
    error?: string;
    conflicts?: boolean;
    worktreeDir?: string;
    variant?: string;
    port?: number;
    message?: string;
  };

  if (!res.ok && !data.conflicts) {
    console.error(data.error ?? "Failed to upgrade agent");
    process.exit(1);
  }

  if (data.conflicts) {
    console.log("\nMerge conflicts detected. Resolve them in:");
    console.log(`  ${data.worktreeDir}`);
    console.log(`\nThen run:`);
    console.log(`  volute agent upgrade ${agentName} --continue`);
    return;
  }

  console.log(`\nUpgrade variant running on port ${data.port}`);
  console.log(`\nNext steps:`);
  console.log(
    `  volute send @${agentName}@${data.variant} "hello"    # chat with upgraded variant`,
  );
  console.log(`  volute variant merge ${data.variant}                # merge back when satisfied`);
}
