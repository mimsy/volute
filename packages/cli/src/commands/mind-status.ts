import { command } from "../lib/command.js";
import { daemonFetch } from "../lib/daemon-client.js";
import { resolveMindName } from "../lib/resolve-mind-name.js";

const cmd = command({
  name: "volute mind status",
  description: "Check a mind's status",
  args: [{ name: "name", description: "Mind to check (or use VOLUTE_MIND)" }],
  flags: {},
  async run({ args }) {
    const name = args.name || (process.env.VOLUTE_MIND ? resolveMindName({}) : undefined);
    if (!name) {
      console.error("Usage: volute mind status <name>");
      process.exit(1);
    }

    const res = await daemonFetch(`/api/minds/${encodeURIComponent(name)}`);
    if (!res.ok) {
      if (res.status === 404) {
        console.error(`Mind "${name}" not found`);
      } else {
        const body = (await res.json().catch(() => ({ error: `HTTP ${res.status}` }))) as {
          error: string;
        };
        console.error(`Failed to get mind status: ${body.error}`);
      }
      process.exit(1);
    }

    const mind = (await res.json()) as {
      name: string;
      port: number;
      status?: string;
      running?: boolean;
      stage?: string;
      parent?: string;
      model?: string;
      channels?: Array<{ type: string; status: string }>;
      variants?: Array<{ name: string; status: string }>;
      hasPages?: boolean;
    };

    const status = mind.status ?? (mind.running ? "running" : "stopped");
    console.log(`Mind:    ${mind.name}`);
    console.log(`Status:  ${status}`);
    console.log(`Port:    ${mind.port}`);
    if (mind.stage) console.log(`Stage:   ${mind.stage}`);
    if (mind.parent) console.log(`Parent:  ${mind.parent}`);
    if (mind.model) console.log(`Model:   ${mind.model}`);

    if (mind.channels && mind.channels.length > 0) {
      console.log(`\nChannels:`);
      for (const ch of mind.channels) {
        console.log(`  ${ch.type}: ${ch.status}`);
      }
    }

    if (mind.variants && mind.variants.length > 0) {
      console.log(`\nVariants:`);
      for (const v of mind.variants) {
        console.log(`  ${v.name}: ${v.status}`);
      }
    }

    if (mind.hasPages) console.log(`\nPages:   published`);
  },
});

export const run = cmd.execute;
