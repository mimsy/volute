import { getClient, urlOf } from "../lib/api-client.js";
import { command, subcommands } from "../lib/command.js";
import { daemonFetch } from "../lib/daemon-client.js";
import { isCompact } from "../lib/format-cli.js";
import { promptLine } from "../lib/prompt.js";

function maskValue(value: string): string {
  if (value.length <= 6) return "***";
  return `${value.slice(0, 3)}...${value.slice(-3)}`;
}

const envSetCmd = command({
  name: "volute env set",
  description: "Set an environment variable",
  args: [
    { name: "key", required: true, description: "Variable name" },
    { name: "value", description: "Variable value (prompts if omitted)" },
  ],
  flags: {
    mind: { type: "string", description: "Mind name" },
  },
  run: async ({ args, flags }) => {
    const client = getClient();
    const key = args.key!;
    const value = args.value ?? (await promptLine(`Enter value for ${key}: `));

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
  },
});

const envGetCmd = command({
  name: "volute env get",
  description: "Get an environment variable value",
  args: [{ name: "key", required: true, description: "Variable name" }],
  flags: {
    mind: { type: "string", description: "Mind name" },
  },
  run: async ({ args, flags }) => {
    const client = getClient();
    const key = args.key!;
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
  },
});

const envListCmd = command({
  name: "volute env list",
  description: "List environment variables",
  args: [],
  flags: {
    mind: { type: "string", description: "Mind name" },
    reveal: { type: "boolean", description: "Show values unmasked" },
  },
  run: async ({ flags }) => {
    const client = getClient();
    const compact = isCompact();
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
        console.log(compact ? `${key}=${value}` : `${key}=${value} [${scope}]`);
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
        console.log(compact ? `${key}=${value}` : `${key}=${value} [shared]`);
      }
    }
  },
});

const envRemoveCmd = command({
  name: "volute env remove",
  description: "Remove an environment variable",
  args: [{ name: "key", required: true, description: "Variable name" }],
  flags: {
    mind: { type: "string", description: "Mind name" },
  },
  run: async ({ args, flags }) => {
    const client = getClient();
    const key = args.key!;

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
  },
});

const cmd = subcommands({
  name: "volute env",
  description: "Manage environment variables",
  commands: {
    set: {
      description: "Set an environment variable",
      run: envSetCmd.execute,
    },
    get: {
      description: "Get an environment variable",
      run: envGetCmd.execute,
    },
    list: {
      description: "List environment variables",
      run: envListCmd.execute,
    },
    remove: {
      description: "Remove an environment variable",
      run: envRemoveCmd.execute,
    },
  },
  footer: "Use --mind <name> or VOLUTE_MIND for mind-scoped variables.",
});

export const run = cmd.execute;
