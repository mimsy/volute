import { daemonFetch } from "../lib/daemon-client.js";
import { parseArgs } from "../lib/parse-args.js";
import { resolveAgentName } from "../lib/resolve-agent-name.js";

export async function run(args: string[]) {
  const subcommand = args[0];

  switch (subcommand) {
    case "read":
      await readChannel(args.slice(1));
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
  volute channel list [<platform>] [--agent <name>]
  volute channel users <platform> [--agent <name>]
  volute channel create <platform> --participants user1,user2 [--name "..."] [--agent <name>]
  volute channel typing <channel-uri> [--agent <name>]`);
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
  const limit = flags.limit ?? 20;

  const res = await daemonFetch(
    `/api/agents/${encodeURIComponent(agentName)}/channels/read?platform=${encodeURIComponent(platform)}&uri=${encodeURIComponent(uri)}&limit=${limit}`,
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    console.error(body.error ?? `Server responded with ${res.status}`);
    process.exit(1);
  }
  const output = await res.text();
  console.log(output);
}

async function listChannels(args: string[]) {
  const { positional, flags } = parseArgs(args, {
    agent: { type: "string" },
  });

  const platform = positional[0];
  const agentName = resolveAgentName(flags);

  const url =
    `/api/agents/${encodeURIComponent(agentName)}/channels/list` +
    (platform ? `?platform=${encodeURIComponent(platform)}` : "");
  const res = await daemonFetch(url);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    console.error(body.error ?? `Server responded with ${res.status}`);
    process.exit(1);
  }

  const results = (await res.json()) as Record<
    string,
    { id: string; name: string; type: string; participantCount?: number; error?: string }[]
  >;
  for (const [p, convs] of Object.entries(results)) {
    for (const conv of convs) {
      if (conv.error) {
        console.error(`${p}: ${conv.error}`);
        continue;
      }
      const parts = [conv.id.padEnd(24), conv.name.padEnd(28), conv.type];
      if (conv.participantCount != null) {
        parts.push(String(conv.participantCount));
      }
      console.log(parts.join("  "));
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

  const agentName = resolveAgentName(flags);

  const res = await daemonFetch(
    `/api/agents/${encodeURIComponent(agentName)}/channels/users?platform=${encodeURIComponent(platform)}`,
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    console.error(body.error ?? `Server responded with ${res.status}`);
    process.exit(1);
  }

  const users = (await res.json()) as { username: string; id: string; type?: string }[];
  for (const user of users) {
    console.log(`${user.username.padEnd(20)}  ${user.id.padEnd(20)}  ${user.type ?? ""}`);
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

  const agentName = resolveAgentName(flags);
  const participants = flags.participants.split(",").map((s) => s.trim());

  const res = await daemonFetch(`/api/agents/${encodeURIComponent(agentName)}/channels/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ platform, participants, name: flags.name }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    console.error(body.error ?? `Server responded with ${res.status}`);
    process.exit(1);
  }
  const data = (await res.json()) as { slug: string };
  console.log(data.slug);
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
