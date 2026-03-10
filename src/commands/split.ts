import { parseArgs } from "../lib/parse-args.js";
import { resolveMindName } from "../lib/resolve-mind-name.js";

export async function run(args: string[]) {
  const { positional, flags } = parseArgs(args, {
    from: { type: "string" },
    soul: { type: "string" },
    port: { type: "number" },
    "no-start": { type: "boolean" },
    json: { type: "boolean" },
  });

  const mindName = resolveMindName({ mind: flags.from });
  const splitName = positional[0];
  const { soul, port, json } = flags;
  const noStart = flags["no-start"];

  if (!splitName) {
    console.error(
      'Usage: volute mind split <name> [--from <mind>] [--soul "..."] [--port N] [--no-start] [--json]',
    );
    process.exit(1);
  }

  if (!json) console.log("Creating split via daemon...");

  const { daemonFetch } = await import("../lib/daemon-client.js");
  const { getClient, urlOf } = await import("../lib/api-client.js");

  const client = getClient();
  const res = await daemonFetch(
    urlOf(client.api.minds[":name"].variants.$url({ param: { name: mindName } })),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: splitName,
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
    console.error(data.error ?? "Failed to create split");
    process.exit(1);
  }

  if (json) {
    console.log(JSON.stringify(data.variant, null, 2));
  } else {
    console.log(`\nSplit created: ${splitName}`);
    console.log(`  Branch: ${data.variant?.branch}`);
    console.log(`  Path:   ${data.variant?.path}`);
    console.log(`  Port:   ${data.variant?.port}`);
  }
}
