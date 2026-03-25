import { command } from "../lib/command.js";
import { resolveMindName } from "../lib/resolve-mind-name.js";

const cmd = command({
  name: "volute mind split",
  description: "Create an experimental variant",
  args: [{ name: "name", required: true, description: "Name for the variant" }],
  flags: {
    from: { type: "string", description: "Parent mind to split from" },
    soul: { type: "string", description: "Custom SOUL.md content" },
    port: { type: "number", description: "Port for variant server" },
    "no-start": { type: "boolean", description: "Don't start the variant" },
    json: { type: "boolean", description: "Output JSON result" },
  },
  run: async ({ args, flags }) => {
    const mindName = resolveMindName({ mind: flags.from });
    const variantName = args.name!;
    const { soul, port, json } = flags;
    const noStart = flags["no-start"];

    if (!json) console.log("Creating variant via daemon...");

    const { daemonFetch } = await import("../lib/daemon-client.js");
    const { getClient, urlOf } = await import("../lib/api-client.js");

    const client = getClient();
    const res = await daemonFetch(
      urlOf(client.api.minds[":name"].variants.$url({ param: { name: mindName } })),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: variantName,
          ...(soul && { soul }),
          ...(port && { port }),
          ...(noStart && { noStart }),
        }),
      },
    );

    const data = (await res.json()) as {
      ok?: boolean;
      error?: string;
      variant?: { name: string; branch: string; path: string; port: number };
    };

    if (!res.ok) {
      console.error(data.error ?? "Failed to create variant");
      process.exit(1);
    }

    if (json) {
      console.log(JSON.stringify(data.variant, null, 2));
    } else {
      console.log(`\nVariant created: ${variantName}`);
      console.log(`  Branch: ${data.variant?.branch}`);
      console.log(`  Path:   ${data.variant?.path}`);
      console.log(`  Port:   ${data.variant?.port}`);
    }
  },
});

export const run = cmd.execute;
