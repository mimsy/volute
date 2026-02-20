import { getClient, urlOf } from "../lib/api-client.js";
import { daemonFetch } from "../lib/daemon-client.js";
import { parseArgs } from "../lib/parse-args.js";
import { promptLine } from "../lib/prompt.js";
import { resolveMindName } from "../lib/resolve-mind-name.js";

export async function run(args: string[]) {
  const subcommand = args[0];

  switch (subcommand) {
    case "connect":
      await connectConnector(args.slice(1));
      break;
    case "disconnect":
      await disconnectConnector(args.slice(1));
      break;
    case "--help":
    case "-h":
    case undefined:
      printUsage();
      break;
    default:
      printUsage();
      process.exit(1);
  }
}

function printUsage() {
  console.log(`Usage:
  volute connector connect <type> [--mind <name>]
  volute connector disconnect <type> [--mind <name>]`);
}

type MissingEnvResponse = {
  error: "missing_env";
  missing: { name: string; description: string }[];
  connectorName: string;
};

async function connectConnector(args: string[]) {
  const { positional, flags } = parseArgs(args, {
    mind: { type: "string" },
  });

  const mindName = resolveMindName(flags);
  const type = positional[0];

  if (!type) {
    console.error("Usage: volute connector connect <type> [--mind <name>]");
    process.exit(1);
  }

  const client = getClient();
  const connectorUrl = urlOf(
    client.api.minds[":name"].connectors[":type"].$url({
      param: { name: mindName, type },
    }),
  );

  let res = await daemonFetch(connectorUrl, { method: "POST" });

  if (!res.ok) {
    const body = (await res.json().catch(() => ({ error: "Unknown error" }))) as
      | MissingEnvResponse
      | { error: string };

    if (body.error === "missing_env" && "missing" in body) {
      const { missing, connectorName } = body;

      if (!process.stdin.isTTY) {
        console.error(`Missing required environment variables for ${connectorName}:`);
        for (const v of missing) {
          console.error(`  ${v.name} — ${v.description}`);
        }
        console.error(`\nSet them with: volute env set <KEY> --mind ${mindName}`);
        process.exit(1);
      }

      console.error(`${connectorName} connector requires some environment variables.\n`);

      for (const v of missing) {
        const value = await promptLine(`${v.description}\nEnter value for ${v.name}: `);
        if (!value) {
          console.error(`No value provided for ${v.name}. Aborting.`);
          process.exit(1);
        }
        const envRes = await daemonFetch(
          urlOf(
            client.api.minds[":name"].env[":key"].$url({
              param: { name: mindName, key: v.name },
            }),
          ),
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ value }),
          },
        );
        if (!envRes.ok) {
          const errBody = (await envRes.json().catch(() => ({}))) as { error?: string };
          console.error(`Failed to set ${v.name}: ${errBody.error ?? `HTTP ${envRes.status}`}`);
          process.exit(1);
        }
      }
      console.log("Environment variables saved.\n");

      // Retry
      res = await daemonFetch(connectorUrl, { method: "POST" });
      if (!res.ok) {
        const retryBody = await res.json().catch(() => ({ error: "Unknown error" }));
        console.error(
          `Failed to start ${type} connector: ${(retryBody as { error: string }).error}`,
        );
        process.exit(1);
      }
    } else {
      console.error(`Failed to start ${type} connector: ${body.error}`);
      process.exit(1);
    }
  }

  console.log(`${type} connector for ${mindName} started.`);
}

async function disconnectConnector(args: string[]) {
  const { positional, flags } = parseArgs(args, {
    mind: { type: "string" },
  });

  const mindName = resolveMindName(flags);
  const type = positional[0];

  if (!type) {
    console.error("Usage: volute connector disconnect <type> [--mind <name>]");
    process.exit(1);
  }

  const client = getClient();
  const res = await daemonFetch(
    urlOf(
      client.api.minds[":name"].connectors[":type"].$url({
        param: { name: mindName, type },
      }),
    ),
    { method: "DELETE" },
  );

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: "Unknown error" }));
    console.error(`Failed to stop ${type} connector: ${(body as { error: string }).error}`);
    process.exit(1);
  }

  console.log(`${type} connector for ${mindName} stopped.`);
}
