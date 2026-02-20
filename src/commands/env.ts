import { getClient, urlOf } from "../lib/api-client.js";
import { daemonFetch } from "../lib/daemon-client.js";
import { parseArgs } from "../lib/parse-args.js";
import { promptLine } from "../lib/prompt.js";

function maskValue(value: string): string {
  if (value.length <= 6) return "***";
  return `${value.slice(0, 3)}...${value.slice(-3)}`;
}

export async function run(args: string[]) {
  const { positional, flags } = parseArgs(args, {
    mind: { type: "string" },
    reveal: { type: "boolean" },
  });

  const subcommand = positional[0];
  const client = getClient();

  switch (subcommand) {
    case "set": {
      const key = positional[1];
      if (!key) {
        console.error("Usage: volute env set <KEY> [<VALUE>] [--mind <name>]");
        process.exit(1);
      }
      const value = positional[2] ?? (await promptLine(`Enter value for ${key}: `));

      let res: Response;
      if (flags.mind) {
        res = await daemonFetch(
          urlOf(
            client.api.minds[":name"].env[":key"].$url({
              param: { name: flags.mind, key },
            }),
          ),
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ value }),
          },
        );
      } else {
        res = await daemonFetch(urlOf(client.api.env[":key"].$url({ param: { key } })), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ value }),
        });
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        console.error(body.error ?? `Failed to set ${key}`);
        process.exit(1);
      }
      const scope = flags.mind ? `mind:${flags.mind}` : "shared";
      console.log(`Set ${key} [${scope}]`);
      break;
    }

    case "get": {
      const key = positional[1];
      if (!key) {
        console.error("Usage: volute env get <KEY> [--mind <name>]");
        process.exit(1);
      }
      if (flags.mind) {
        const res = await daemonFetch(
          urlOf(
            client.api.minds[":name"].env[":key"].$url({
              param: { name: flags.mind, key },
            }),
          ),
        );
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          console.error(body.error ?? `${key} not set`);
          process.exit(1);
        }
        const data = (await res.json()) as { value: string };
        console.log(data.value);
      } else {
        const res = await daemonFetch(urlOf(client.api.env.$url()));
        if (!res.ok) {
          console.error(`Failed to read shared env`);
          process.exit(1);
        }
        const env = (await res.json()) as Record<string, string>;
        if (key in env) {
          console.log(env[key]);
        } else {
          console.error(`${key} not set`);
          process.exit(1);
        }
      }
      break;
    }

    case "list": {
      if (flags.mind) {
        const res = await daemonFetch(
          urlOf(client.api.minds[":name"].env.$url({ param: { name: flags.mind } })),
        );
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          console.error(body.error ?? "Failed to list env");
          process.exit(1);
        }
        const data = (await res.json()) as {
          shared: Record<string, string>;
          mind: Record<string, string>;
        };
        const allKeys = new Set([...Object.keys(data.shared), ...Object.keys(data.mind)]);
        if (allKeys.size === 0) {
          console.log("No environment variables set.");
          return;
        }
        for (const key of [...allKeys].sort()) {
          const scope = key in data.mind ? "mind" : "shared";
          const raw = key in data.mind ? data.mind[key] : data.shared[key];
          const value = flags.reveal ? raw : maskValue(raw);
          console.log(`${key}=${value} [${scope}]`);
        }
      } else {
        const res = await daemonFetch(urlOf(client.api.env.$url()));
        if (!res.ok) {
          console.error("Failed to list shared env");
          process.exit(1);
        }
        const env = (await res.json()) as Record<string, string>;
        const keys = Object.keys(env);
        if (keys.length === 0) {
          console.log("No shared environment variables set.");
          return;
        }
        for (const key of keys.sort()) {
          const value = flags.reveal ? env[key] : maskValue(env[key]);
          console.log(`${key}=${value} [shared]`);
        }
      }
      break;
    }

    case "remove": {
      const key = positional[1];
      if (!key) {
        console.error("Usage: volute env remove <KEY> [--mind <name>]");
        process.exit(1);
      }

      let res: Response;
      if (flags.mind) {
        res = await daemonFetch(
          urlOf(
            client.api.minds[":name"].env[":key"].$url({
              param: { name: flags.mind, key },
            }),
          ),
          { method: "DELETE" },
        );
      } else {
        res = await daemonFetch(urlOf(client.api.env[":key"].$url({ param: { key } })), {
          method: "DELETE",
        });
      }
      if (!res.ok) {
        const scope = flags.mind ? `mind:${flags.mind}` : "shared";
        console.error(`${key} not set in ${scope} scope`);
        process.exit(1);
      }
      const scope = flags.mind ? `mind:${flags.mind}` : "shared";
      console.log(`Removed ${key} [${scope}]`);
      break;
    }

    case "--help":
    case "-h":
    case undefined:
      console.log(`Usage: volute env <set|get|list|remove> [--mind <name>]`);
      break;
    default:
      console.error(`Usage: volute env <set|get|list|remove> [--mind <name>]`);
      console.error(`\nUnknown subcommand: ${subcommand}`);
      process.exit(1);
  }
}
