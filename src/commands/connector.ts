import { getClient, urlOf } from "../lib/api-client.js";
import { daemonFetch } from "../lib/daemon-client.js";
import { parseArgs } from "../lib/parse-args.js";
import { resolveAgentName } from "../lib/resolve-agent-name.js";

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
  volute connector connect <type> [--agent <name>]
  volute connector disconnect <type> [--agent <name>]`);
}

async function promptValue(key: string, description: string): Promise<string> {
  process.stderr.write(`${description}\nEnter value for ${key}: `);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);

  return new Promise((resolve) => {
    let value = "";
    const onData = (buf: Buffer) => {
      for (const byte of buf) {
        if (byte === 3) {
          process.stderr.write("\n");
          process.exit(1);
        }
        if (byte === 13 || byte === 10) {
          process.stderr.write("\n");
          if (process.stdin.isTTY) process.stdin.setRawMode(false);
          process.stdin.removeListener("data", onData);
          process.stdin.pause();
          resolve(value);
          return;
        }
        if (byte === 127 || byte === 8) {
          value = value.slice(0, -1);
        } else {
          value += String.fromCharCode(byte);
        }
      }
    };
    process.stdin.resume();
    process.stdin.on("data", onData);
  });
}

type MissingEnvResponse = {
  error: "missing_env";
  missing: { name: string; description: string }[];
  connectorName: string;
};

async function connectConnector(args: string[]) {
  const { positional, flags } = parseArgs(args, {
    agent: { type: "string" },
  });

  const agentName = resolveAgentName(flags);
  const type = positional[0];

  if (!type) {
    console.error("Usage: volute connector connect <type> [--agent <name>]");
    process.exit(1);
  }

  const client = getClient();
  const connectorUrl = urlOf(
    client.api.agents[":name"].connectors[":type"].$url({
      param: { name: agentName, type },
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
        console.error(`\nSet them with: volute env set <KEY> --agent ${agentName}`);
        process.exit(1);
      }

      console.error(`${connectorName} connector requires some environment variables.\n`);

      for (const v of missing) {
        const value = await promptValue(v.name, v.description);
        if (!value) {
          console.error(`No value provided for ${v.name}. Aborting.`);
          process.exit(1);
        }
        const envRes = await daemonFetch(
          urlOf(
            client.api.agents[":name"].env[":key"].$url({
              param: { name: agentName, key: v.name },
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

  console.log(`${type} connector for ${agentName} started.`);
}

async function disconnectConnector(args: string[]) {
  const { positional, flags } = parseArgs(args, {
    agent: { type: "string" },
  });

  const agentName = resolveAgentName(flags);
  const type = positional[0];

  if (!type) {
    console.error("Usage: volute connector disconnect <type> [--agent <name>]");
    process.exit(1);
  }

  const client = getClient();
  const res = await daemonFetch(
    urlOf(
      client.api.agents[":name"].connectors[":type"].$url({
        param: { name: agentName, type },
      }),
    ),
    { method: "DELETE" },
  );

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: "Unknown error" }));
    console.error(`Failed to stop ${type} connector: ${(body as { error: string }).error}`);
    process.exit(1);
  }

  console.log(`${type} connector for ${agentName} stopped.`);
}
