import { parseArgs } from "../lib/parse-args.js";
import { resolveAgent } from "../lib/registry.js";
import {
  readEnv,
  writeEnv,
  sharedEnvPath,
  agentEnvPath,
  loadMergedEnv,
} from "../lib/env.js";

function getEnvPath(agentName: string | undefined): string {
  if (agentName) {
    const { dir } = resolveAgent(agentName);
    return agentEnvPath(dir);
  }
  return sharedEnvPath();
}

async function promptValue(key: string): Promise<string> {
  process.stderr.write(`Enter value for ${key}: `);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);

  return new Promise((resolve) => {
    let value = "";
    const onData = (buf: Buffer) => {
      for (const byte of buf) {
        if (byte === 3) { // Ctrl-C
          process.stderr.write("\n");
          process.exit(1);
        }
        if (byte === 13 || byte === 10) { // Enter
          process.stderr.write("\n");
          if (process.stdin.isTTY) process.stdin.setRawMode(false);
          process.stdin.removeListener("data", onData);
          process.stdin.pause();
          resolve(value);
          return;
        }
        if (byte === 127 || byte === 8) { // Backspace
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

export async function run(args: string[]) {
  const { positional, flags } = parseArgs(args, {
    agent: { type: "string" },
  });

  const subcommand = positional[0];

  switch (subcommand) {
    case "set": {
      const key = positional[1];
      if (!key) {
        console.error("Usage: molt env set <KEY> [<VALUE>] [--agent <name>]");
        process.exit(1);
      }
      const value = positional[2] ?? (await promptValue(key));
      const path = getEnvPath(flags.agent);
      const env = readEnv(path);
      env[key] = value;
      writeEnv(path, env);
      const scope = flags.agent ? `agent:${flags.agent}` : "shared";
      console.log(`Set ${key} [${scope}]`);
      break;
    }

    case "get": {
      const key = positional[1];
      if (!key) {
        console.error("Usage: molt env get <KEY> [--agent <name>]");
        process.exit(1);
      }
      if (flags.agent) {
        const { dir } = resolveAgent(flags.agent);
        const merged = loadMergedEnv(dir);
        if (key in merged) {
          console.log(merged[key]);
        } else {
          console.error(`${key} not set`);
          process.exit(1);
        }
      } else {
        const env = readEnv(sharedEnvPath());
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
      if (flags.agent) {
        const { dir } = resolveAgent(flags.agent);
        const shared = readEnv(sharedEnvPath());
        const agent = readEnv(agentEnvPath(dir));
        const allKeys = new Set([
          ...Object.keys(shared),
          ...Object.keys(agent),
        ]);
        if (allKeys.size === 0) {
          console.log("No environment variables set.");
          return;
        }
        for (const key of [...allKeys].sort()) {
          const scope = key in agent ? "agent" : "shared";
          const value = key in agent ? agent[key] : shared[key];
          console.log(`${key}=${value} [${scope}]`);
        }
      } else {
        const env = readEnv(sharedEnvPath());
        const keys = Object.keys(env);
        if (keys.length === 0) {
          console.log("No shared environment variables set.");
          return;
        }
        for (const key of keys.sort()) {
          console.log(`${key}=${env[key]} [shared]`);
        }
      }
      break;
    }

    case "remove": {
      const key = positional[1];
      if (!key) {
        console.error(
          "Usage: molt env remove <KEY> [--agent <name>]",
        );
        process.exit(1);
      }
      const path = getEnvPath(flags.agent);
      const env = readEnv(path);
      if (!(key in env)) {
        const scope = flags.agent ? `agent:${flags.agent}` : "shared";
        console.error(`${key} not set in ${scope} scope`);
        process.exit(1);
      }
      delete env[key];
      writeEnv(path, env);
      const scope = flags.agent ? `agent:${flags.agent}` : "shared";
      console.log(`Removed ${key} [${scope}]`);
      break;
    }

    default:
      console.error(`Usage: molt env <set|get|list|remove> [--agent <name>]`);
      if (subcommand) {
        console.error(`\nUnknown subcommand: ${subcommand}`);
      }
      process.exit(1);
  }
}
