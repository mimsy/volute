import { parseArgs } from "@volute/shared/parse-args";
import { resolveMindName } from "../lib/resolve-mind-name.js";

export async function run(args: string[]) {
  const { positional, flags } = parseArgs(args, {
    template: { type: "string" },
    continue: { type: "boolean" },
    abort: { type: "boolean" },
  });

  const mindName = resolveMindName({ mind: positional[0] });

  const { daemonFetch } = await import("../lib/daemon-client.js");
  const { getClient, urlOf } = await import("../lib/api-client.js");
  const client = getClient();

  const res = await daemonFetch(
    urlOf(client.api.minds[":name"].upgrade.$url({ param: { name: mindName } })),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        template: flags.template,
        continue: flags.continue,
        abort: flags.abort,
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
    console.error(data.error ?? "Failed to upgrade mind");
    process.exit(1);
  }

  if (flags.abort) {
    console.log(`Upgrade aborted for ${mindName}.`);
    return;
  }

  if (data.conflicts) {
    console.log("\nMerge conflicts detected. Resolve them in:");
    console.log(`  ${data.worktreeDir}`);
    console.log(`\nThen run:`);
    console.log(`  volute mind upgrade ${mindName} --continue`);
    console.log(`\nOr abort:`);
    console.log(`  volute mind upgrade ${mindName} --abort`);
    return;
  }

  console.log(`\nUpgrade variant running on port ${data.port}`);
  console.log(`\nNext steps:`);
  console.log(`  volute send @${mindName}@${data.variant} "hello"    # chat with upgraded variant`);
  console.log(`  volute variant merge ${data.variant}                # merge back when satisfied`);
}
