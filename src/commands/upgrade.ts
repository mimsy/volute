import { command } from "../lib/command.js";
import { resolveMindName } from "../lib/resolve-mind-name.js";

const cmd = command({
  name: "volute mind upgrade",
  description: "Upgrade mind to latest template",
  args: [{ name: "name", required: true, description: "Mind to upgrade" }],
  flags: {
    template: { type: "string", description: "Template to upgrade to" },
    diff: { type: "boolean", description: "Show changes without applying" },
    continue: { type: "boolean", description: "Continue a paused upgrade" },
    abort: { type: "boolean", description: "Abort a paused upgrade" },
  },
  run: async ({ args, flags }) => {
    const mindName = resolveMindName({ mind: args.name });

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
          diff: flags.diff,
        }),
      },
    );

    const data = (await res.json()) as {
      ok?: boolean;
      error?: string;
      conflicts?: boolean;
      worktreeDir?: string;
      diff?: string;
      message?: string;
      warning?: string;
    };

    if (!res.ok && !data.conflicts) {
      console.error(data.error ?? "Failed to upgrade mind");
      process.exit(1);
    }

    if (flags.diff) {
      console.log(data.diff ?? "(no changes)");
      return;
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

    if (data.warning) {
      console.log(`Upgrade complete for ${mindName} (with warning: ${data.warning})`);
    } else {
      console.log(`Upgrade complete for ${mindName}.`);
    }
  },
});

export const run = cmd.execute;
