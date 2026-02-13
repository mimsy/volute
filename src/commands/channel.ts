import { writeChannelEntry } from "../connectors/sdk.js";
import { CHANNELS, getChannelDriver } from "../lib/channels.js";
import { daemonFetch } from "../lib/daemon-client.js";
import { loadMergedEnv } from "../lib/env.js";
import { parseArgs } from "../lib/parse-args.js";
import { readStdin } from "../lib/read-stdin.js";
import { resolveAgent } from "../lib/registry.js";
import { resolveAgentName } from "../lib/resolve-agent-name.js";

export async function run(args: string[]) {
  const subcommand = args[0];

  switch (subcommand) {
    case "read":
      await readChannel(args.slice(1));
      break;
    case "send":
      await sendChannel(args.slice(1));
      break;
    case "list":
      await listChannels(args.slice(1));
      break;
    case "users":
      await listUsers(args.slice(1));
      break;
    case "create":
      await createChannel(args.slice(1));
      break;
    case "typing":
      await typingChannel(args.slice(1));
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
  volute channel read <channel-uri> [--limit N] [--agent <name>]
  volute channel send <channel-uri> "<message>" [--agent <name>]
  volute channel list [<platform>] [--agent <name>]
  volute channel users <platform> [--agent <name>]
  volute channel create <platform> --participants user1,user2 [--name "..."] [--agent <name>]
  volute channel typing <channel-uri> [--agent <name>]
  echo "message" | volute channel send <channel-uri> [--agent <name>]`);
}

async function readChannel(args: string[]) {
  const { positional, flags } = parseArgs(args, {
    agent: { type: "string" },
    limit: { type: "number" },
  });

  const uri = positional[0];
  if (!uri) {
    console.error("Usage: volute channel read <channel-uri> [--limit N] [--agent <name>]");
    process.exit(1);
  }

  const agentName = resolveAgentName(flags);
  const { platform } = parseUri(uri);
  const driver = requireDriver(platform);
  const { dir } = resolveAgent(agentName);
  const env = { ...loadMergedEnv(dir), VOLUTE_AGENT: agentName, VOLUTE_AGENT_DIR: dir };

  try {
    const limit = flags.limit ?? 20;
    const output = await driver.read(env, uri, limit);
    console.log(output);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

async function sendChannel(args: string[]) {
  const { positional, flags } = parseArgs(args, {
    agent: { type: "string" },
  });

  const uri = positional[0];
  const message = positional[1] ?? (await readStdin());
  if (!uri || !message) {
    console.error('Usage: volute channel send <channel-uri> "<message>" [--agent <name>]');
    console.error('       echo "message" | volute channel send <channel-uri> [--agent <name>]');
    process.exit(1);
  }

  const agentName = resolveAgentName(flags);
  const { platform } = parseUri(uri);
  const driver = requireDriver(platform);
  const { dir } = resolveAgent(agentName);
  const env = { ...loadMergedEnv(dir), VOLUTE_AGENT: agentName, VOLUTE_AGENT_DIR: dir };

  try {
    await driver.send(env, uri, message);

    // Persist outgoing message to agent_messages
    try {
      await daemonFetch(`/api/agents/${encodeURIComponent(agentName)}/history`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel: uri, content: message }),
      });
    } catch (err) {
      console.error(`Failed to persist to history: ${err instanceof Error ? err.message : err}`);
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

async function listChannels(args: string[]) {
  const { positional, flags } = parseArgs(args, {
    agent: { type: "string" },
  });

  const platform = positional[0];
  const agentName = resolveAgentName(flags);
  const { dir } = resolveAgent(agentName);
  const env = { ...loadMergedEnv(dir), VOLUTE_AGENT: agentName, VOLUTE_AGENT_DIR: dir };

  const platforms = platform ? [platform] : Object.keys(CHANNELS);

  for (const p of platforms) {
    const driver = getChannelDriver(p);
    if (!driver?.listConversations) continue;

    try {
      const convs = await driver.listConversations(env);
      for (const conv of convs) {
        // Populate channels.json with slug -> platformId mapping
        writeChannelEntry(dir, conv.id, {
          platformId: conv.platformId,
          platform: p,
          name: conv.name,
          type: conv.type,
        });

        const parts = [conv.id.padEnd(24), conv.name.padEnd(28), conv.type];
        if (conv.participantCount != null) {
          parts.push(String(conv.participantCount));
        }
        console.log(parts.join("  "));
      }
    } catch (err) {
      console.error(`${p}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

async function listUsers(args: string[]) {
  const { positional, flags } = parseArgs(args, {
    agent: { type: "string" },
  });

  const platform = positional[0];
  if (!platform) {
    console.error("Usage: volute channel users <platform> [--agent <name>]");
    process.exit(1);
  }

  const driver = requireDriver(platform);
  if (!driver.listUsers) {
    console.error(`Platform ${platform} does not support listing users`);
    process.exit(1);
  }

  const agentName = resolveAgentName(flags);
  const { dir } = resolveAgent(agentName);
  const env = { ...loadMergedEnv(dir), VOLUTE_AGENT: agentName, VOLUTE_AGENT_DIR: dir };

  try {
    const users = await driver.listUsers(env);
    for (const user of users) {
      console.log(`${user.username.padEnd(20)}  ${user.id.padEnd(20)}  ${user.type ?? ""}`);
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

async function createChannel(args: string[]) {
  const { positional, flags } = parseArgs(args, {
    agent: { type: "string" },
    participants: { type: "string" },
    name: { type: "string" },
  });

  const platform = positional[0];
  if (!platform || !flags.participants) {
    console.error(
      'Usage: volute channel create <platform> --participants user1,user2 [--name "..."] [--agent <name>]',
    );
    process.exit(1);
  }

  const driver = requireDriver(platform);
  if (!driver.createConversation) {
    console.error(`Platform ${platform} does not support creating conversations`);
    process.exit(1);
  }

  const agentName = resolveAgentName(flags);
  const { dir } = resolveAgent(agentName);
  const env = { ...loadMergedEnv(dir), VOLUTE_AGENT: agentName, VOLUTE_AGENT_DIR: dir };
  const participants = flags.participants.split(",").map((s) => s.trim());

  try {
    const slug = await driver.createConversation(env, participants, flags.name);
    console.log(slug);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

async function typingChannel(args: string[]) {
  const { positional, flags } = parseArgs(args, {
    agent: { type: "string" },
  });

  const uri = positional[0];
  if (!uri) {
    console.error("Usage: volute channel typing <channel-uri> [--agent <name>]");
    process.exit(1);
  }

  const agentName = resolveAgentName(flags);

  try {
    const res = await daemonFetch(
      `/api/agents/${encodeURIComponent(agentName)}/typing?channel=${encodeURIComponent(uri)}`,
    );
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      console.error(body.error ?? `Server responded with ${res.status}`);
      process.exit(1);
    }
    const data = (await res.json()) as { typing: string[] };
    if (data.typing.length > 0) {
      console.log(data.typing.join(", "));
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

function parseUri(uri: string): { platform: string; channelId: string } {
  const colonIdx = uri.indexOf(":");
  if (colonIdx === -1) {
    console.error(`Invalid channel URI: ${uri} (expected format: platform:id)`);
    process.exit(1);
  }
  return { platform: uri.slice(0, colonIdx), channelId: uri.slice(colonIdx + 1) };
}

function requireDriver(platform: string) {
  const driver = getChannelDriver(platform);
  if (!driver) {
    console.error(`No channel driver for platform: ${platform}`);
    process.exit(1);
  }
  return driver;
}
